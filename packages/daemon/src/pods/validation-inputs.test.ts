import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  Pod,
  ProviderCredentials,
  ReviewBatchResult,
  ValidationOverride,
  ValidationPhase,
  ValidationResult,
} from '@autopod/shared';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import type { ReviewerExecutor } from '../interfaces/reviewer-executor.js';
import type { WorktreeManager } from '../interfaces/worktree-manager.js';
import {
  createMockProfileStore,
  createTestDb,
  insertTestProfile,
  logger,
} from '../test-utils/mock-helpers.js';
import { createPendingOverrideRepository } from './pending-override-repository.js';
import type { PendingOverrideRepository } from './pending-override-repository.js';
import { createPodRepository } from './pod-repository.js';
import { createValidationInputs } from './validation-inputs.js';
import { createValidationRepository } from './validation-repository.js';
import type { ValidationRepository } from './validation-repository.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function reviewBatch(id: string): ReviewBatchResult {
  return {
    id,
    diffHash: 'synthetic-diff',
    reviewedHead: 'a'.repeat(40),
    promptVersion: 'review-council-v1',
    schemaVersion: 'structured-finding-v2',
    model: 'reviewer',
    axes: [],
    candidates: [],
    initialFindings: [],
    accepted: [],
    rejected: [],
    merged: [],
    synthesis: 'model',
    durationMs: 1,
    quality: 'healthy',
    ledger: [],
  };
}

function validation(attempt: number, batch?: ReviewBatchResult): ValidationResult {
  return {
    podId: 'worker',
    attempt,
    timestamp: '2026-10-17T12:00:00Z',
    overall: 'pass',
    duration: 1,
    smoke: {
      status: 'pass',
      build: { status: 'pass', output: '', duration: 1 },
      health: { status: 'pass', url: '', responseCode: 200, duration: 1 },
      pages: [],
    },
    taskReview: batch
      ? {
          status: 'pass',
          reasoning: 'prior',
          issues: [],
          model: 'reviewer',
          reviewBatch: batch,
          screenshots: [],
          diff: 'prior diff',
        }
      : null,
  };
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'validation-inputs-'));
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
  for (const id of ['worker', 'other'])
    repo.insert({
      id,
      profileName: 'test-profile',
      task: 'Prepare inputs',
      status: 'validating',
      model: 'model',
      runtime: 'claude',
      executionTarget: 'local',
      branch: `feature/${id}`,
      userId: 'operator',
      maxValidationAttempts: 7,
      skipValidation: false,
      outputMode: 'pr',
      options: { agentMode: 'auto', output: 'pr', validate: true, validationSuite: 'full' },
      touches: ['src/'],
      doesNotTouch: ['ops/'],
    });
  repo.update('worker', {
    containerId: 'input-container',
    worktreePath: '/private/input-tree',
    startCommitSha: 'start-sha',
  });
  const pod = repo.getOrThrow('worker');
  const s1 = { ...pod, options: { ...pod.options, validationSuite: 'thin' as const } };
  const profile: PodExecutionSettings = createMockProfileStore(db).get('test-profile');
  const reviewer = {
    ...profile,
    modelProvider: 'anthropic' as const,
    defaultRuntime: 'claude' as const,
    reviewerModel: 'reviewer-model',
    providerAccountId: 'selected-account',
  };
  const credentials: ProviderCredentials = { provider: 'anthropic', apiKey: 'synthetic-only' };
  const executor: ReviewerExecutor = vi.fn(async () => ({ stdout: 'synthetic' }));
  const pending = createPendingOverrideRepository(db);
  const history = createValidationRepository(db);
  const order: string[] = [];
  const diff = vi.fn(async (..._args: Parameters<WorktreeManager['getDiff']>) => {
    order.push('diff');
    return 'diff --git a/src/a.ts b/src/a.ts\n';
  });
  const log = vi.fn(async (..._args: Parameters<WorktreeManager['getCommitLog']>) => {
    order.push('log');
    return 'input commit';
  });
  const paths = vi.fn(async (_path: string, _base: string) => {
    order.push('paths');
    return ['src/a.ts'];
  });
  const worktree: Pick<WorktreeManager, 'getDiff' | 'getCommitLog' | 'getChangedPathsAgainstBase'> =
    { getDiff: diff, getCommitLog: log, getChangedPathsAgainstBase: paths };
  const environment = vi.fn(
    async (
      _pod: Pod,
      _profile: PodExecutionSettings,
    ): Promise<Record<string, string> | undefined> => {
      order.push('environment');
      return { CUSTOM: 'retained', AUTOPOD_POD_ID: 'wrong' };
    },
  );
  const guard = vi.fn((_pod: Pod, _paths: string[]) => {
    order.push('guard');
  });
  const skill = vi.fn(async (_path: string) => {
    order.push('skill');
    return 'review rules';
  });
  const reviewerConfig = vi.fn((_pod: Pod) => {
    order.push('reviewer');
    return { profile: reviewer, credentials };
  });
  const reviewerEnv = vi.fn(async (_pod: Pod): Promise<Record<string, string> | undefined> => {
    order.push('reviewer-env');
    return { REVIEW: 'synthetic' };
  });
  const latest = vi.fn((id: string) => {
    order.push('history');
    return history.getLatest(id);
  });
  const batch = vi.fn((id: string) => {
    order.push('batch');
    return history.getLatestReviewBatch(id);
  });
  const flush = vi.fn((id: string) => {
    order.push('flush');
    return pending.flush(id);
  });
  const overrideSource: { pendingOverrideRepo?: Pick<PendingOverrideRepository, 'flush'> } = {
    pendingOverrideRepo: { flush },
  };
  const merge = vi.fn((existing: ValidationOverride[], incoming: ValidationOverride[]) => {
    order.push('merge');
    const entries = new Map(existing.map((o) => [o.findingId, o]));
    for (const o of incoming) entries.set(o.findingId, o);
    return [...entries.values()];
  });
  const update = vi.spyOn(repo, 'update');
  const getExecutor = vi.fn((_pod: Pod): ReviewerExecutor | undefined => {
    order.push('executor');
    return executor;
  });
  const skip = vi.fn((_profile: PodExecutionSettings, snapshot: Pod): ValidationPhase[] => {
    order.push('skip');
    return snapshot.options.validationSuite === 'thin' ? ['review'] : [];
  });
  const activity = vi.fn((_id: string, _message: string) => {
    order.push('activity');
  });
  const dependencies = {
    logger,
    worktreeManager: worktree,
    podRepo: repo,
    validationRepo: { getLatest: latest, getLatestReviewBatch: batch } as
      | Pick<ValidationRepository, 'getLatest' | 'getLatestReviewBatch'>
      | undefined,
    overrideSource,
    validationEnvironmentForPod: environment,
    assertProtectedOperationalPathsInScope: guard,
    loadCodeReviewSkill: skill,
    getEffectiveReviewerConfig: reviewerConfig,
    buildReviewerExecEnv: reviewerEnv,
    mergeOverrides: merge,
    getReviewerExecutor: getExecutor,
    getPodValidationSkipPhases: skip,
    emitActivityStatus: activity,
  };
  return {
    directory,
    repo,
    pod,
    s1,
    profile,
    reviewer,
    credentials,
    executor,
    pending,
    history,
    order,
    diff,
    log,
    paths,
    worktree,
    environment,
    guard,
    skill,
    reviewerConfig,
    reviewerEnv,
    latest,
    batch,
    flush,
    merge,
    update,
    getExecutor,
    skip,
    activity,
    dependencies,
    overrideSource,
    run: () =>
      createValidationInputs(dependencies).prepareValidationInputs(pod, profile, s1, 3, 'full'),
    queue(id = 'worker', findingId = 'same', description = 'new decision') {
      pending.enqueue(id, { findingId, description, action: 'dismiss' });
    },
    rejectOverrideWrite() {
      db.exec(
        "CREATE TRIGGER reject_input_override BEFORE UPDATE OF validation_overrides ON pods BEGIN SELECT RAISE(ABORT, 'input override rejected'); END",
      );
    },
    reopen() {
      db.close();
      db = new Database(file);
      db.pragma('foreign_keys = ON');
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(db.pragma('foreign_key_check')).toEqual([]);
      return {
        pod: createPodRepository(db).getOrThrow('worker'),
        pending: createPendingOverrideRepository(db),
        history: createValidationRepository(db),
      };
    },
    close() {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

describe('validation inputs persisted effects', () => {
  it('constructs without I/O and returns config with original pass-through references', async () => {
    const f = fixture();
    try {
      createValidationInputs(f.dependencies);
      expect(f.order).toEqual([]);
      expect(f.update).not.toHaveBeenCalled();
      const config = (await f.run()).validationConfig;
      expect(config).toMatchObject({
        podId: 'worker',
        containerId: 'input-container',
        executionTarget: 'local',
        previewUrl: 'http://127.0.0.1:3000',
        containerBaseUrl: 'http://127.0.0.1:3000',
        webProbeMode: 'host',
        attempt: 3,
        validationSuite: 'full',
        task: 'Prepare inputs',
        diff: 'diff --git a/src/a.ts b/src/a.ts\n',
        commitLog: 'input commit',
        codeReviewSkill: 'review rules',
        reviewerModel: 'reviewer-model',
        reviewerProvider: 'anthropic',
        reviewerProviderAccountId: 'selected-account',
        briefTouches: ['src/'],
        briefDoesNotTouch: ['ops/'],
        skipPhases: ['review'],
        extraExecEnv: {
          CUSTOM: 'retained',
          AUTOPOD_POD_ID: 'worker',
          AUTOPOD_VALIDATION_BASE_REF: 'start-sha',
        },
      });
      expect(config.smokePages).toBe(f.profile.smokePages);
      expect(config.reviewerProviderCredentials).toBe(f.credentials);
      expect(config.reviewerExecutor).toBe(f.executor);
      expect(config.reviewerExecEnv).toBe(
        f.reviewerEnv.mock.results[0]?.value instanceof Promise
          ? await f.reviewerEnv.mock.results[0]?.value
          : undefined,
      );
      expect(f.skip).toHaveBeenCalledWith(f.profile, f.s1);
      expect(f.guard).toHaveBeenCalledWith(f.pod, ['src/a.ts']);
      expect(f.environment).toHaveBeenCalledWith(f.pod, f.profile);
      expect(f.reviewerConfig).toHaveBeenCalledWith(f.pod);
      expect(f.order).toEqual([
        'activity',
        'environment',
        'diff',
        'log',
        'paths',
        'guard',
        'skill',
        'reviewer',
        'reviewer-env',
        'history',
        'batch',
        'flush',
        'executor',
        'skip',
      ]);
      expect(f.activity).toHaveBeenCalledWith('worker', 'Computing diff…');
    } finally {
      f.close();
    }
  });

  it('passes through optional pod objects while skip phases use the transition snapshot', async () => {
    const f = fixture();
    try {
      const contract: NonNullable<Pod['contract']> = {
        contractVersion: 1,
        title: 'Inputs',
        dependsOn: [],
        scenarios: [],
        requiredFacts: [],
        humanReview: [],
      };
      const plan = { summary: 'plan', steps: ['step'] };
      const summary = { actualSummary: 'summary', deviations: [] };
      const preSubmit: NonNullable<Pod['preSubmitReview']> = {
        status: 'pass',
        diffHash: 'hash',
        reasoning: 'Checked',
        issues: [],
        model: 'reviewer',
        checkedAt: '2026-10-17T12:00:00Z',
      };
      Object.assign(f.pod, {
        contract,
        plan,
        taskSummary: summary,
        preSubmitReview: preSubmit,
        previewUrl: '',
        executionTarget: 'sandbox',
      });
      f.pod.options.advisoryBrowserQaEnabled = true;
      const config = (await f.run()).validationConfig;
      expect(config.contract).toBe(contract);
      expect(config.plan).toBe(plan);
      expect(config.taskSummary).toBe(summary);
      expect(config.preSubmitReview).toBe(preSubmit);
      expect(config.briefTouches).toBe(f.pod.touches);
      expect(config.briefDoesNotTouch).toBe(f.pod.doesNotTouch);
      expect(config).toMatchObject({
        previewUrl: '',
        webProbeMode: 'container',
        advisoryBrowserQaEnabled: true,
        skipPhases: ['review'],
        validationSuite: 'full',
      });
    } finally {
      f.close();
    }
  });

  it.each([null, 0, 9])('preserves defaults or explicit timeout %s', async (timeout) => {
    const f = fixture();
    try {
      Object.assign(f.profile, {
        healthTimeout: timeout,
        buildTimeout: timeout,
        testTimeout: timeout,
        lintTimeout: timeout,
        sastTimeout: timeout,
      });
      const config = (await f.run()).validationConfig;
      expect(config.healthTimeout).toBe(timeout ?? 120);
      expect(config.buildTimeout).toBe((timeout ?? 300) * 1000);
      expect(config.testTimeout).toBe((timeout ?? 600) * 1000);
      expect(config.lintTimeout).toBe((timeout ?? 120) * 1000);
      expect(config.sastTimeout).toBe((timeout ?? 300) * 1000);
    } finally {
      f.close();
    }
  });

  it.each([null, ''])(
    'preserves nullish versus empty command and health fields: %s',
    async (value) => {
      const f = fixture();
      try {
        Object.assign(f.profile, {
          buildCommand: value,
          startCommand: value,
          buildWorkDir: value,
          healthPath: value,
          validationSetupCommand: value,
          lintCommand: value,
          sastCommand: value,
          testCommand: value,
          hasWebUi: false,
        });
        const config = (await f.run()).validationConfig;
        expect(config).toMatchObject({
          buildCommand: value ?? '',
          startCommand: value ?? '',
          buildWorkDir: value ?? undefined,
          healthPath: value ?? '/',
          validationSetupCommand: value ?? undefined,
          lintCommand: value ?? undefined,
          sastCommand: value ?? undefined,
          testCommand: value,
          hasWebUi: false,
        });
      } finally {
        f.close();
      }
    },
  );

  it.each([
    { podBase: 'release/pod', profileBase: 'release/profile', base: 'release/pod' },
    { podBase: null, profileBase: 'release/profile', base: 'release/profile' },
    { podBase: null, profileBase: null, base: 'main' },
    { podBase: '', profileBase: 'release/profile', base: '' },
    { podBase: null, profileBase: '', base: '' },
  ])('retains base selection $base and all Git arguments', async (c) => {
    const f = fixture();
    try {
      f.pod.baseBranch = c.podBase;
      f.profile.defaultBranch = c.profileBase;
      await f.run();
      expect(f.diff).toHaveBeenCalledWith('/private/input-tree', c.base, undefined, 'start-sha');
      expect(f.log).toHaveBeenCalledWith('/private/input-tree', c.base, undefined, 'start-sha');
      expect(f.paths).toHaveBeenCalledWith('/private/input-tree', c.base);
    } finally {
      f.close();
    }
  });

  it.each([null, '', '  scoped-sha  '])(
    'retains raw Git start scope and normalized env for %s',
    async (start) => {
      const f = fixture();
      try {
        f.pod.startCommitSha = start;
        const config = (await f.run()).validationConfig;
        expect(f.diff).toHaveBeenCalledWith(
          '/private/input-tree',
          'main',
          undefined,
          start ?? undefined,
        );
        expect(config.startCommitSha).toBe(start ?? undefined);
        expect(config.extraExecEnv?.AUTOPOD_VALIDATION_BASE_REF).toBe(
          start?.trim() || 'origin/main',
        );
      } finally {
        f.close();
      }
    },
  );

  it('falls back to parsed paths only when the optional base-path operation is absent', async () => {
    const f = fixture();
    try {
      f.worktree.getChangedPathsAgainstBase = undefined;
      f.diff.mockResolvedValueOnce(
        'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n',
      );
      await f.run();
      expect(f.paths).not.toHaveBeenCalled();
      expect(f.guard).toHaveBeenCalledWith(f.pod, ['src/a.ts']);
    } finally {
      f.close();
    }
  });

  it('keeps no-worktree inputs empty while resolving review, history and queue', async () => {
    const f = fixture();
    try {
      f.pod.worktreePath = null;
      f.queue();
      f.dependencies.validationRepo = undefined;
      const out = await f.run();
      expect(out.previousValidation).toBeNull();
      expect(out.validationConfig).toMatchObject({
        diff: '',
        commitLog: undefined,
        codeReviewSkill: undefined,
        worktreePath: undefined,
        priorReviewBatch: undefined,
      });
      expect(f.diff).not.toHaveBeenCalled();
      expect(f.log).not.toHaveBeenCalled();
      expect(f.paths).not.toHaveBeenCalled();
      expect(f.skill).not.toHaveBeenCalled();
      expect(f.reviewerEnv).toHaveBeenCalledWith(f.pod);
      expect(f.flush).toHaveBeenCalledWith('worker');
      expect(f.reopen().pending.list('worker')).toEqual([]);
    } finally {
      f.close();
    }
  });

  it.each([false, true])(
    'keeps legacy API-key and scoped-launch rule (scoped=%s)',
    async (scoped) => {
      const f = fixture();
      try {
        vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic-legacy-only');
        f.pod.launchConfigDigest = scoped ? 'digest' : null;
        f.reviewerEnv.mockResolvedValue(undefined);
        f.environment.mockResolvedValue(undefined);
        const config = (await f.run()).validationConfig;
        expect(config).toHaveProperty(
          'reviewerApiKey',
          scoped ? undefined : 'synthetic-legacy-only',
        );
        expect(config).not.toHaveProperty('reviewerExecEnv');
        expect(config.extraExecEnv?.AUTOPOD_POD_ID).toBe('worker');
      } finally {
        vi.unstubAllEnvs();
        f.close();
      }
    },
  );

  it('preserves chronological history and returned record identity across attempt resets', async () => {
    const f = fixture();
    try {
      f.history.insert('worker', 1, validation(1, reviewBatch('old')));
      f.history.insert('worker', 2, validation(2, reviewBatch('latest-batch')));
      f.history.insert('worker', 1, validation(1));
      const out = await f.run();
      expect(out.previousValidation).toBe(f.latest.mock.results[0]?.value);
      expect(out.previousValidation).toMatchObject({ sequence: 3, cycle: 1, attempt: 1 });
      expect(out.validationConfig.priorReviewBatch?.id).toBe('latest-batch');
      expect(out.validationConfig.priorReviewBatch).toBe(f.batch.mock.results[0]?.value);
      expect(
        f
          .reopen()
          .history.getForSession('worker')
          .map((r) => [r.attempt, r.sequence, r.cycle]),
      ).toEqual([
        [1, 1, 0],
        [2, 2, 0],
        [1, 3, 1],
      ]);
    } finally {
      f.close();
    }
  });

  it('persists merged overrides and consumes only this pod queue across close/reopen', async () => {
    const f = fixture();
    try {
      f.pod.validationOverrides = [
        { findingId: 'same', description: 'old', action: 'dismiss', createdAt: 'old' },
        { findingId: 'kept', description: 'kept', action: 'guidance', createdAt: 'old' },
      ];
      f.queue();
      f.queue('worker', 'added', 'added');
      f.queue('other');
      const config = (await f.run()).validationConfig;
      expect(config.overrides?.map((o) => [o.findingId, o.description])).toEqual([
        ['same', 'new decision'],
        ['kept', 'kept'],
        ['added', 'added'],
      ]);
      expect(config.overrides).toBe(f.merge.mock.results[0]?.value);
      const persisted = f.reopen();
      expect(persisted.pod.validationOverrides).toEqual(config.overrides);
      expect(persisted.pending.list('worker')).toEqual([]);
      expect(persisted.pending.list('other')).toHaveLength(1);
    } finally {
      f.close();
    }
  });

  it('keeps existing override array identity and avoids writes for an empty queue', async () => {
    const f = fixture();
    try {
      f.pod.validationOverrides = [
        { findingId: 'kept', description: 'kept', action: 'dismiss', createdAt: 'old' },
      ];
      const config = (await f.run()).validationConfig;
      expect(config.overrides).toBe(f.pod.validationOverrides);
      expect(f.update).not.toHaveBeenCalled();
      expect(f.merge).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });

  it('reads optional override source late and preserves post-await pod reads', async () => {
    const f = fixture();
    const gate = deferred<Record<string, string> | undefined>();
    let operation: ReturnType<typeof f.run> | undefined;
    try {
      f.environment.mockReturnValueOnce(gate.promise);
      operation = f.run();
      expect(f.diff).not.toHaveBeenCalled();
      const replacement = vi.fn((id: string) => f.pending.flush(id));
      f.overrideSource.pendingOverrideRepo = { flush: replacement };
      f.queue();
      f.pod.containerId = 'late-container';
      f.pod.task = 'late task';
      gate.resolve(undefined);
      const config = (await operation).validationConfig;
      expect(config).toMatchObject({ containerId: 'late-container', task: 'late task' });
      expect(replacement).toHaveBeenCalledWith('worker');
      expect(f.flush).not.toHaveBeenCalled();
    } finally {
      gate.resolve(undefined);
      await Promise.allSettled(operation ? [operation] : []);
      f.close();
    }
  });

  it('starts both source reads before awaiting either and waits for both before history/flush', async () => {
    const f = fixture();
    const diff = deferred<string>();
    const log = deferred<string>();
    let operation: ReturnType<typeof f.run> | undefined;
    try {
      f.diff.mockReturnValueOnce(diff.promise);
      f.log.mockReturnValueOnce(log.promise);
      operation = f.run();
      await vi.waitFor(() => {
        expect(f.diff).toHaveBeenCalledOnce();
        expect(f.log).toHaveBeenCalledOnce();
      });
      expect(f.latest).not.toHaveBeenCalled();
      expect(f.flush).not.toHaveBeenCalled();
      f.queue();
      diff.resolve('source diff');
      await Promise.resolve();
      expect(f.flush).not.toHaveBeenCalled();
      log.resolve('source log');
      expect((await operation).validationConfig).toMatchObject({
        diff: 'source diff',
        commitLog: 'source log',
        overrides: [expect.objectContaining({ findingId: 'same' })],
      });
    } finally {
      diff.resolve('');
      log.resolve('');
      await Promise.allSettled(operation ? [operation] : []);
      f.close();
    }
  });

  it('handles absent optional repositories and empty overrides without writes', async () => {
    const f = fixture();
    try {
      f.overrideSource.pendingOverrideRepo = undefined;
      f.dependencies.validationRepo = undefined;
      f.pod.validationOverrides = null;
      const out = await f.run();
      expect(out.previousValidation).toBeNull();
      expect(out.validationConfig).toHaveProperty('overrides', undefined);
      expect(f.update).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });

  it.each([
    'environment',
    'diff',
    'log',
    'paths',
    'guard',
    'skill',
    'reviewer',
    'reviewer-env',
    'history',
    'batch',
    'flush',
    'write',
    'executor',
    'skip',
  ] as const)('preserves exact error identity and partial effects at %s', async (stage) => {
    const f = fixture();
    const fault = new Error(`synthetic-${stage}`);
    try {
      f.queue();
      if (stage === 'environment') f.environment.mockRejectedValueOnce(fault);
      if (stage === 'diff') f.diff.mockRejectedValueOnce(fault);
      if (stage === 'log') f.log.mockRejectedValueOnce(fault);
      if (stage === 'paths') f.paths.mockRejectedValueOnce(fault);
      if (stage === 'guard')
        f.guard.mockImplementationOnce(() => {
          throw fault;
        });
      if (stage === 'skill') f.skill.mockRejectedValueOnce(fault);
      if (stage === 'reviewer')
        f.reviewerConfig.mockImplementationOnce(() => {
          throw fault;
        });
      if (stage === 'reviewer-env') f.reviewerEnv.mockRejectedValueOnce(fault);
      if (stage === 'history')
        f.latest.mockImplementationOnce(() => {
          throw fault;
        });
      if (stage === 'batch')
        f.batch.mockImplementationOnce(() => {
          throw fault;
        });
      if (stage === 'flush')
        f.flush.mockImplementationOnce(() => {
          throw fault;
        });
      if (stage === 'write')
        f.update.mockImplementationOnce(() => {
          throw fault;
        });
      if (stage === 'executor')
        f.getExecutor.mockImplementationOnce(() => {
          throw fault;
        });
      if (stage === 'skip')
        f.skip.mockImplementationOnce(() => {
          throw fault;
        });
      await expect(f.run()).rejects.toBe(fault);
      const persisted = f.reopen();
      const afterFlush = ['write', 'executor', 'skip'].includes(stage);
      const afterWrite = ['executor', 'skip'].includes(stage);
      expect(persisted.pending.list('worker')).toHaveLength(afterFlush ? 0 : 1);
      expect(persisted.pod.validationOverrides ?? []).toHaveLength(afterWrite ? 1 : 0);
      expect(persisted.pod.status).toBe('validating');
      if (!afterWrite && stage !== 'executor') expect(f.getExecutor).not.toHaveBeenCalled();
      if (stage !== 'skip') expect(f.skip).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });

  it('retains queue deletion when real SQLite rejects the subsequent override write', async () => {
    const f = fixture();
    try {
      f.queue();
      f.rejectOverrideWrite();
      await expect(f.run()).rejects.toThrow('input override rejected');
      expect(f.getExecutor).not.toHaveBeenCalled();
      const persisted = f.reopen();
      expect(persisted.pending.list('worker')).toEqual([]);
      expect(persisted.pod.validationOverrides ?? []).toEqual([]);
    } finally {
      f.close();
    }
  });
});
