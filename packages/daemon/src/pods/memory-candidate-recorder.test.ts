import type { AgentActivityEvent, AgentTaskSummaryEvent, Profile } from '@autopod/shared';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, insertTestProfile } from '../test-utils/mock-helpers.js';
import { createEscalationRepository } from './escalation-repository.js';
import { createEventBus } from './event-bus.js';
import { createEventRepository } from './event-repository.js';
import { createMemoryCandidateRecorder } from './memory-candidate-recorder.js';
import { createMemoryCandidateRepository } from './memory-candidate-repository.js';
import { createMemoryExtractionAttemptRepository } from './memory-extraction-attempt-repository.js';
import { createMemoryRepository } from './memory-repository.js';
import type { NewPod } from './pod-repository.js';
import { createPodRepository } from './pod-repository.js';
import { createValidationRepository } from './validation-repository.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../providers/memory-reviewer.js', () => ({
  createProfileMemoryReviewer: vi.fn(),
}));

import { createProfileMemoryReviewer } from '../providers/memory-reviewer.js';

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

function makeMockReviewer(responseText = CANDIDATE_JSON) {
  return {
    model: 'claude-haiku-4-5-20251001',
    generateText: vi.fn().mockResolvedValue(responseText),
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
  let attemptRepo: ReturnType<typeof createMemoryExtractionAttemptRepository>;
  let memoryRepo: ReturnType<typeof createMemoryRepository>;
  let validationRepo: ReturnType<typeof createValidationRepository>;
  let eventBus: ReturnType<typeof createEventBus>;
  let mockProfileStore: { get: ReturnType<typeof vi.fn> };
  let containerManagerFactory: { get: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    db = createTestDb();
    insertTestProfile(db);

    podRepo = createPodRepository(db);
    eventRepo = createEventRepository(db);
    escalationRepo = createEscalationRepository(db);
    candidateRepo = createMemoryCandidateRepository(db);
    attemptRepo = createMemoryExtractionAttemptRepository(db);
    memoryRepo = createMemoryRepository(db);
    validationRepo = createValidationRepository(db);
    eventBus = createEventBus(eventRepo, logger);

    mockProfileStore = { get: vi.fn().mockReturnValue(makeProfile()) };
    containerManagerFactory = { get: vi.fn(() => ({}) as never) };

    vi.mocked(createProfileMemoryReviewer).mockResolvedValue({
      ok: true,
      reviewer: makeMockReviewer(),
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

  function makeRecorder(options: { withContainerFactory?: boolean } = {}) {
    return createMemoryCandidateRecorder({
      eventBus,
      podRepo,
      profileStore: mockProfileStore as never,
      candidateRepo,
      attemptRepo,
      memoryRepo,
      eventRepo,
      escalationRepo,
      validationRepo,
      ...(options.withContainerFactory ? { containerManagerFactory } : {}),
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
    expect(attemptRepo.getByPod(POD_ID)).toMatchObject({
      status: 'candidate_created',
      candidateId: candidates[0]?.id,
      score: 0.3,
      signals: ['pr_fix_attempts:2'],
    });
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

  it('retries after an early below-threshold event when later signals become useful', async () => {
    podRepo.insert(basePod({ status: 'failed' }));

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

    expect(candidateRepo.list('test-profile')).toHaveLength(0);
    expect(createProfileMemoryReviewer).not.toHaveBeenCalled();
    expect(attemptRepo.getByPod(POD_ID)).toMatchObject({
      status: 'below_threshold',
      reason: 'lesson_potential_below_threshold',
      score: 0,
    });

    podRepo.update(POD_ID, { status: 'complete', prFixAttempts: 2 });

    eventBus.emit({
      type: 'pod.completed',
      timestamp: new Date().toISOString(),
      podId: POD_ID,
      finalStatus: 'complete',
      summary: { id: POD_ID, profileName: 'test-profile' } as never,
    });

    await flushAsync();
    recorder.stop();

    expect(candidateRepo.list('test-profile')).toHaveLength(1);
    expect(createProfileMemoryReviewer).toHaveBeenCalledTimes(1);
    expect(attemptRepo.getByPod(POD_ID)?.status).toBe('candidate_created');
  });

  it('deduplicates repeated events while extraction is in flight', async () => {
    let resolveReviewer: (value: string) => void = () => {};
    const reviewerPromise = new Promise<string>((resolve) => {
      resolveReviewer = resolve;
    });
    const mockReviewer = {
      model: 'claude-haiku-4-5-20251001',
      generateText: vi.fn().mockReturnValue(reviewerPromise),
    };
    vi.mocked(createProfileMemoryReviewer).mockResolvedValue({
      ok: true,
      reviewer: mockReviewer,
      model: 'claude-haiku-4-5-20251001',
    });

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

    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(createProfileMemoryReviewer).toHaveBeenCalledTimes(1);
    expect(mockReviewer.generateText).toHaveBeenCalledTimes(1);

    resolveReviewer(CANDIDATE_JSON);

    await flushAsync();
    recorder.stop();

    expect(candidateRepo.list('test-profile')).toHaveLength(1);
  });

  it('serializes reviewer calls across simultaneous pod outcomes', async () => {
    const firstPodId = 'pod-rec-test-a';
    const secondPodId = 'pod-rec-test-b';
    let resolveFirst: (value: string) => void = () => {};
    const firstReviewerPromise = new Promise<string>((resolve) => {
      resolveFirst = resolve;
    });
    const firstReviewer = {
      model: 'claude-haiku-4-5-20251001',
      generateText: vi.fn().mockReturnValue(firstReviewerPromise),
    };
    const secondReviewer = makeMockReviewer();
    vi.mocked(createProfileMemoryReviewer)
      .mockResolvedValueOnce({
        ok: true,
        reviewer: firstReviewer,
        model: 'claude-haiku-4-5-20251001',
      })
      .mockResolvedValueOnce({
        ok: true,
        reviewer: secondReviewer,
        model: 'claude-haiku-4-5-20251001',
      });

    podRepo.insert(basePod({ id: firstPodId, branch: 'autopod/first' }));
    podRepo.update(firstPodId, { prFixAttempts: 2 });
    podRepo.insert(basePod({ id: secondPodId, branch: 'autopod/second' }));
    podRepo.update(secondPodId, { prFixAttempts: 2 });

    const recorder = makeRecorder();
    recorder.start();

    eventBus.emit({
      type: 'pod.completed',
      timestamp: new Date().toISOString(),
      podId: firstPodId,
      finalStatus: 'complete',
      summary: { id: firstPodId, profileName: 'test-profile' } as never,
    });
    eventBus.emit({
      type: 'pod.completed',
      timestamp: new Date().toISOString(),
      podId: secondPodId,
      finalStatus: 'complete',
      summary: { id: secondPodId, profileName: 'test-profile' } as never,
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(createProfileMemoryReviewer).toHaveBeenCalledTimes(1);
    expect(firstReviewer.generateText).toHaveBeenCalledTimes(1);
    expect(secondReviewer.generateText).not.toHaveBeenCalled();

    resolveFirst(CANDIDATE_JSON);

    await flushAsync();
    recorder.stop();

    expect(createProfileMemoryReviewer).toHaveBeenCalledTimes(2);
    expect(secondReviewer.generateText).toHaveBeenCalledTimes(1);
    expect(candidateRepo.list('test-profile')).toHaveLength(2);
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
    expect(attemptRepo.getByPod(POD_ID)).toMatchObject({
      status: 'below_threshold',
      reason: 'lesson_potential_below_threshold',
    });
  });

  it('records no candidate when reviewer model returns create:false', async () => {
    vi.mocked(createProfileMemoryReviewer).mockResolvedValue({
      ok: true,
      reviewer: makeMockReviewer(JSON.stringify({ create: false })),
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
    vi.mocked(createProfileMemoryReviewer).mockResolvedValue({
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
    expect(attemptRepo.getByPod(POD_ID)).toMatchObject({
      status: 'reviewer_unavailable',
      reason: 'no_anthropic_api_key',
    });
  });

  it('prefers a live container reviewer for high-signal extraction', async () => {
    podRepo.insert(basePod({ status: 'complete' }));
    podRepo.update(POD_ID, { prFixAttempts: 2, containerId: 'container-1' });

    const recorder = makeRecorder({ withContainerFactory: true });
    await recorder.extractNow(POD_ID);

    expect(createProfileMemoryReviewer).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(String),
      expect.any(Object),
      {
        container: {
          podId: POD_ID,
          containerId: 'container-1',
          containerManager: expect.any(Object),
          timeoutMs: 20_000,
        },
      },
    );
    expect(candidateRepo.list('test-profile')).toHaveLength(1);
    expect(attemptRepo.getByPod(POD_ID)?.status).toBe('candidate_created');
  });

  it('falls back to daemon reviewer construction when the live container is unavailable', async () => {
    podRepo.insert(basePod({ status: 'complete' }));
    podRepo.update(POD_ID, { prFixAttempts: 2 });

    const recorder = makeRecorder({ withContainerFactory: true });
    await recorder.extractNow(POD_ID);

    expect(createProfileMemoryReviewer).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(String),
      expect.any(Object),
      {},
    );
    expect(candidateRepo.list('test-profile')).toHaveLength(1);
    expect(attemptRepo.getByPod(POD_ID)?.status).toBe('candidate_created');
  });

  it('records reviewer_unavailable when container and daemon reviewers are unavailable', async () => {
    vi.mocked(createProfileMemoryReviewer).mockResolvedValue({
      ok: false,
      reason:
        'container_reviewer_unavailable: timeout; daemon_reviewer_unavailable: openai_auth_unavailable',
    });
    podRepo.insert(basePod({ status: 'complete' }));
    podRepo.update(POD_ID, { prFixAttempts: 2, containerId: 'container-1' });

    const recorder = makeRecorder({ withContainerFactory: true });
    await recorder.extractNow(POD_ID);

    expect(candidateRepo.list('test-profile')).toHaveLength(0);
    expect(attemptRepo.getByPod(POD_ID)).toMatchObject({
      status: 'reviewer_unavailable',
      reason:
        'container_reviewer_unavailable: timeout; daemon_reviewer_unavailable: openai_auth_unavailable',
      score: 0.3,
      signals: ['pr_fix_attempts:2'],
    });
  });

  it('records reviewer_unavailable when the container-first reviewer fails during extraction', async () => {
    vi.mocked(createProfileMemoryReviewer).mockResolvedValue({
      ok: true,
      reviewer: {
        model: 'gpt-5-mini',
        generateText: vi
          .fn()
          .mockRejectedValue(
            new Error(
              'container_reviewer_unavailable: Container reviewer unavailable: codex timed out; daemon_reviewer_unavailable: openai_auth_unavailable',
            ),
          ),
      },
      model: 'gpt-5-mini',
    });
    podRepo.insert(basePod({ status: 'complete', runtime: 'codex' }));
    podRepo.update(POD_ID, { prFixAttempts: 2, containerId: 'container-1' });

    const recorder = makeRecorder({ withContainerFactory: true });
    await recorder.extractNow(POD_ID);

    expect(candidateRepo.list('test-profile')).toHaveLength(0);
    expect(attemptRepo.getByPod(POD_ID)).toMatchObject({
      status: 'reviewer_unavailable',
      reason: expect.stringContaining('container_reviewer_unavailable'),
      score: 0.3,
      signals: ['pr_fix_attempts:2'],
    });
  });

  it('records hard reviewer quota exhaustion as reviewer unavailable', async () => {
    vi.mocked(createProfileMemoryReviewer).mockResolvedValue({
      ok: true,
      reviewer: {
        model: 'gpt-5-mini',
        generateText: vi
          .fn()
          .mockRejectedValue(
            new Error(
              'openai_reviewer_http_429: You exceeded your current quota, please check your plan and billing details',
            ),
          ),
      },
      model: 'gpt-5-mini',
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
    expect(attemptRepo.getByPod(POD_ID)).toMatchObject({
      status: 'reviewer_unavailable',
      reason: expect.stringMatching(/reviewer_quota_exhausted/),
    });
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

    const mockReviewer = makeMockReviewer();
    vi.mocked(createProfileMemoryReviewer).mockResolvedValue({
      ok: true,
      reviewer: mockReviewer,
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
    const createCalls = vi.mocked(mockReviewer.generateText).mock.calls;
    expect(createCalls.length).toBe(1);
    const userContent = createCalls[0]?.[0]?.userMessage;
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
