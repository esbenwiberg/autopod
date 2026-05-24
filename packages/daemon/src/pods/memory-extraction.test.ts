import type { MemoryEntry, Pod, QualitySignals } from '@autopod/shared';
import type Anthropic from '@anthropic-ai/sdk';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import {
  LESSON_POTENTIAL_THRESHOLD,
  computeLessonPotential,
  extractCandidate,
} from './memory-extraction.js';

const logger = pino({ level: 'silent' });

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePod(overrides: Partial<Pod> = {}): Pod {
  return {
    id: 'pod-abc1',
    profileName: 'my-profile',
    task: 'Implement feature X',
    status: 'complete',
    model: 'claude-haiku-4-5',
    runtime: 'claude',
    executionTarget: 'docker',
    branch: 'autopod/pod-abc1',
    containerId: null,
    worktreePath: null,
    validationAttempts: 0,
    maxValidationAttempts: 3,
    lastValidationResult: null,
    lastValidationFindings: null,
    lastCorrectionMessage: null,
    pendingEscalation: null,
    escalationCount: 0,
    skipValidation: false,
    createdAt: '2026-05-24T00:00:00Z',
    startedAt: null,
    runningAt: null,
    completedAt: null,
    updatedAt: '2026-05-24T00:00:00Z',
    userId: 'user-1',
    creatorEmail: null,
    creatorName: null,
    filesChanged: 0,
    linesAdded: 0,
    linesRemoved: 0,
    previewUrl: null,
    hasWebUi: false,
    prUrl: null,
    mergeBlockReason: null,
    plan: null,
    progress: null,
    contract: null,
    claudeSessionId: null,
    codexSessionId: null,
    options: { agentMode: 'auto', output: 'pr', validate: true, promotable: false },
    outputMode: 'pr',
    baseBranch: null,
    recoveryWorktreePath: null,
    reworkReason: null,
    reworkCount: 0,
    recoveryCount: 0,
    lastHeartbeatAt: null,
    prFixAttempts: 0,
    inputTokens: 1000,
    outputTokens: 500,
    costUsd: 0.1,
    ...overrides,
  } as Pod;
}

function makeSignals(overrides: Partial<QualitySignals> = {}): QualitySignals {
  return {
    podId: 'pod-abc1',
    readCount: 10,
    editCount: 5,
    readEditRatio: 2,
    editsWithoutPriorRead: 0,
    userInterrupts: 0,
    editChurnCount: 0,
    tellsCount: 0,
    prFixAttempts: 0,
    validationPassed: true,
    browserChecks: null,
    tokens: { input: 1000, output: 500, costUsd: 0.1 },
    grade: 'green',
    score: 80,
    model: 'claude-haiku-4-5',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// computeLessonPotential
// ---------------------------------------------------------------------------

describe('computeLessonPotential', () => {
  it('returns score below threshold for an ordinary green pod', () => {
    const pod = makePod();
    const signals = makeSignals({ validationPassed: true, score: 80 });
    const { score } = computeLessonPotential(pod, signals);
    expect(score).toBeLessThan(LESSON_POTENTIAL_THRESHOLD);
  });

  it('returns high score for validation failure alone', () => {
    const pod = makePod();
    const signals = makeSignals({ validationPassed: false });
    const { score, signals: found } = computeLessonPotential(pod, signals);
    expect(score).toBeGreaterThanOrEqual(LESSON_POTENTIAL_THRESHOLD);
    expect(found).toContain('validation_failed');
  });

  it('returns high score for PR fix attempts', () => {
    const pod = makePod({ prFixAttempts: 2 });
    const signals = makeSignals({ prFixAttempts: 2 });
    const { score, signals: found } = computeLessonPotential(pod, signals);
    expect(score).toBeGreaterThanOrEqual(LESSON_POTENTIAL_THRESHOLD);
    expect(found.some((s) => s.startsWith('pr_fix_attempts'))).toBe(true);
  });

  it('returns high score for rework', () => {
    const pod = makePod({ reworkCount: 1 });
    const signals = makeSignals();
    const { score, signals: found } = computeLessonPotential(pod, signals);
    expect(score).toBeGreaterThanOrEqual(LESSON_POTENTIAL_THRESHOLD);
    expect(found.some((s) => s.startsWith('rework'))).toBe(true);
  });

  it('includes tells signal', () => {
    const pod = makePod();
    const signals = makeSignals({ tellsCount: 2 });
    const { score, signals: found } = computeLessonPotential(pod, signals);
    expect(score).toBeGreaterThanOrEqual(LESSON_POTENTIAL_THRESHOLD);
    expect(found.some((s) => s.startsWith('tells'))).toBe(true);
  });

  it('includes edit churn signal', () => {
    const pod = makePod();
    const signals = makeSignals({ editChurnCount: 3 });
    const { score, signals: found } = computeLessonPotential(pod, signals);
    expect(score).toBeGreaterThanOrEqual(LESSON_POTENTIAL_THRESHOLD);
    expect(found.some((s) => s.startsWith('edit_churn'))).toBe(true);
  });

  it('includes killed signal', () => {
    const pod = makePod({ status: 'killed' });
    const signals = makeSignals();
    const { score, signals: found } = computeLessonPotential(pod, signals);
    expect(score).toBeGreaterThanOrEqual(LESSON_POTENTIAL_THRESHOLD);
    expect(found).toContain('killed');
  });

  it('includes low quality score signal', () => {
    const pod = makePod();
    const signals = makeSignals({ score: 30 });
    const { score, signals: found } = computeLessonPotential(pod, signals);
    expect(score).toBeGreaterThanOrEqual(LESSON_POTENTIAL_THRESHOLD);
    expect(found.some((s) => s.startsWith('low_quality_score'))).toBe(true);
  });

  it('adds medium-priority success signal only when no pain signals', () => {
    const pod = makePod();
    const signals = makeSignals({ score: 90, userInterrupts: 0, tellsCount: 0 });
    const { score: potentialScore, signals: found } = computeLessonPotential(pod, signals);
    // Below threshold — success pods don't automatically exceed it
    expect(potentialScore).toBeLessThan(LESSON_POTENTIAL_THRESHOLD);
    expect(found.some((s) => s.startsWith('high_quality_success'))).toBe(true);
  });

  it('does not add success signal when pain signals are present', () => {
    const pod = makePod();
    // validation failure drives score up; success condition should NOT also fire
    const signals = makeSignals({ validationPassed: false, score: 90 });
    const { signals: found } = computeLessonPotential(pod, signals);
    expect(found.some((s) => s.startsWith('high_quality_success'))).toBe(false);
  });

  it('caps score at 1.0 with many simultaneous signals', () => {
    const pod = makePod({ prFixAttempts: 5, reworkCount: 3, status: 'killed' });
    const signals = makeSignals({
      validationPassed: false,
      tellsCount: 4,
      editChurnCount: 5,
      userInterrupts: 4,
      score: 10,
    });
    const { score } = computeLessonPotential(pod, signals);
    expect(score).toBeLessThanOrEqual(1.0);
  });
});

// ---------------------------------------------------------------------------
// extractCandidate
// ---------------------------------------------------------------------------

function makeAnthropicClient(responseText: string): Anthropic {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: responseText }],
      }),
    },
  } as unknown as Anthropic;
}

const VALID_JSON = JSON.stringify({
  create: true,
  path: '/gotchas/migration-order.md',
  content: 'Always run migrations before seeding. Running seed first causes FK constraint failures.',
  rationale: 'Future pods hitting migration order will waste hours debugging FK errors.',
  kind: 'gotcha',
  tags: ['migrations', 'database'],
  appliesWhen: 'When running migrations',
  avoidWhen: null,
  confidence: 0.8,
  impactSummary: 'Prevents FK constraint failures in pods touching DB setup.',
  updateTargetPath: null,
});

const evidence = {
  taskSummary: 'Implemented migration runner',
  how: 'Used SQL scripts',
  blockerMessages: ['Migration failed due to FK constraint'],
  validationErrors: 'Failed phases: build',
};

describe('extractCandidate', () => {
  it('returns candidate with sanitized content on valid LLM response', async () => {
    const client = makeAnthropicClient(VALID_JSON);
    const result = await extractCandidate({
      pod: makePod(),
      lessonSignals: ['validation_failed'],
      evidence,
      existingMemories: [],
      anthropicClient: client,
      reviewerModel: 'claude-haiku-4-5',
      logger,
    });
    expect(result.kind).toBe('candidate');
    if (result.kind !== 'candidate') return;
    expect(result.input.path).toBe('/gotchas/migration-order.md');
    expect(result.input.kind).toBe('gotcha');
    expect(result.input.action).toBe('create');
    expect(result.input.targetMemoryId).toBeNull();
    expect(result.input.scope).toBe('profile');
    expect(result.input.scopeId).toBe('my-profile');
    expect(result.input.createdByPodId).toBe('pod-abc1');
    expect(result.input.confidence).toBe(0.8);
    expect(result.input.sourceEvidence).toHaveLength(1);
    expect(result.input.sourceEvidence[0]?.podId).toBe('pod-abc1');
  });

  it('returns no_candidate when reviewer says create: false', async () => {
    const client = makeAnthropicClient(JSON.stringify({ create: false }));
    const result = await extractCandidate({
      pod: makePod(),
      lessonSignals: ['validation_failed'],
      evidence,
      existingMemories: [],
      anthropicClient: client,
      reviewerModel: 'claude-haiku-4-5',
      logger,
    });
    expect(result.kind).toBe('no_candidate');
  });

  it('returns skipped on reviewer model API failure', async () => {
    const client = {
      messages: {
        create: vi.fn().mockRejectedValue(new Error('Connection refused')),
      },
    } as unknown as Anthropic;
    const result = await extractCandidate({
      pod: makePod(),
      lessonSignals: ['validation_failed'],
      evidence,
      existingMemories: [],
      anthropicClient: client,
      reviewerModel: 'claude-haiku-4-5',
      logger,
    });
    expect(result.kind).toBe('skipped');
    if (result.kind !== 'skipped') return;
    expect(result.reason).toMatch(/reviewer_model_failed/);
  });

  it('returns skipped on JSON parse failure', async () => {
    const client = makeAnthropicClient('this is not json at all');
    const result = await extractCandidate({
      pod: makePod(),
      lessonSignals: ['validation_failed'],
      evidence,
      existingMemories: [],
      anthropicClient: client,
      reviewerModel: 'claude-haiku-4-5',
      logger,
    });
    expect(result.kind).toBe('skipped');
    if (result.kind !== 'skipped') return;
    expect(result.reason).toMatch(/json_parse_failed/);
  });

  it('strips markdown fence from LLM response', async () => {
    const fenced = '```json\n' + VALID_JSON + '\n```';
    const client = makeAnthropicClient(fenced);
    const result = await extractCandidate({
      pod: makePod(),
      lessonSignals: ['validation_failed'],
      evidence,
      existingMemories: [],
      anthropicClient: client,
      reviewerModel: 'claude-haiku-4-5',
      logger,
    });
    expect(result.kind).toBe('candidate');
  });

  it('returns skipped when required fields are missing', async () => {
    const partial = JSON.stringify({ create: true, path: '/gotchas/x.md' }); // missing content etc.
    const client = makeAnthropicClient(partial);
    const result = await extractCandidate({
      pod: makePod(),
      lessonSignals: ['validation_failed'],
      evidence,
      existingMemories: [],
      anthropicClient: client,
      reviewerModel: 'claude-haiku-4-5',
      logger,
    });
    expect(result.kind).toBe('skipped');
    if (result.kind !== 'skipped') return;
    expect(result.reason).toMatch(/output_invalid/);
  });

  it('returns skipped on unknown kind', async () => {
    const bad = JSON.stringify({ ...JSON.parse(VALID_JSON), kind: 'unknown_kind' });
    const client = makeAnthropicClient(bad);
    const result = await extractCandidate({
      pod: makePod(),
      lessonSignals: ['validation_failed'],
      evidence,
      existingMemories: [],
      anthropicClient: client,
      reviewerModel: 'claude-haiku-4-5',
      logger,
    });
    expect(result.kind).toBe('skipped');
  });

  it('resolves update action when updateTargetPath matches existing memory', async () => {
    const existingMemory: MemoryEntry = {
      id: 'mem-existing',
      scope: 'profile',
      scopeId: 'my-profile',
      path: '/gotchas/migration-order.md',
      content: 'old content',
      contentSha256: 'abc',
      rationale: null,
      kind: 'gotcha',
      tags: [],
      appliesWhen: null,
      avoidWhen: null,
      confidence: null,
      sourceEvidence: [],
      impactSummary: null,
      version: 1,
      approved: true,
      createdByPodId: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    const jsonWithUpdate = JSON.stringify({
      ...JSON.parse(VALID_JSON),
      updateTargetPath: '/gotchas/migration-order.md',
    });
    const client = makeAnthropicClient(jsonWithUpdate);
    const result = await extractCandidate({
      pod: makePod(),
      lessonSignals: ['validation_failed'],
      evidence,
      existingMemories: [existingMemory],
      anthropicClient: client,
      reviewerModel: 'claude-haiku-4-5',
      logger,
    });
    expect(result.kind).toBe('candidate');
    if (result.kind !== 'candidate') return;
    expect(result.input.action).toBe('update');
    expect(result.input.targetMemoryId).toBe('mem-existing');
  });

  it('falls back to create when updateTargetPath does not match any memory', async () => {
    const jsonWithMismatch = JSON.stringify({
      ...JSON.parse(VALID_JSON),
      updateTargetPath: '/gotchas/nonexistent.md',
    });
    const client = makeAnthropicClient(jsonWithMismatch);
    const result = await extractCandidate({
      pod: makePod(),
      lessonSignals: ['validation_failed'],
      evidence,
      existingMemories: [],
      anthropicClient: client,
      reviewerModel: 'claude-haiku-4-5',
      logger,
    });
    expect(result.kind).toBe('candidate');
    if (result.kind !== 'candidate') return;
    expect(result.input.action).toBe('create');
    expect(result.input.targetMemoryId).toBeNull();
  });

  it('clamps confidence to [0, 1]', async () => {
    const outOfRange = JSON.stringify({ ...JSON.parse(VALID_JSON), confidence: 1.5 });
    const client = makeAnthropicClient(outOfRange);
    const result = await extractCandidate({
      pod: makePod(),
      lessonSignals: ['validation_failed'],
      evidence,
      existingMemories: [],
      anthropicClient: client,
      reviewerModel: 'claude-haiku-4-5',
      logger,
    });
    expect(result.kind).toBe('candidate');
    if (result.kind !== 'candidate') return;
    expect(result.input.confidence).toBe(1);
  });

  it('assigns high severity to evidence for validation/pr-fix signals', async () => {
    const client = makeAnthropicClient(VALID_JSON);
    const result = await extractCandidate({
      pod: makePod(),
      lessonSignals: ['validation_failed', 'pr_fix_attempts:2'],
      evidence,
      existingMemories: [],
      anthropicClient: client,
      reviewerModel: 'claude-haiku-4-5',
      logger,
    });
    expect(result.kind).toBe('candidate');
    if (result.kind !== 'candidate') return;
    expect(result.input.sourceEvidence[0]?.severity).toBe('high');
  });
});
