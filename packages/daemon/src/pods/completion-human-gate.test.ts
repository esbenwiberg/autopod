import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EscalationRequest, Pod } from '@autopod/shared';
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { createTestDb, insertTestProfile, logger } from '../test-utils/mock-helpers.js';
import { createCompletionHumanGate } from './completion-human-gate.js';
import { createEscalationRepository } from './escalation-repository.js';
import { createNudgeRepository } from './nudge-repository.js';
import { createPodRepository } from './pod-repository.js';

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'completion-human-gate-'));
  const file = join(directory, 'state.db');
  const seed = createTestDb();
  try {
    insertTestProfile(seed);
    writeFileSync(file, seed.serialize());
  } finally {
    seed.close();
  }
  let db = new Database(file);
  db.pragma('foreign_keys = ON');
  const repo = createPodRepository(db);
  repo.insert({
    id: 'worker',
    profileName: 'test-profile',
    task: 'Keep human work',
    status: 'running',
    model: 'model',
    runtime: 'codex',
    executionTarget: 'local',
    branch: 'worker',
    userId: 'operator',
    maxValidationAttempts: 3,
    skipValidation: false,
    outputMode: 'pr',
  });
  repo.update('worker', { containerId: 'original-container', worktreePath: '/private/source' });
  const nudges = createNudgeRepository(db);
  const question: EscalationRequest = {
    id: 'decision',
    podId: 'worker',
    type: 'ask_human',
    timestamp: '2026-10-17T12:00:00Z',
    payload: { question: 'Keep this source?' },
    response: null,
  };
  const preserve = vi.fn(async (_pod: Pod, _reason: string) => {});
  const owns = vi.fn(() => true);
  const activity = vi.fn();
  const published: string[] = [];
  const transition = vi.fn((pod: Pod, to: 'failed', updates: { failureReason: string }) => {
    repo.update(pod.id, { status: to, ...updates });
    repo.afterCommit?.(() => published.push(to));
    return repo.getOrThrow(pod.id);
  });
  const dependencies = {
    podRepo: repo,
    nudgeRepo: nudges,
    preservePodWorkspace: preserve,
    ownsArtifactCompletion: owns,
    transition,
    logger,
    emitActivityStatus: activity,
  };
  const gate = createCompletionHumanGate(dependencies);
  return {
    db,
    repo,
    nudges,
    question,
    preserve,
    owns,
    activity,
    transition,
    published,
    dependencies,
    ...gate,
    ask() {
      createEscalationRepository(db).insert(question);
      repo.update('worker', { status: 'awaiting_input', pendingEscalation: question });
    },
    reopen() {
      db.close();
      db = new Database(file);
      db.pragma('foreign_keys = ON');
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(db.pragma('foreign_key_check')).toEqual([]);
      return { db, repo: createPodRepository(db), nudges: createNudgeRepository(db) };
    },
    close() {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

const guidanceReason =
  'Worker settled with uncollected human guidance. Use Rework to read check_messages, acknowledge its receipt, and apply the saved guidance before validation or delivery.';

describe('completion human gate persistence', () => {
  it('retains an unanswered decision and exact queue across close/reopen, and skips repeat capture', async () => {
    const f = fixture();
    try {
      f.ask();
      f.nudges.queue('worker', 'Later guidance');
      const pending = f.nudges.listPending('worker');
      await f.holdCompletionForHumanWork(f.repo.getOrThrow('worker'));
      const saved = f.repo.getOrThrow('worker');
      expect(saved).toMatchObject({
        status: 'awaiting_input',
        pendingEscalation: f.question,
        finalization: {
          phase: 'awaiting_human',
          pendingDecisionId: 'decision',
          sourcePreservedAt: expect.any(String),
          agentSettledAt: expect.any(String),
        },
      });
      expect(f.transition).not.toHaveBeenCalled();
      expect(f.owns).not.toHaveBeenCalled();
      const reopened = f.reopen();
      expect(reopened.repo.getOrThrow('worker')).toEqual(saved);
      expect(reopened.nudges.listPending('worker')).toEqual(pending);
      expect(createEscalationRepository(reopened.db).getOrThrow('decision').response).toBeNull();
      expect(reopened.db.prepare('SELECT * FROM completion_decisions').all()).toEqual([]);
      const again = createCompletionHumanGate({
        ...f.dependencies,
        podRepo: reopened.repo,
        nudgeRepo: reopened.nudges,
      });
      await again.holdCompletionForHumanWork(reopened.repo.getOrThrow('worker'));
      expect(f.preserve).toHaveBeenCalledOnce();
      expect(reopened.repo.getOrThrow('worker').finalization).toEqual(saved.finalization);
    } finally {
      f.close();
    }
  });

  it.each([
    'success',
    'error',
    'non-error',
    'missing-container',
    'missing-worktree',
    'existing-proof',
  ] as const)(
    'retains exact unconsumed guidance and durable capture result for %s',
    async (mode) => {
      const f = fixture();
      try {
        f.nudges.queue('worker', 'First answer');
        f.nudges.queue('worker', 'Second answer');
        const pending = f.nudges.listPending('worker');
        if (mode === 'error') f.preserve.mockRejectedValueOnce(new Error('capture fault'));
        if (mode === 'non-error') f.preserve.mockRejectedValueOnce('capture fault');
        if (mode === 'missing-container') f.repo.update('worker', { containerId: null });
        if (mode === 'missing-worktree') f.repo.update('worker', { worktreePath: null });
        const pod = f.repo.getOrThrow('worker');
        if (mode === 'existing-proof') {
          f.repo.completionJournal?.settle(pod);
          f.repo.completionJournal?.mark(pod, 'awaiting_human', true);
          // Failed recapture must not erase the pre-existing proof.
          f.preserve.mockRejectedValueOnce(new Error('capture fault'));
        }
        const priorProof = f.repo.getOrThrow('worker').finalization?.sourcePreservedAt;
        await f.holdCompletionForHumanWork(pod);
        const failure = ['error', 'non-error', 'existing-proof'].includes(mode);
        const missing = mode.startsWith('missing');
        expect(f.preserve).toHaveBeenCalledTimes(missing ? 0 : 1);
        if (!missing)
          expect(f.preserve).toHaveBeenCalledWith(
            pod,
            'uncollected human guidance after agent settlement',
          );
        const expectedReason = `${guidanceReason}${failure ? ' Workspace preservation failed: capture fault.' : ''} Original resources and guidance retained.`;
        expect(f.owns).toHaveBeenCalledWith(pod, false, true);
        const restored = f.reopen();
        expect(restored.repo.getOrThrow('worker')).toMatchObject({
          status: 'failed',
          failureReason: expectedReason,
          containerId: pod.containerId,
          worktreePath: pod.worktreePath,
          finalization: {
            phase: 'awaiting_human',
            pendingDecisionId: null,
            sourcePreservedAt:
              mode === 'existing-proof'
                ? priorProof
                : failure || missing
                  ? null
                  : expect.any(String),
          },
        });
        expect(restored.nudges.listPending('worker')).toEqual(pending);
        expect(restored.db.prepare('SELECT * FROM completion_decisions').all()).toEqual([]);
        expect(
          restored.db.prepare('SELECT * FROM operator_guidance_acknowledgments').all(),
        ).toEqual([]);
        expect(f.activity).toHaveBeenCalledWith('worker', expectedReason);
        expect(f.published).toEqual(['failed']);
      } finally {
        f.close();
      }
    },
  );

  it.each(['question', 'guidance'] as const)(
    'does not mark %s source before the held preserver succeeds',
    async (kind) => {
      const f = fixture();
      const held = deferred();
      let operation: Promise<void> | undefined;
      try {
        if (kind === 'question') f.ask();
        else f.nudges.queue('worker', 'Retain answer');
        f.preserve.mockImplementationOnce(() => held.promise);
        operation = f.holdCompletionForHumanWork(f.repo.getOrThrow('worker'));
        expect(operation).toBeInstanceOf(Promise);
        expect(f.repo.getOrThrow('worker').finalization?.sourcePreservedAt).toBeNull();
        expect(f.transition).not.toHaveBeenCalled();
        expect(f.activity).not.toHaveBeenCalled();
        held.resolve();
        await operation;
        const restored = f.reopen();
        expect(restored.repo.getOrThrow('worker').finalization?.sourcePreservedAt).toEqual(
          expect.any(String),
        );
      } finally {
        held.resolve();
        await operation;
        f.close();
      }
    },
  );

  it('rolls back actual journal/state writes and queued publication, retaining earlier settlement on disk', async () => {
    const f = fixture();
    try {
      f.nudges.queue('worker', 'Retain answer');
      const pending = f.nudges.listPending('worker');
      const transition = f.transition.getMockImplementation();
      if (!transition) throw new Error('Missing transition');
      f.transition.mockImplementationOnce((...args) => {
        transition(...args);
        throw new Error('transaction fault');
      });
      await expect(f.holdCompletionForHumanWork(f.repo.getOrThrow('worker'))).rejects.toThrow(
        'transaction fault',
      );
      expect(f.preserve).toHaveBeenCalledOnce();
      expect(f.published).toEqual([]);
      expect(f.activity).not.toHaveBeenCalled();
      const restored = f.reopen();
      expect(restored.repo.getOrThrow('worker')).toMatchObject({
        status: 'running',
        failureReason: null,
        finalization: {
          phase: 'ready',
          sourcePreservedAt: null,
          agentSettledAt: expect.any(String),
        },
      });
      expect(restored.nudges.listPending('worker')).toEqual(pending);
    } finally {
      f.close();
    }
  });

  it('stops a held guidance invocation after ownership loss without marking or transitioning', async () => {
    const f = fixture();
    const held = deferred();
    let operation: Promise<void> | undefined;
    try {
      f.nudges.queue('worker', 'Retain answer');
      f.preserve.mockImplementationOnce(() => held.promise);
      const pod = f.repo.getOrThrow('worker');
      operation = f.holdCompletionForHumanWork(pod);
      f.repo.incrementLifecycleGeneration('worker');
      f.owns.mockReturnValue(false);
      held.resolve();
      await operation;
      expect(f.owns).toHaveBeenCalledWith(pod, false, true);
      expect(f.transition).not.toHaveBeenCalled();
      expect(f.activity).not.toHaveBeenCalled();
      const restored = f.reopen();
      expect(restored.repo.getOrThrow('worker')).toMatchObject({
        status: 'running',
        lifecycleGeneration: 2,
        finalization: null,
      });
      expect(
        restored.db
          .prepare('SELECT phase,source_preserved_at FROM pod_finalizations WHERE generation=1')
          .get(),
      ).toEqual({ phase: 'ready', source_preserved_at: null });
      expect(restored.nudges.hasPending('worker')).toBe(true);
    } finally {
      held.resolve();
      await operation;
      f.close();
    }
  });

  it('returns undefined synchronously for the empty path without mutation or an async dispatch window', () => {
    const f = fixture();
    try {
      const before = f.repo.getOrThrow('worker');
      expect(f.holdCompletionForHumanWork(before)).toBeUndefined();
      expect(f.repo.getOrThrow('worker')).toEqual(before);
      expect(f.preserve).not.toHaveBeenCalled();
      expect(f.transition).not.toHaveBeenCalled();
      expect(f.activity).not.toHaveBeenCalled();
      expect(f.owns).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });

  it.each(['question', 'guidance'] as const)(
    'retains legacy %s behavior without journal or transaction support',
    async (kind) => {
      const f = fixture();
      try {
        if (kind === 'question') f.ask();
        else f.nudges.queue('worker', 'Retain answer');
        const legacy = createCompletionHumanGate({
          ...f.dependencies,
          podRepo: { getOrThrow: f.repo.getOrThrow },
        });
        await legacy.holdCompletionForHumanWork(f.repo.getOrThrow('worker'));
        expect(f.preserve).toHaveBeenCalledOnce();
        const restored = f.reopen();
        expect(restored.repo.getOrThrow('worker').status).toBe(
          kind === 'question' ? 'awaiting_input' : 'failed',
        );
        expect(restored.repo.getOrThrow('worker').finalization).toBeNull();
        if (kind === 'guidance') expect(restored.nudges.hasPending('worker')).toBe(true);
      } finally {
        f.close();
      }
    },
  );
});
