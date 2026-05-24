import type { AgentActivityEvent, AgentTaskSummaryEvent, Profile } from '@autopod/shared';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, insertTestProfile } from '../test-utils/mock-helpers.js';
import { createEscalationRepository } from './escalation-repository.js';
import { createEventBus } from './event-bus.js';
import { createEventRepository } from './event-repository.js';
import { createMemoryCandidateRepository } from './memory-candidate-repository.js';
import { createMemoryCandidateRecorder } from './memory-candidate-recorder.js';
import { createMemoryRepository } from './memory-repository.js';
import type { NewPod } from './pod-repository.js';
import { createPodRepository } from './pod-repository.js';
import { createValidationRepository } from './validation-repository.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../providers/llm-client.js', () => ({
  createProfileAnthropicClient: vi.fn(),
}));

import { createProfileAnthropicClient } from '../providers/llm-client.js';

const CANDIDATE_JSON = JSON.stringify({
  create: true,
  path: '/gotchas/build-before-test.md',
  content: 'Always build before running tests. Test failures from stale artefacts waste hours.',
  rationale: 'Future pods hitting this waste time on confusing test failures.',
  kind: 'gotcha',
  tags: ['testing', 'build'],
  appliesWhen: 'Before running tests',
  avoidWhen: null,
  confidence: 0.75,
  impactSummary: 'Prevents confusing stale-artefact test failures.',
  updateTargetPath: null,
});

function makeMockAnthropicClient(responseText = CANDIDATE_JSON) {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: responseText }],
      }),
    },
  };
}

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    name: 'test-profile',
    repoUrl: 'https://github.com/org/repo',
    defaultBranch: 'main',
    template: 'node22',
    buildCommand: 'npm run build',
    startCommand: 'npm start',
    healthPath: '/health',
    healthTimeout: 120,
    smokePages: [],
    maxValidationAttempts: 3,
    defaultModel: 'claude-haiku-4-5',
    reviewerModel: null,
    defaultRuntime: 'claude',
    executionTarget: null,
    hasWebUi: false,
    podOptions: null,
    networkPolicy: null,
    actions: null,
    mcpServers: [],
    claudeMdSections: [],
    skills: [],
    githubPat: null,
    adoPat: null,
    prProvider: 'github',
    autoMerge: false,
    referenceRepo: null,
    privateRegistries: [],
    containerMemoryGb: null,
    containerCpus: null,
    maxPrFixAttempts: 3,
    extends: null,
    modelProvider: null,
    providerCredentials: null,
    warmImageTag: null,
    warmImageBuiltAt: null,
    pimConfig: null,
    issueWatcherConfig: null,
    escalationConfig: null,
    ...overrides,
  } as unknown as Profile;
}

const logger = pino({ level: 'silent' });

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

const POD_ID = 'pod-rec-test-01';

function basePod(overrides: Partial<NewPod> = {}): NewPod {
  return {
    id: POD_ID,
    profileName: 'test-profile',
    task: 'implement feature',
    status: 'complete',
    model: 'claude-haiku-4-5',
    runtime: 'claude',
    executionTarget: 'local',
    branch: 'autopod/test',
    userId: 'user-1',
    maxValidationAttempts: 3,
    skipValidation: false,
    outputMode: 'pr',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MemoryCandidateRecorder', () => {
  let db: ReturnType<typeof createTestDb>;
  let podRepo: ReturnType<typeof createPodRepository>;
  let eventRepo: ReturnType<typeof createEventRepository>;
  let escalationRepo: ReturnType<typeof createEscalationRepository>;
  let candidateRepo: ReturnType<typeof createMemoryCandidateRepository>;
  let memoryRepo: ReturnType<typeof createMemoryRepository>;
  let validationRepo: ReturnType<typeof createValidationRepository>;
  let eventBus: ReturnType<typeof createEventBus>;
  let mockProfileStore: { get: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    db = createTestDb();
    insertTestProfile(db);

    podRepo = createPodRepository(db);
    eventRepo = createEventRepository(db);
    escalationRepo = createEscalationRepository(db);
    candidateRepo = createMemoryCandidateRepository(db);
    memoryRepo = createMemoryRepository(db);
    validationRepo = createValidationRepository(db);
    eventBus = createEventBus(eventRepo, logger);

    mockProfileStore = { get: vi.fn().mockReturnValue(makeProfile()) };

    vi.mocked(createProfileAnthropicClient).mockResolvedValue({
      ok: true,
      client: makeMockAnthropicClient() as unknown as import('@anthropic-ai/sdk').default,
      model: 'claude-haiku-4-5-20251001',
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // Helper: await all pending micro-tasks so async extraction completes
  async function flushAsync(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }

  function makeRecorder() {
    return createMemoryCandidateRecorder({
      eventBus,
      podRepo,
      profileStore: mockProfileStore as never,
      candidateRepo,
      memoryRepo,
      eventRepo,
      escalationRepo,
      validationRepo,
      logger,
    });
  }

  it('creates a candidate on pod.completed for an agentMode:auto pod', async () => {
    podRepo.insert(basePod({ status: 'complete' }));
    // Make lesson potential high enough
    podRepo.update(POD_ID, { prFixAttempts: 2 });

    const recorder = makeRecorder();
    recorder.start();

    eventBus.emit({
      type: 'pod.completed',
      timestamp: new Date().toISOString(),
      podId: POD_ID,
      finalStatus: 'complete',
      summary: { id: POD_ID, profileName: 'test-profile' } as never,
    });

    await flushAsync();
    recorder.stop();

    const candidates = candidateRepo.list('test-profile');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.createdByPodId).toBe(POD_ID);
    expect(candidates[0]?.path).toBe('/gotchas/build-before-test.md');
    expect(candidates[0]?.status).toBe('pending');
  });

  it('creates a candidate on pod.status_changed to failed', async () => {
    podRepo.insert(basePod({ status: 'failed' }));
    podRepo.update(POD_ID, { prFixAttempts: 1 });

    const recorder = makeRecorder();
    recorder.start();

    eventBus.emit({
      type: 'pod.status_changed',
      timestamp: new Date().toISOString(),
      podId: POD_ID,
      previousStatus: 'running',
      newStatus: 'failed',
    });

    await flushAsync();
    recorder.stop();

    const candidates = candidateRepo.list('test-profile');
    expect(candidates).toHaveLength(1);
  });

  it('creates a candidate on pod.status_changed to review_required', async () => {
    podRepo.insert(basePod({ status: 'review_required' }));
    podRepo.update(POD_ID, { prFixAttempts: 1 });

    const recorder = makeRecorder();
    recorder.start();

    eventBus.emit({
      type: 'pod.status_changed',
      timestamp: new Date().toISOString(),
      podId: POD_ID,
      previousStatus: 'validating',
      newStatus: 'review_required',
    });

    await flushAsync();
    recorder.stop();

    const candidates = candidateRepo.list('test-profile');
    expect(candidates).toHaveLength(1);
  });

  it('ignores pod.status_changed to non-extraction statuses', async () => {
    podRepo.insert(basePod({ status: 'running' }));

    const recorder = makeRecorder();
    recorder.start();

    eventBus.emit({
      type: 'pod.status_changed',
      timestamp: new Date().toISOString(),
      podId: POD_ID,
      previousStatus: 'queued',
      newStatus: 'running',
    });

    await flushAsync();
    recorder.stop();

    expect(candidateRepo.list('test-profile')).toHaveLength(0);
  });

  it('skips agentMode:interactive pods', async () => {
    podRepo.insert(basePod({ outputMode: 'workspace' }));
    // outputMode:workspace maps to agentMode:interactive in pod-repository
    // Force the options by directly inserting with the right output_mode
    podRepo.update(POD_ID, { prFixAttempts: 2 });

    // Verify the pod's agentMode is interactive
    const pod = podRepo.getOrThrow(POD_ID);
    if (pod.options.agentMode === 'auto') {
      // skip this test — the pod was already auto (shouldn't happen)
      return;
    }

    const recorder = makeRecorder();
    recorder.start();

    eventBus.emit({
      type: 'pod.completed',
      timestamp: new Date().toISOString(),
      podId: POD_ID,
      finalStatus: 'complete',
      summary: { id: POD_ID, profileName: 'test-profile' } as never,
    });

    await flushAsync();
    recorder.stop();

    expect(candidateRepo.list('test-profile')).toHaveLength(0);
  });

  it('is idempotent: does not process the same pod twice from repeated events', async () => {
    podRepo.insert(basePod({ status: 'complete' }));
    podRepo.update(POD_ID, { prFixAttempts: 2 });

    const recorder = makeRecorder();
    recorder.start();

    const completedEvent = {
      type: 'pod.completed' as const,
      timestamp: new Date().toISOString(),
      podId: POD_ID,
      finalStatus: 'complete' as const,
      summary: { id: POD_ID, profileName: 'test-profile' } as never,
    };

    eventBus.emit(completedEvent);
    eventBus.emit(completedEvent);

    await flushAsync();
    recorder.stop();

    // Should only create one candidate despite two events
    expect(candidateRepo.list('test-profile')).toHaveLength(1);
  });

  it('skips when DB already has a candidate for the pod (restart idempotency)', async () => {
    podRepo.insert(basePod({ status: 'complete' }));
    podRepo.update(POD_ID, { prFixAttempts: 2 });

    // Pre-populate a candidate as if a previous daemon run already processed it
    candidateRepo.insert({
      id: 'pre-existing-cand',
      action: 'create',
      targetMemoryId: null,
      scope: 'profile',
      scopeId: 'test-profile',
      path: '/gotchas/prior.md',
      content: 'Prior lesson',
      rationale: 'Prior rationale',
      kind: 'gotcha',
      tags: [],
      appliesWhen: null,
      avoidWhen: null,
      confidence: 0.7,
      sourceEvidence: [],
      impactSummary: 'Prior impact',
      createdByPodId: POD_ID,
      fallbackReason: null,
    });

    const recorder = makeRecorder();
    recorder.start();

    eventBus.emit({
      type: 'pod.completed',
      timestamp: new Date().toISOString(),
      podId: POD_ID,
      finalStatus: 'complete',
      summary: { id: POD_ID, profileName: 'test-profile' } as never,
    });

    await flushAsync();
    recorder.stop();

    // Should still be exactly 1 candidate (no new one created)
    expect(candidateRepo.list('test-profile')).toHaveLength(1);
  });

  it('skips when lesson potential is below threshold (ordinary green pod)', async () => {
    // No prFixAttempts, no validation failures, green pod
    podRepo.insert(basePod({ status: 'complete' }));

    const recorder = makeRecorder();
    recorder.start();

    eventBus.emit({
      type: 'pod.completed',
      timestamp: new Date().toISOString(),
      podId: POD_ID,
      finalStatus: 'complete',
      summary: { id: POD_ID, profileName: 'test-profile' } as never,
    });

    await flushAsync();
    recorder.stop();

    expect(candidateRepo.list('test-profile')).toHaveLength(0);
  });

  it('records no candidate when reviewer model returns create:false', async () => {
    vi.mocked(createProfileAnthropicClient).mockResolvedValue({
      ok: true,
      client: makeMockAnthropicClient(JSON.stringify({ create: false })) as unknown as import('@anthropic-ai/sdk').default,
      model: 'claude-haiku-4-5-20251001',
    });

    podRepo.insert(basePod({ status: 'complete' }));
    podRepo.update(POD_ID, { prFixAttempts: 2 });

    const recorder = makeRecorder();
    recorder.start();

    eventBus.emit({
      type: 'pod.completed',
      timestamp: new Date().toISOString(),
      podId: POD_ID,
      finalStatus: 'complete',
      summary: { id: POD_ID, profileName: 'test-profile' } as never,
    });

    await flushAsync();
    recorder.stop();

    expect(candidateRepo.list('test-profile')).toHaveLength(0);
  });

  it('logs warning but does not throw when reviewer model is unavailable', async () => {
    vi.mocked(createProfileAnthropicClient).mockResolvedValue({
      ok: false,
      reason: 'no_anthropic_api_key',
    });

    podRepo.insert(basePod({ status: 'complete' }));
    podRepo.update(POD_ID, { prFixAttempts: 2 });

    const recorder = makeRecorder();
    recorder.start();

    eventBus.emit({
      type: 'pod.completed',
      timestamp: new Date().toISOString(),
      podId: POD_ID,
      finalStatus: 'complete',
      summary: { id: POD_ID, profileName: 'test-profile' } as never,
    });

    // Should not throw — fire and forget
    await flushAsync();
    recorder.stop();

    expect(candidateRepo.list('test-profile')).toHaveLength(0);
  });

  it('extracts task summary and blockers from events for evidence', async () => {
    podRepo.insert(basePod({ status: 'complete' }));
    podRepo.update(POD_ID, { prFixAttempts: 1 });

    // Insert a task_summary event
    const taskSummaryEvent: AgentTaskSummaryEvent = {
      type: 'task_summary',
      timestamp: new Date().toISOString(),
      actualSummary: 'Implemented the migration runner using SQL scripts',
      how: 'Used a directory scanner to load and apply .sql files in order',
      deviations: [],
    };
    const agentActivity: AgentActivityEvent = {
      type: 'pod.agent_activity',
      timestamp: new Date().toISOString(),
      podId: POD_ID,
      event: taskSummaryEvent,
    };
    eventRepo.insert(agentActivity);

    const mockClient = makeMockAnthropicClient();
    vi.mocked(createProfileAnthropicClient).mockResolvedValue({
      ok: true,
      client: mockClient as never,
      model: 'claude-haiku-4-5-20251001',
    });

    const recorder = makeRecorder();
    recorder.start();

    eventBus.emit({
      type: 'pod.completed',
      timestamp: new Date().toISOString(),
      podId: POD_ID,
      finalStatus: 'complete',
      summary: { id: POD_ID, profileName: 'test-profile' } as never,
    });

    await flushAsync();
    recorder.stop();

    // Verify the LLM was called with user content that includes the task summary
    const createCalls = mockClient.messages.create.mock.calls;
    expect(createCalls.length).toBe(1);
    const userContent = createCalls[0]?.[0]?.messages?.[0]?.content as string;
    expect(userContent).toContain('Implemented the migration runner');
  });

  it('emits memory.candidate_created event on successful extraction', async () => {
    podRepo.insert(basePod({ status: 'complete' }));
    podRepo.update(POD_ID, { prFixAttempts: 2 });

    const emittedEvents: { type: string }[] = [];
    eventBus.subscribe((e) => emittedEvents.push(e));

    const recorder = makeRecorder();
    recorder.start();

    eventBus.emit({
      type: 'pod.completed',
      timestamp: new Date().toISOString(),
      podId: POD_ID,
      finalStatus: 'complete',
      summary: { id: POD_ID, profileName: 'test-profile' } as never,
    });

    await flushAsync();
    recorder.stop();

    const candidateEvent = emittedEvents.find((e) => e.type === 'memory.candidate_created');
    expect(candidateEvent).toBeDefined();
  });

  it('stop() unsubscribes and no longer processes events', async () => {
    podRepo.insert(basePod({ status: 'complete' }));
    podRepo.update(POD_ID, { prFixAttempts: 2 });

    const recorder = makeRecorder();
    recorder.start();
    recorder.stop();

    eventBus.emit({
      type: 'pod.completed',
      timestamp: new Date().toISOString(),
      podId: POD_ID,
      finalStatus: 'complete',
      summary: { id: POD_ID, profileName: 'test-profile' } as never,
    });

    await flushAsync();

    expect(candidateRepo.list('test-profile')).toHaveLength(0);
  });

  it('handles killed pods the same as complete', async () => {
    podRepo.insert(basePod({ status: 'killed' }));
    podRepo.update(POD_ID, { prFixAttempts: 1 });

    const recorder = makeRecorder();
    recorder.start();

    eventBus.emit({
      type: 'pod.completed',
      timestamp: new Date().toISOString(),
      podId: POD_ID,
      finalStatus: 'killed',
      summary: { id: POD_ID, profileName: 'test-profile' } as never,
    });

    await flushAsync();
    recorder.stop();

    expect(candidateRepo.list('test-profile')).toHaveLength(1);
  });
});
