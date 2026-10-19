import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pod, PodOptions } from '@autopod/shared';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMockProfileStore,
  createTestDb,
  insertTestProfile,
  logger,
} from '../test-utils/mock-helpers.js';
import { createCompletionDecision } from './completion-decision.js';
import type { CompletionSourcePreparation } from './completion-source.js';
import { type PodUpdates, createPodRepository } from './pod-repository.js';
import { validateTransition } from './state-machine.js';

afterEach(() => vi.restoreAllMocks());

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function fixture(target: Pod['executionTarget'] = 'local', scheduled = false, linked = false) {
  const directory = mkdtempSync(join(tmpdir(), 'completion-decision-'));
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
  if (scheduled) {
    db.prepare(
      "INSERT INTO scheduled_job_templates (id,name,prompt) VALUES ('t','Decision','Inspect')",
    ).run();
    db.prepare(
      "INSERT INTO scheduled_jobs (id,name,template_id,profile_name,task,cron_expression,next_run_at) VALUES ('job','Decision','t','test-profile','Inspect','0 9 * * *','2030-01-01')",
    ).run();
  }
  if (linked)
    repo.insert({
      id: 'parent',
      profileName: 'test-profile',
      task: 'Parent',
      status: 'running',
      model: 'model',
      runtime: 'codex',
      executionTarget: target,
      branch: 'parent',
      userId: 'operator',
      maxValidationAttempts: 3,
      skipValidation: false,
      outputMode: 'pr',
    });
  repo.insert({
    id: 'worker',
    profileName: 'test-profile',
    task: 'Decide completion',
    status: 'running',
    model: 'model',
    runtime: 'codex',
    executionTarget: target,
    branch: 'feature',
    userId: 'operator',
    maxValidationAttempts: 3,
    skipValidation: false,
    outputMode: 'pr',
    ...(scheduled ? { scheduledJobId: 'job' } : {}),
    ...(linked ? { linkedPodId: 'parent' } : {}),
  });
  repo.update('worker', {
    worktreePath: '/private/source',
    filesChanged: 0,
    startCommitSha: 'a'.repeat(40),
    lastCorrectionMessage: 'old correction',
  });
  const profile = createMockProfileStore(db).get('test-profile');
  const order: string[] = [];
  const activity = vi.fn();
  const info = vi.fn();
  const cleanup = vi.fn(async (_pod: Pod, _label: 'no-changes-complete') => {
    order.push('cleanup');
  });
  const transition = vi.fn(
    (
      pod: Pod,
      to: 'failed' | 'complete' | 'validating' | 'validated',
      updates?: Partial<Pick<PodUpdates, 'completedAt' | 'lastCorrectionMessage'>>,
    ) => {
      validateTransition(pod.id, pod.status, to);
      repo.update(pod.id, { status: to, ...updates });
      order.push(to);
      return repo.getOrThrow(pod.id);
    },
  );
  const completed = vi.fn((_pod: Pod, _count: number) => {
    order.push('completed');
  });
  const dependents = vi.fn((_pod: Pod) => {
    order.push('dependents');
  });
  const validate = vi.fn(async (_id: string) => {
    order.push('validate');
  });
  const dependencies = {
    podRepo: repo,
    executionForPod: vi.fn((_pod: Pod) => profile),
    isPodValidationDisabled: (pod: Pod) =>
      pod.skipValidation || pod.options.validate === false || pod.options.validationSuite === 'off',
    getPodValidationSuite: (pod: Pod): NonNullable<PodOptions['validationSuite']> =>
      pod.options.validationSuite ?? (pod.options.validate === false ? 'off' : 'full'),
    reworkInProgressPrefix: '[REWORK IN PROGRESS]',
    cleanupContainer: cleanup,
    transition,
    emitPodCompletedEvent: completed,
    maybeTriggerDependents: dependents,
    emitActivityStatus: activity,
    logger: { ...logger, info },
  };
  const module = createCompletionDecision(dependencies);
  const source: CompletionSourcePreparation =
    target === 'sandbox'
      ? {
          sandboxCanonicalOutcome: 'unchanged',
          sandboxCheckpoint: {
            sequence: 4,
            sourceHead: 'b'.repeat(40),
            sourceTree: 'e'.repeat(40),
            snapshotCommit: 'c'.repeat(40),
            snapshotTree: 'd'.repeat(40),
            transferVerified: true,
            bundleVerified: true,
            hostImported: true,
            lineageVerified: true,
            promoted: true,
            materialized: true,
            quarantineRef: 'refs/fixture/proof',
          },
          sandboxHostProof: { head: 'c'.repeat(40), tree: 'd'.repeat(40) },
        }
      : {};
  return {
    repo,
    profile,
    order,
    activity,
    info,
    cleanup,
    transition,
    completed,
    dependents,
    validate,
    dependencies,
    source,
    ...module,
    run: (pod = repo.getOrThrow('worker')) => module.applyCompletionDecision(pod, source, validate),
    reopen() {
      db.close();
      db = new Database(file);
      db.pragma('foreign_keys = ON');
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(db.pragma('foreign_key_check')).toEqual([]);
      return createPodRepository(db).getOrThrow('worker');
    },
    close() {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

describe('completion decision persisted effects', () => {
  it.each([
    'complete',
    'failed',
    'validated',
    'validate',
    'scheduled-rework',
    'linked',
    'branch',
    'default',
    'missing-default',
    'null-base',
    'sandbox-changed-off',
    'sandbox-unchanged-off',
  ] as const)('persists %s across actual SQLite close/reopen', async (mode) => {
    const f = fixture(
      mode.startsWith('sandbox') ? 'sandbox' : 'local',
      mode === 'scheduled-rework',
      mode === 'linked',
    );
    try {
      const updates: PodUpdates = {};
      if (mode === 'failed' || mode === 'scheduled-rework')
        updates.lastCorrectionMessage = '[REWORK IN PROGRESS] repair';
      if (mode === 'validated') updates.skipValidation = true;
      if (mode === 'validate') updates.filesChanged = 2;
      if (mode === 'branch') updates.baseBranch = 'release';
      if (mode === 'default' || mode === 'missing-default') updates.baseBranch = 'main';
      if (mode === 'missing-default' || mode === 'null-base') f.profile.defaultBranch = null;
      if (mode.startsWith('sandbox')) {
        updates.options = { ...f.repo.getOrThrow('worker').options, validationSuite: 'off' };
        updates.filesChanged = mode === 'sandbox-changed-off' ? 0 : 7;
        f.source.sandboxCanonicalOutcome = mode === 'sandbox-changed-off' ? 'changed' : 'unchanged';
      }
      f.repo.update('worker', updates);
      expect(f.order).toEqual([]);
      expect(f.dependencies.executionForPod).not.toHaveBeenCalled();
      await f.run();
      const outcome = [
        'validate',
        'linked',
        'branch',
        'missing-default',
        'sandbox-changed-off',
      ].includes(mode)
        ? 'running'
        : ['validated', 'sandbox-unchanged-off'].includes(mode)
          ? 'validated'
          : mode === 'failed'
            ? 'failed'
            : 'complete';
      const persisted = f.reopen();
      expect(persisted.status).toBe(outcome);
      expect(persisted.completedAt).toEqual(
        outcome === 'complete' || outcome === 'failed' ? expect.any(String) : null,
      );
      expect(persisted.lastCorrectionMessage).toBe(
        outcome === 'failed'
          ? 'Rework produced no file changes.'
          : outcome === 'running'
            ? 'old correction'
            : null,
      );
      expect(f.order).toEqual(
        outcome === 'complete'
          ? ['cleanup', 'complete', 'completed', 'dependents']
          : outcome === 'failed'
            ? ['failed']
            : outcome === 'validated'
              ? ['validating', 'validated', 'dependents']
              : ['validate'],
      );
      if (outcome === 'complete') {
        expect(f.completed).toHaveBeenCalledWith(f.transition.mock.results[0]?.value, 0);
        expect(f.dependents.mock.calls[0]?.[0]).toBe(f.transition.mock.results[0]?.value);
      }
    } finally {
      f.close();
    }
  });

  it('awaits cleanup, then forwards the actual transition result', async () => {
    const f = fixture();
    const entered = deferred();
    const release = deferred();
    let operation: Promise<void> | undefined;
    try {
      f.cleanup.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        f.order.push('cleanup');
      });
      const body = f.transition.getMockImplementation();
      if (!body) throw new Error('Missing transition');
      f.transition.mockImplementationOnce((pod, to, updates) => {
        const result = body(pod, to, updates);
        return { ...result, task: 'returned transition object' };
      });
      operation = f.run();
      await entered.promise;
      expect(f.order).toEqual([]);
      expect(f.repo.getOrThrow('worker').status).toBe('running');
      expect(f.completed).not.toHaveBeenCalled();
      expect(f.dependents).not.toHaveBeenCalled();
      release.resolve();
      await operation;
      expect(f.completed.mock.calls[0]?.[0]).toBe(f.transition.mock.results[0]?.value);
      expect(f.dependents.mock.calls[0]?.[0]).toBe(f.transition.mock.results[0]?.value);
      expect(f.completed.mock.calls[0]?.[0].task).toBe('returned transition object');
      expect(f.order).toEqual(['cleanup', 'complete', 'completed', 'dependents']);
    } finally {
      release.resolve();
      await Promise.allSettled(operation ? [operation] : []);
      f.close();
    }
  });

  it('reloads decision inputs and reloads again between bypass transitions', async () => {
    const f = fixture();
    try {
      const original = f.repo.getOrThrow('worker');
      f.repo.update('worker', { filesChanged: 3, skipValidation: true, task: 'fresh decision' });
      const body = f.transition.getMockImplementation();
      if (!body) throw new Error('Missing transition');
      f.transition.mockImplementationOnce((pod, to, updates) => {
        const result = body(pod, to, updates);
        f.repo.update(pod.id, { task: 'fresh validating' });
        return result;
      });
      await f.run(original);
      expect(f.dependencies.executionForPod).toHaveBeenCalledWith(
        expect.objectContaining({ task: 'fresh decision', filesChanged: 3 }),
      );
      expect(f.transition.mock.calls[0]?.[0].task).toBe('fresh decision');
      expect(f.transition.mock.calls[1]?.[0]).toMatchObject({
        status: 'validating',
        task: 'fresh validating',
      });
      expect(f.dependents.mock.calls[0]?.[0]).toBe(f.transition.mock.results[1]?.value);
      expect(f.reopen()).toMatchObject({
        status: 'validated',
        task: 'fresh validating',
        completedAt: null,
        lastCorrectionMessage: null,
      });
    } finally {
      f.close();
    }
  });

  it.each([
    'original-worktree-missing',
    'refreshed-worktree-missing',
    'original-local-refreshed-sandbox',
    'original-sandbox-refreshed-local',
  ] as const)('preserves original-versus-refreshed observation: %s', async (mode) => {
    const f = fixture(mode === 'original-sandbox-refreshed-local' ? 'sandbox' : 'local');
    try {
      if (mode === 'original-worktree-missing') f.repo.update('worker', { worktreePath: null });
      const original = f.repo.getOrThrow('worker');
      if (mode === 'original-worktree-missing')
        f.repo.update('worker', { worktreePath: '/private/new' });
      if (mode === 'refreshed-worktree-missing') f.repo.update('worker', { worktreePath: null });
      if (mode === 'original-local-refreshed-sandbox') {
        f.repo.update('worker', { executionTarget: 'sandbox', skipValidation: true });
        f.source.sandboxCanonicalOutcome = 'changed';
      }
      if (mode === 'original-sandbox-refreshed-local') {
        f.repo.update('worker', { executionTarget: 'local', skipValidation: true });
        f.source.sandboxCanonicalOutcome = 'changed';
      }
      await f.run(original);
      // Original local zero files wins the later no-change bypass even when force is true.
      const expected =
        mode === 'original-worktree-missing'
          ? 'running'
          : mode.includes('refreshed-local') || mode.includes('refreshed-sandbox')
            ? 'validated'
            : 'complete';
      expect(f.reopen().status).toBe(expected);
    } finally {
      f.close();
    }
  });

  it.each([
    'read',
    'settings',
    'cleanup',
    'transition',
    'completed',
    'dependents',
    'validate',
    'bypass-reload',
    'bypass-second-transition',
  ] as const)('propagates %s failure with preceding effects intact', async (stage) => {
    const f = fixture();
    const fault = new Error(`${stage} fault`);
    try {
      if (stage === 'validate') f.repo.update('worker', { filesChanged: 2 });
      if (stage.startsWith('bypass')) f.repo.update('worker', { skipValidation: true });
      const pod = f.repo.getOrThrow('worker');
      if (stage === 'read')
        vi.spyOn(f.repo, 'getOrThrow').mockImplementationOnce(() => {
          throw fault;
        });
      if (stage === 'settings')
        f.dependencies.executionForPod.mockImplementationOnce(() => {
          throw fault;
        });
      if (stage === 'cleanup') f.cleanup.mockRejectedValueOnce(fault);
      if (stage === 'transition')
        f.transition.mockImplementationOnce(() => {
          throw fault;
        });
      if (stage === 'completed')
        f.completed.mockImplementationOnce(() => {
          throw fault;
        });
      if (stage === 'dependents')
        f.dependents.mockImplementationOnce(() => {
          throw fault;
        });
      if (stage === 'validate') f.validate.mockRejectedValueOnce(fault);
      if (stage === 'bypass-second-transition') {
        const body = f.transition.getMockImplementation();
        if (!body) throw new Error('Missing transition');
        f.transition.mockImplementationOnce(body).mockImplementationOnce(() => {
          throw fault;
        });
      }
      if (stage === 'bypass-reload') {
        const body = f.transition.getMockImplementation();
        if (!body) throw new Error('Missing transition');
        f.transition.mockImplementationOnce((p, to, u) => {
          const result = body(p, to, u);
          vi.spyOn(f.repo, 'getOrThrow').mockImplementationOnce(() => {
            throw fault;
          });
          return result;
        });
      }
      await expect(f.run(pod)).rejects.toBe(fault);
      const expected = stage.startsWith('bypass')
        ? 'validating'
        : ['completed', 'dependents'].includes(stage)
          ? 'complete'
          : 'running';
      expect(f.reopen().status).toBe(expected);
      if (stage !== 'dependents') expect(f.dependents).not.toHaveBeenCalled();
      if (stage === 'read' || stage === 'settings' || stage === 'cleanup' || stage === 'transition')
        expect(f.completed).not.toHaveBeenCalled();
      if (stage !== 'validate') expect(f.validate).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });

  it('preserves the successful telemetry summary before the failed Rework branch', async () => {
    const f = fixture('sandbox');
    try {
      f.repo.update('worker', {
        lastCorrectionMessage: '[REWORK IN PROGRESS]',
        validationAttempts: 2,
      });
      f.source.sandboxHostProof = undefined;
      await f.run();
      expect(f.info.mock.calls[0]).toEqual([
        {
          podId: 'worker',
          attempt: 2,
          checkpointSequence: 4,
          baseCommit: 'a'.repeat(12),
          branch: 'feature',
          checkpointCommit: 'c'.repeat(12),
          checkpointTree: 'd'.repeat(12),
          hostHead: null,
          hostTree: null,
          outcome: 'unchanged',
          stats: { filesChanged: 0, linesAdded: 0, linesRemoved: 0 },
          predicateFlags: {
            noChanges: true,
            isForkSession: false,
            isScheduledSession: false,
            validationDisabled: false,
          },
          lifecycleDecision: 'complete',
          cleanupSelected: true,
          validationSelected: false,
          prEligible: false,
        },
        'Sandbox finalization proof and decision',
      ]);
      expect(f.reopen().status).toBe('failed');
      expect(f.cleanup).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });

  it('awaits validation and leaves source state untouched at that boundary', async () => {
    const f = fixture();
    const entered = deferred();
    const release = deferred();
    let operation: Promise<void> | undefined;
    try {
      f.repo.update('worker', { filesChanged: 2 });
      f.validate.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
      });
      let settled = false;
      operation = f.run().then(() => {
        settled = true;
      });
      await entered.promise;
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(f.transition).not.toHaveBeenCalled();
      expect(f.cleanup).not.toHaveBeenCalled();
      release.resolve();
      await operation;
      expect(f.reopen().status).toBe('running');
    } finally {
      release.resolve();
      await Promise.allSettled(operation ? [operation] : []);
      f.close();
    }
  });
});
