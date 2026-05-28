import type { MemoryCandidate, MemoryEntry } from '@autopod/shared';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryCandidateRepository } from '../../pods/memory-candidate-repository.js';
import { createMemoryExtractionAttemptRepository } from '../../pods/memory-extraction-attempt-repository.js';
import { createMemoryRepository } from '../../pods/memory-repository.js';
import { createMemoryUsageRepository } from '../../pods/memory-usage-repository.js';
import { createPodRepository } from '../../pods/pod-repository.js';
import { createTestDb, insertTestProfile } from '../../test-utils/mock-helpers.js';
import { memoryRoutes } from './memory.js';

function makeCandidate(
  overrides: Partial<MemoryCandidate> = {},
): Omit<MemoryCandidate, 'status' | 'createdAt' | 'updatedAt'> {
  return {
    id: overrides.id ?? 'cand-1',
    action: overrides.action ?? 'create',
    targetMemoryId: overrides.targetMemoryId ?? null,
    scope: 'profile',
    scopeId: overrides.scopeId ?? 'test-profile',
    path: overrides.path ?? '/gotchas/build.md',
    content: overrides.content ?? 'Run the focused build before full validation.',
    rationale: overrides.rationale ?? 'Avoids repeated validation failures.',
    kind: overrides.kind ?? 'gotcha',
    tags: overrides.tags ?? ['validation'],
    appliesWhen: overrides.appliesWhen ?? null,
    avoidWhen: overrides.avoidWhen ?? null,
    confidence: overrides.confidence ?? 0.8,
    sourceEvidence: overrides.sourceEvidence ?? [
      {
        podId: 'pod-1',
        signal: 'validation_failed',
        excerpt: 'Build failed because generated files were stale.',
        severity: 'medium',
        createdAt: new Date().toISOString(),
      },
    ],
    impactSummary: overrides.impactSummary ?? 'Prevents stale generated files.',
    createdByPodId: overrides.createdByPodId ?? 'pod-1',
    fallbackReason: overrides.fallbackReason ?? null,
  };
}

function makeMemory(
  overrides: Partial<MemoryEntry> = {},
): Omit<MemoryEntry, 'version' | 'contentSha256' | 'createdAt' | 'updatedAt'> {
  return {
    id: overrides.id ?? 'mem-1',
    scope: overrides.scope ?? 'profile',
    scopeId: overrides.scopeId ?? 'test-profile',
    path: overrides.path ?? '/gotchas/build.md',
    content: overrides.content ?? 'Old content',
    rationale: overrides.rationale ?? 'Existing rationale',
    kind: overrides.kind ?? 'gotcha',
    tags: overrides.tags ?? ['validation'],
    appliesWhen: overrides.appliesWhen ?? null,
    avoidWhen: overrides.avoidWhen ?? null,
    confidence: overrides.confidence ?? 0.7,
    sourceEvidence: overrides.sourceEvidence ?? [],
    impactSummary: overrides.impactSummary ?? 'Existing impact',
    approved: overrides.approved ?? true,
    createdByPodId: overrides.createdByPodId ?? null,
  };
}

describe('memory routes', () => {
  let app: ReturnType<typeof Fastify>;
  let db: ReturnType<typeof createTestDb>;
  let memoryRepo: ReturnType<typeof createMemoryRepository>;
  let candidateRepo: ReturnType<typeof createMemoryCandidateRepository>;
  let attemptRepo: ReturnType<typeof createMemoryExtractionAttemptRepository>;
  let usageRepo: ReturnType<typeof createMemoryUsageRepository>;

  beforeEach(() => {
    db = createTestDb();
    memoryRepo = createMemoryRepository(db);
    candidateRepo = createMemoryCandidateRepository(db);
    attemptRepo = createMemoryExtractionAttemptRepository(db);
    usageRepo = createMemoryUsageRepository(db);
    app = Fastify({ logger: false });
    memoryRoutes(app, {
      memoryRepo,
      memoryCandidateRepo: candidateRepo,
      memoryExtractionAttemptRepo: attemptRepo,
      memoryUsageRepo: usageRepo,
    });
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it('lists pending candidates', async () => {
    candidateRepo.insert(makeCandidate({ id: 'cand-1' }));
    candidateRepo.insert(makeCandidate({ id: 'cand-2', status: 'approved' }));
    candidateRepo.approve('cand-2', memoryRepo);

    const res = await app.inject('/memory/candidates?scopeId=test-profile');

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject([{ id: 'cand-1', status: 'pending' }]);
  });

  it('approves create candidates', async () => {
    candidateRepo.insert(makeCandidate({ id: 'cand-create' }));

    const res = await app.inject({
      method: 'PATCH',
      url: '/memory/candidates/cand-create',
      payload: { action: 'approve' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 'cand-create', status: 'approved' });
    expect(memoryRepo.list('profile', 'test-profile', true)).toHaveLength(1);
  });

  it('approves update candidates', async () => {
    memoryRepo.insert(makeMemory({ id: 'mem-update', content: 'old' }));
    candidateRepo.insert(
      makeCandidate({
        id: 'cand-update',
        action: 'update',
        targetMemoryId: 'mem-update',
        content: 'new',
      }),
    );

    const res = await app.inject({
      method: 'PATCH',
      url: '/memory/candidates/cand-update',
      payload: { action: 'approve' },
    });

    expect(res.statusCode).toBe(200);
    expect(memoryRepo.getOrThrow('mem-update').content).toBe('new');
  });

  it('rejects candidates', async () => {
    candidateRepo.insert(makeCandidate({ id: 'cand-reject' }));

    const res = await app.inject({
      method: 'PATCH',
      url: '/memory/candidates/cand-reject',
      payload: { action: 'reject' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 'cand-reject', status: 'rejected' });
  });

  it('edits candidates before approval', async () => {
    candidateRepo.insert(makeCandidate({ id: 'cand-edit', content: 'before' }));

    const res = await app.inject({
      method: 'PATCH',
      url: '/memory/candidates/cand-edit',
      payload: { action: 'update', content: 'after', impactSummary: 'Updated impact' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 'cand-edit', content: 'after' });
    expect(candidateRepo.get('cand-edit')).toMatchObject({
      content: 'after',
      impactSummary: 'Updated impact',
    });
  });

  it('returns per-memory usage history', async () => {
    memoryRepo.insert(makeMemory({ id: 'mem-usage' }));
    usageRepo.record({
      id: 'usage-1',
      memoryId: 'mem-usage',
      podId: 'pod-1',
      kind: 'selected',
      outcome: null,
      reason: null,
      relevanceReason: 'matched task',
    });

    const res = await app.inject('/memory/mem-usage/usage');

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ memoryId: 'mem-usage', events: [{ id: 'usage-1' }] });
  });

  it('lists extraction attempts by profile', async () => {
    insertTestProfile(db);
    const podRepo = createPodRepository(db);
    podRepo.insert({
      id: 'pod-attempt',
      profileName: 'test-profile',
      task: 'fix flaky validation',
      status: 'complete',
      model: 'claude-haiku-4-5',
      runtime: 'claude',
      executionTarget: 'local',
      branch: 'autopod/pod-attempt',
      userId: 'user-1',
      maxValidationAttempts: 3,
      skipValidation: false,
      outputMode: 'pr',
    });
    attemptRepo.record({
      podId: 'pod-attempt',
      profileName: 'test-profile',
      status: 'reviewer_unavailable',
      reason: 'openai_auth_unavailable',
      score: 0.3,
      signals: ['pr_fix_attempts:2'],
      candidateId: null,
    });

    const res = await app.inject('/memory/extraction-attempts?profileName=test-profile');

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject([
      {
        podId: 'pod-attempt',
        status: 'reviewer_unavailable',
        reason: 'openai_auth_unavailable',
      },
    ]);
  });

  it('returns source evidence', async () => {
    memoryRepo.insert(
      makeMemory({
        id: 'mem-evidence',
        sourceEvidence: [
          {
            podId: 'pod-1',
            signal: 'escalation',
            excerpt: 'Needed human clarification.',
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    );

    const res = await app.inject('/memory/mem-evidence/source-evidence');

    expect(res.statusCode).toBe(200);
    expect(res.json().evidence).toMatchObject([{ signal: 'escalation' }]);
  });

  it('returns stale harmful evidence without disabling memory', async () => {
    memoryRepo.insert(makeMemory({ id: 'mem-stale' }));
    usageRepo.record({
      id: 'usage-harmful',
      memoryId: 'mem-stale',
      podId: 'pod-1',
      kind: 'summary_reported',
      outcome: 'harmful_stale',
      reason: 'API changed.',
      relevanceReason: null,
    });

    const res = await app.inject('/memory/mem-stale/stale-evidence');

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      memoryId: 'mem-stale',
      evidence: [{ id: 'usage-harmful', outcome: 'harmful_stale' }],
    });
    expect(memoryRepo.getOrThrow('mem-stale').approved).toBe(true);
  });
});
