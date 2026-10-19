import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AutopodError, type Pod, type ValidationPhase } from '@autopod/shared';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReviewerLaunchIdentity } from '../interfaces/reviewer-launch.js';
import type { ValidationEngineConfig } from '../interfaces/validation-engine.js';
import {
  createMockContainerManager,
  createMockProfileStore,
  createTestDb,
  insertTestProfile,
} from '../test-utils/mock-helpers.js';
import * as preflight from './execution-preflight.js';
import { createNudgeRepository } from './nudge-repository.js';
import { createPodRepository } from './pod-repository.js';
import { TaskRetryBlockedError } from './task-retry-ledger.js';
import { captureValidationOwnership } from './validation-ownership.js';
import { createValidationProvenance } from './validation-provenance.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const close of cleanup.splice(0).reverse()) close();
});
function needed<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Missing provenance fixture');
  return value;
}
function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function caught(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('Expected synchronous failure');
}
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'validation-provenance-'));
  const file = path.join(root, 'state.db');
  const seed = createTestDb();
  try {
    insertTestProfile(seed);
    fs.writeFileSync(file, seed.serialize());
  } finally {
    seed.close();
  }
  let db = new Database(file);
  db.pragma('foreign_keys = ON');
  cleanup.push(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const repo = createPodRepository(db);
  repo.insert({
    id: 'worker',
    profileName: 'test-profile',
    task: 'Launch provenance',
    status: 'validating',
    runtime: 'claude',
    model: 'worker-model',
    executionTarget: 'local',
    branch: 'feature/provenance',
    userId: 'operator',
    maxValidationAttempts: 3,
    skipValidation: false,
    outputMode: 'pr',
  });
  repo.update('worker', { containerId: 'container' });
  const pod = repo.getOrThrow('worker');
  const profile = { ...createMockProfileStore(db).get('test-profile'), containerMemoryGb: 4 };
  const ledger = needed(repo.executionProvenance);
  const record = vi.spyOn(ledger, 'record');
  const reads = vi.spyOn(repo, 'getOrThrow');
  const cm = createMockContainerManager();
  const metadata = {
    imageDigest: `sha256:${'a'.repeat(64)}`,
    memoryLimitBytes: 8 * 1024 ** 3,
    cpuLimit: 4,
    networkMode: 'fixture',
  };
  cm.getExecutionMetadata = vi.fn(async () => metadata);
  const get = vi.fn((_target: Pod['executionTarget']) => cm);
  const resolve = vi.fn((_pod: Pod) => profile);
  const deps: Parameters<typeof createValidationProvenance>[0] = {
    podRepo: repo,
    containerManagerFactory: { get },
    resolveEffectiveBoundProfile: resolve,
  };
  const inspect = vi.spyOn(preflight, 'inspectExecutionPreflight'); // Passthrough spy: actual inspector runs.
  const nudges = createNudgeRepository(db);
  let invocation = true;
  const owner = captureValidationOwnership(pod, {
    readCurrent: () => repo.getOrThrow('worker'),
    isCurrentInvocation: () => invocation,
    hasPendingDecision: () =>
      nudges.hasPending('worker') || Boolean(repo.hasUnansweredDecision?.('worker')),
  });
  const config: ValidationEngineConfig = {
    podId: 'worker',
    containerId: 'container',
    previewUrl: '',
    buildCommand: 'node build.js',
    startCommand: 'node server.js',
    testCommand: 'node test.js',
    lintCommand: 'node lint.js',
    sastCommand: 'node scan.js',
    validationSetupCommand: 'node setup.js',
    healthPath: '/',
    healthTimeout: 1000,
    smokePages: [],
    attempt: 1,
    task: 'Review',
    diff: '+fixture',
    reviewerModel: 'sonnet',
    reviewerProvider: 'anthropic',
    reviewerProviderAccountId: 'review-account',
    buildWorkDir: 'app',
    extraExecEnv: { FIXTURE_ENV: 'value' },
  };
  const identity: ReviewerLaunchIdentity = {
    podId: 'worker',
    containerId: 'container',
    runtime: 'claude',
    model: 'sonnet',
  };
  const op = createValidationProvenance(deps);
  const run = (
    purpose?: 'validation' | 'review',
    guarded = true,
    launch?: ReviewerLaunchIdentity,
  ) =>
    op.recordValidationProvenance(
      config,
      purpose,
      guarded ? owner.assertCurrent : undefined,
      launch,
    );
  const rows = () =>
    (
      db
        .prepare('SELECT payload FROM execution_provenance WHERE pod_id = ? ORDER BY rowid')
        .all('worker') as Array<{ payload: string }>
    ).map((row) => JSON.parse(row.payload) as NonNullable<ReturnType<typeof ledger.latest>>);
  const hold = () => {
    const entered = deferred();
    const gate = deferred();
    vi.mocked(needed(cm.getExecutionMetadata)).mockImplementation(async () => {
      entered.resolve();
      await gate.promise;
      return metadata;
    });
    return { entered: entered.promise, release: gate.resolve };
  };
  return {
    repo,
    pod,
    profile,
    ledger,
    record,
    reads,
    cm,
    get,
    metadata,
    resolve,
    deps,
    inspect,
    owner,
    config,
    identity,
    op,
    run,
    rows,
    hold,
    nudges,
    db: () => db,
    loseInvocation: () => {
      invocation = false;
    },
    reopen: () => {
      db.close();
      db = new Database(file);
      db.pragma('foreign_keys = ON');
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      return { rows: rows(), pod: createPodRepository(db).getOrThrow('worker') };
    },
  };
}

describe('validation provenance recorder', () => {
  it('constructs without reads, binding, probes, ownership or ledger effects; missing ledger remains an early no-op', async () => {
    const f = fixture();
    expect(f.reads).not.toHaveBeenCalled();
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.get).not.toHaveBeenCalled();
    expect(f.inspect).not.toHaveBeenCalled();
    expect(f.record).not.toHaveBeenCalled();
    f.repo.executionProvenance = undefined;
    const guard = vi.fn(() => {
      throw new Error('Not called');
    });
    await f.op.recordValidationProvenance(f.config, 'review', guard, f.identity);
    expect(guard).not.toHaveBeenCalled();
    expect(f.reads).not.toHaveBeenCalled();
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.get).not.toHaveBeenCalled();
    expect(f.reopen().rows).toEqual([]);
  });
  it.each([undefined, 'validation'] as const)(
    'keeps purpose=%s worker identity and actual execution/ledger keys',
    async (purpose) => {
      const f = fixture();
      await f.run(purpose);
      const saved = needed(f.reopen().rows[0]);
      expect(saved).toMatchObject({
        version: 1,
        purpose: 'validation',
        subject: 'worker',
        runtime: 'claude',
        model: 'worker-model',
        podId: 'worker',
        generation: f.pod.lifecycleGeneration,
        taskId: expect.any(String),
        executionId: expect.any(String),
        status: 'checked',
        imageDigest: f.metadata.imageDigest,
      });
      expect(f.resolve).toHaveBeenCalledTimes(2);
      expect(f.get).toHaveBeenCalledExactlyOnceWith('local');
      expect(f.record.mock.calls[0]?.slice(0, 2)).toEqual(['worker', f.pod.lifecycleGeneration]);
    },
  );
  it('reads the repository once without a supplied guard and retains default config null/undefined projections', async () => {
    const f = fixture();
    f.config.buildWorkDir = undefined;
    f.config.extraExecEnv = undefined;
    await f.run(undefined, false);
    expect(f.reads).toHaveBeenCalledExactlyOnceWith('worker');
    expect(f.resolve).toHaveBeenCalledOnce();
    expect(f.inspect.mock.calls[0]?.[3]).toMatchObject({ buildWorkDir: null, buildEnv: null });
    expect(f.reopen().rows).toHaveLength(1);
  });
  it('forces validation only in probe copies and records the original guarded snapshot identity', async () => {
    const f = fixture();
    const original: Pod = {
      ...f.pod,
      skipValidation: true,
      options: { ...f.pod.options, validate: false },
    };
    const afterProbe: Pod = { ...f.pod, lifecycleGeneration: f.pod.lifecycleGeneration + 1 };
    const guard = vi.fn<() => Pod>().mockReturnValueOnce(original).mockReturnValue(afterProbe);
    await f.op.recordValidationProvenance(f.config, undefined, guard);
    expect(f.inspect.mock.calls[0]?.[2]).toMatchObject({
      skipValidation: false,
      options: { validate: true },
    });
    expect(original).toMatchObject({ skipValidation: true, options: { validate: false } });
    expect(f.resolve.mock.calls.map(([snapshot]) => snapshot)).toEqual([original, afterProbe]);
    expect(f.resolve.mock.calls[0]?.[0]).toBe(original);
    expect(f.resolve.mock.calls[1]?.[0]).toBe(afterProbe);
    expect(f.reopen().rows[0]?.generation).toBe(f.pod.lifecycleGeneration);
  });
  it.each(
    (['setup', 'build', 'test', 'lint', 'sast'] as const).map((phase) => ({
      phase,
      field: phase === 'setup' ? 'validationSetupCommand' : `${phase}Command`,
    })),
  )('projects skipped $phase without changing caller inputs', async ({ phase, field }) => {
    const f = fixture();
    f.config.skipPhases = [phase];
    const original = { ...f.config };
    await f.run();
    const profile = needed(f.inspect.mock.calls[0]?.[3]);
    expect(Reflect.get(profile, field)).toBe(phase === 'build' ? '' : undefined);
    expect(f.config).toEqual(original);
    expect(f.reopen().rows).toHaveLength(1);
  });
  it.each(
    ([[], ['health'], ['pages'], ['health', 'pages']] as ValidationPhase[][]).map((skips) => ({
      skips,
    })),
  )(
    'keeps the start command for skipPhases=$skips unless both web phases are skipped',
    async ({ skips }) => {
      const f = fixture();
      f.config.skipPhases = skips;
      await f.run();
      expect(f.inspect.mock.calls[0]?.[3].startCommand).toBe(
        skips.length === 2 ? '' : 'node server.js',
      );
      expect(f.reopen().rows).toHaveLength(1);
    },
  );
  it.each([false, true])(
    'projects facts skipped=%s but records the original contract hash and env/workdir',
    async (skipped) => {
      const f = fixture();
      f.config.contract = {
        contractVersion: 1,
        title: 'Original',
        dependsOn: [],
        scenarios: [],
        requiredFacts: [
          {
            id: 'fact',
            proves: [],
            kind: 'custom-command',
            artifact: { path: 'proof.txt', change: 'create' },
            command: 'node verify.js',
          },
        ],
        humanReview: [],
      };
      f.config.skipPhases = skipped ? ['facts'] : [];
      const original = f.config.contract;
      await f.run();
      const inspected = needed(f.inspect.mock.calls[0]);
      expect(inspected[2]).toMatchObject({
        skipValidation: false,
        options: { validate: true },
        contract: { ...original, requiredFacts: skipped ? [] : original.requiredFacts },
      });
      expect(inspected[3]).toMatchObject({
        buildWorkDir: 'app',
        buildEnv: { FIXTURE_ENV: 'value' },
      });
      expect(inspected[3].buildEnv).toBe(f.config.extraExecEnv);
      expect(f.reopen().rows[0]?.contractHash).toBe(
        createHash('sha256').update(JSON.stringify(original)).digest('hex'),
      );
      expect(f.config.contract).toBe(original);
    },
  );
  it.each(['anthropic', 'openai'] as const)(
    'attributes prepared council to %s reviewer identity',
    async (provider) => {
      const f = fixture();
      f.config.councilOnly = true;
      f.config.reviewerProvider = provider;
      await f.run('review');
      expect(f.reopen().rows[0]).toMatchObject({
        purpose: 'review',
        subject: 'reviewer',
        runtime: provider === 'openai' ? 'codex' : 'claude',
        model: 'sonnet',
        providerId: provider,
        providerAccountId: 'review-account',
      });
    },
  );
  it.each(['unverified', 'unsupported'] as const)(
    'rejects %s council before probes or receipt',
    async (kind) => {
      const f = fixture();
      if (kind === 'unsupported') {
        f.config.councilOnly = true;
        f.config.reviewerProvider = 'pi';
      }
      await expect(f.run('review')).rejects.toMatchObject({
        message:
          'Independent council reviewer runtime is unsupported or unverified; reconcile its selected provider before review.',
      });
      expect(f.get).not.toHaveBeenCalled();
      expect(f.inspect).not.toHaveBeenCalled();
      expect(f.reopen().rows).toHaveLength(0);
    },
  );
  it('keeps trusted launch runtime overlay and reviewer default identity without adding a resolver consistency check', async () => {
    const f = fixture();
    f.config.reviewerModel = undefined;
    f.config.reviewerProvider = undefined;
    f.config.reviewerProviderAccountId = undefined;
    await f.run('review', true, { ...f.identity, runtime: 'codex', model: 'trusted-launch-input' });
    expect(f.reopen().rows[0]).toMatchObject({
      runtime: 'codex',
      model: 'auto',
      providerId: 'anthropic',
      providerAccountId: null,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'REVIEWER_LAUNCH_PREFLIGHT' }),
      ]),
    });
  });
  it.each(['first-prefight', 'fallback'] as const)(
    'saves blocked receipt before throwing the %s reason',
    async (kind) => {
      const f = fixture();
      f.config.councilOnly = true;
      if (kind === 'first-prefight') {
        vi.mocked(f.cm.execInContainer).mockResolvedValue({
          stdout: '',
          stderr: 'Missing CLI',
          exitCode: 1,
        });
        f.metadata.memoryLimitBytes = 1024;
      } else
        vi.mocked(f.cm.execInContainer).mockRejectedValue(
          new AutopodError('Probe unavailable', 'TRANSPORT_UNAVAILABLE', 503),
        );
      const error = await f.run('review').catch((failure) => failure);
      expect(error).toBeInstanceOf(TaskRetryBlockedError);
      const saved = needed(f.reopen().rows[0]);
      expect(saved.status).toBe('blocked');
      expect(error.message).toBe(
        kind === 'fallback'
          ? 'Validation environment requires reconciliation'
          : needed(saved.diagnostics.find((item) => item.code.startsWith('PREFLIGHT_'))).detail,
      );
    },
  );
  it.each(['ownership', 'binding', 'ledger-generation'] as const)(
    'held inspector preserves post-await %s boundary',
    async (change) => {
      const f = fixture();
      const held = f.hold();
      const error = new Error('Binding failed');
      const outcome = f.run(undefined, change !== 'ledger-generation').catch((failure) => failure);
      try {
        await held.entered;
        if (change === 'binding')
          f.resolve.mockImplementation(() => {
            throw error;
          });
        else f.repo.incrementLifecycleGeneration('worker');
      } finally {
        held.release();
      }
      const failure = await outcome;
      if (change === 'binding') expect(failure).toBe(error);
      else
        expect(failure).toMatchObject({
          code:
            change === 'ownership'
              ? 'STALE_VALIDATION_EXECUTION'
              : 'PROVENANCE_IDENTITY_UNAVAILABLE',
        });
      expect(f.record).toHaveBeenCalledTimes(change === 'ledger-generation' ? 1 : 0);
      expect(f.reopen().rows).toHaveLength(0);
    },
  );
  it.each(['replacement', 'removed'] as const)(
    'looks up a ledger %s during the inspector await',
    async (change) => {
      const f = fixture();
      const held = f.hold();
      const actual = f.ledger.record.bind(f.ledger);
      const replacement = vi.fn(actual);
      const outcome = f.run().catch((failure) => failure);
      try {
        await held.entered;
        f.repo.executionProvenance =
          change === 'removed' ? undefined : { record: replacement, latest: f.ledger.latest };
      } finally {
        held.release();
      }
      const result = await outcome;
      if (change === 'removed') {
        expect(result).toBeInstanceOf(TypeError);
        expect(f.reopen().rows).toHaveLength(0);
      } else {
        expect(result).toBeUndefined();
        expect(replacement).toHaveBeenCalledOnce();
        expect(f.reopen().rows).toHaveLength(1);
      }
    },
  );
  it.each(['profile', 'target', 'record'] as const)(
    'propagates %s errors by identity',
    async (stage) => {
      const f = fixture();
      const error = new Error(`${stage} failed`);
      if (stage === 'profile')
        f.resolve.mockImplementation(() => {
          throw error;
        });
      if (stage === 'target')
        f.get.mockImplementation(() => {
          throw error;
        });
      if (stage === 'record')
        f.record.mockImplementation(() => {
          throw error;
        });
      await expect(f.run()).rejects.toBe(error);
      expect(f.reopen().rows).toHaveLength(0);
    },
  );
  it('retains original dependency objects/functions and observes a new target method and ledger method', async () => {
    const f = fixture();
    f.deps.podRepo = {
      getOrThrow: vi.fn(() => {
        throw new Error('Replacement');
      }),
    };
    f.deps.resolveEffectiveBoundProfile = vi.fn(() => {
      throw new Error('Replacement');
    });
    const factory = f.deps.containerManagerFactory;
    f.deps.containerManagerFactory = {
      get: vi.fn(() => {
        throw new Error('Replacement');
      }),
    };
    const target = vi.fn(() => f.cm);
    factory.get = target;
    const actual = f.ledger.record.bind(f.ledger);
    const record = vi.fn(actual);
    f.ledger.record = record;
    await f.run(undefined, false);
    expect(target).toHaveBeenCalledExactlyOnceWith('local');
    expect(record).toHaveBeenCalledOnce();
    expect(f.resolve).toHaveBeenCalledOnce();
    expect(f.reopen().rows).toHaveLength(1);
  });
  it('preserves immutable successful prefix through a later real SQL insert abort and reopen', async () => {
    const f = fixture();
    await f.run();
    const first = needed(f.rows()[0]);
    expect(() =>
      f.db().prepare("UPDATE execution_provenance SET payload = '{}' WHERE id = ?").run(first.id),
    ).toThrow(/immutable/i);
    f.db().exec(
      "CREATE TRIGGER reject_provenance BEFORE INSERT ON execution_provenance BEGIN SELECT RAISE(ABORT, 'receipt insert rejected'); END",
    );
    await expect(f.run()).rejects.toThrow('receipt insert rejected');
    expect(f.reopen().rows).toEqual([first]);
  });
});

type Surface = 'selected' | 'legacy' | 'host';
function dispatch(config: ValidationEngineConfig, surface: Surface, model: string) {
  if (surface === 'selected') return config.recordReviewerApiDispatch?.(model);
  if (surface === 'legacy') return config.recordLegacyReviewerApiDispatch?.(model);
  return config.recordHostReviewerDispatch?.({
    model,
    cliPath: '/fixture/claude',
    cliVersion: '1.2.3',
    status: 'checked',
  });
}
const surfaces: Surface[] = ['selected', 'legacy', 'host'];
const hookKeys = [
  'assertReviewerCurrent',
  'recordReviewerApiDispatch',
  'recordLegacyReviewerApiDispatch',
  'recordHostReviewerDispatch',
  'beforeReviewerLaunch',
] as const;

describe('reviewer launch hooks', () => {
  it('returns a shallow copy with five overridden hooks and no eager collaborator or incoming hook calls', () => {
    const f = fixture();
    const incoming = vi.fn();
    Object.assign(f.config, Object.fromEntries(hookKeys.map((key) => [key, incoming])));
    const wrapped = f.op.withReviewerLaunchPreflight(f.config, f.owner);
    expect(wrapped).not.toBe(f.config);
    expect(wrapped.extraExecEnv).toBe(f.config.extraExecEnv);
    for (const key of hookKeys) {
      expect(wrapped[key]).toBeTypeOf('function');
      expect(wrapped[key]).not.toBe(incoming);
      expect(f.config[key]).toBe(incoming);
    }
    expect(incoming).not.toHaveBeenCalled();
    expect(f.reads).not.toHaveBeenCalled();
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.record).not.toHaveBeenCalled();
    expect(f.get).not.toHaveBeenCalled();
    expect(f.reopen().rows).toHaveLength(0);
  });
  it.each(
    (['selected', 'legacy'] as const).flatMap((surface) =>
      ['sonnet', 'custom', undefined].map((model) => ({ surface, model })),
    ),
  )('$surface records original model=$model using its own resolver', ({ surface, model }) => {
    const f = fixture();
    f.config.reviewerModel = model;
    const wrapped = f.op.withReviewerLaunchPreflight(f.config, f.owner);
    const resolved =
      model === 'sonnet'
        ? surface === 'selected'
          ? 'claude-sonnet-5-5'
          : 'claude-sonnet-4-6'
        : (model ?? 'auto');
    expect(dispatch(wrapped, surface, resolved)).toBeUndefined();
    expect(f.resolve).toHaveBeenCalledOnce();
    expect(f.reopen().rows[0]).toMatchObject({
      version: 2,
      surface: 'provider-api',
      subject: 'reviewer',
      purpose: 'review',
      runtime: null,
      model: model ?? 'auto',
      dispatchModel: resolved,
      providerId: surface === 'selected' ? 'anthropic' : null,
      providerAccountId: surface === 'selected' ? 'review-account' : null,
      cliPath: null,
      cliVersion: null,
      imageDigest: null,
    });
  });
  it.each(['checked', 'blocked'] as const)(
    'keeps host receipt status=%s without recorder-style blocked throwing',
    (status) => {
      const f = fixture();
      const wrapped = f.op.withReviewerLaunchPreflight(f.config, f.owner);
      expect(
        wrapped.recordHostReviewerDispatch?.({
          model: 'sonnet',
          cliPath: status === 'checked' ? '/fixture/claude' : null,
          cliVersion: status === 'checked' ? '1.2.3' : null,
          status,
        }),
      ).toBeUndefined();
      expect(f.reopen().rows[0]).toMatchObject({
        version: 2,
        surface: 'host-cli',
        status,
        runtime: 'claude',
        providerId: null,
        providerAccountId: null,
        model: 'sonnet',
        dispatchModel: 'sonnet',
      });
    },
  );
  it.each(
    surfaces.flatMap((surface) =>
      (['ownership', 'binding', 'model', 'ledger'] as const).map((stage) => ({ surface, stage })),
    ),
  )('$surface preserves $stage failure and its position before record', ({ surface, stage }) => {
    const f = fixture();
    const wrapped = f.op.withReviewerLaunchPreflight(f.config, f.owner);
    const error = new Error('Injected failure');
    if (stage === 'ownership')
      f.owner.assertCurrent = vi.fn(() => {
        throw error;
      });
    if (stage === 'binding')
      f.resolve.mockImplementation(() => {
        throw error;
      });
    f.repo.executionProvenance = undefined;
    const model =
      stage === 'model'
        ? 'wrong'
        : surface === 'selected'
          ? 'claude-sonnet-5-5'
          : surface === 'legacy'
            ? 'claude-sonnet-4-6'
            : 'sonnet';
    const failure = caught(() => dispatch(wrapped, surface, model));
    if (stage === 'ownership' || stage === 'binding') expect(failure).toBe(error);
    else
      expect(failure).toMatchObject({
        message:
          stage === 'model'
            ? surface === 'host'
              ? 'Host reviewer model differs from the frozen validation configuration.'
              : 'Reviewer API dispatch identity differs from the frozen validation configuration.'
            : surface === 'host'
              ? 'Host reviewer provenance ledger is unavailable; reconcile before dispatch.'
              : 'Reviewer API provenance is unavailable; reconcile the execution ledger.',
      });
    expect(f.record).not.toHaveBeenCalled();
    expect(f.resolve).toHaveBeenCalledTimes(stage === 'ownership' ? 0 : 1);
    expect(f.reopen().rows).toHaveLength(0);
  });
  it('keeps original-config capture and shared nested data instead of closing over the returned copy', () => {
    const f = fixture();
    const wrapped = f.op.withReviewerLaunchPreflight(f.config, f.owner);
    f.config.reviewerModel = 'original-next';
    wrapped.reviewerModel = 'copy-only';
    needed(f.config.extraExecEnv).ADDED = 'shared';
    dispatch(wrapped, 'selected', 'original-next');
    expect(wrapped.extraExecEnv).toEqual({ FIXTURE_ENV: 'value', ADDED: 'shared' });
    expect(f.reopen().rows[0]).toMatchObject({
      model: 'original-next',
      dispatchModel: 'original-next',
    });
  });
  it.each(['podId', 'containerId', 'runtime', 'model'] as const)(
    'rejects mismatched container %s before probing or recording',
    async (field) => {
      const f = fixture();
      const wrapped = f.op.withReviewerLaunchPreflight(f.config, f.owner);
      const identity = {
        ...f.identity,
        [field]: field === 'runtime' ? ('codex' as const) : 'different',
      };
      await expect(wrapped.beforeReviewerLaunch?.(identity)).rejects.toMatchObject({
        message: 'Reviewer launch identity differs from the frozen validation configuration.',
      });
      expect(f.resolve).toHaveBeenCalledOnce();
      expect(f.get).not.toHaveBeenCalled();
      expect(f.reopen().rows).toHaveLength(0);
    },
  );
  it('records matching container launch then returns a fresh synchronous dispatch guard', async () => {
    const f = fixture();
    const wrapped = f.op.withReviewerLaunchPreflight(f.config, f.owner);
    const guard = needed(await wrapped.beforeReviewerLaunch?.(f.identity));
    expect(f.rows()[0]).toMatchObject({
      purpose: 'review',
      subject: 'reviewer',
      runtime: 'claude',
      model: 'sonnet',
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'REVIEWER_LAUNCH_PREFLIGHT' }),
      ]),
    });
    expect(f.resolve).toHaveBeenCalledTimes(3);
    expect(guard()).toBeUndefined();
    expect(f.resolve).toHaveBeenCalledTimes(4);
    f.loseInvocation();
    expect(guard).toThrow(/superseded/i);
    expect(f.reopen().rows).toHaveLength(1);
  });
  it('holds container preflight and rejects a new pending decision before any reviewer receipt', async () => {
    const f = fixture();
    const held = f.hold();
    const wrapped = f.op.withReviewerLaunchPreflight(f.config, f.owner);
    const outcome = needed(wrapped.beforeReviewerLaunch?.(f.identity)).catch((error) => error);
    try {
      await held.entered;
      f.nudges.queue('worker', 'New decision');
    } finally {
      held.release();
    }
    expect(await outcome).toMatchObject({ code: 'STALE_VALIDATION_EXECUTION' });
    expect(f.reopen().rows).toHaveLength(0);
  });
  it.each(surfaces)(
    '%s observes live ledger replacement and propagates its method error by identity',
    (surface) => {
      const f = fixture();
      const wrapped = f.op.withReviewerLaunchPreflight(f.config, f.owner);
      const error = new Error('Receipt writer unavailable');
      const record = vi.fn(() => {
        throw error;
      });
      f.repo.executionProvenance = { record, latest: f.ledger.latest };
      expect(
        caught(() =>
          dispatch(
            wrapped,
            surface,
            surface === 'selected'
              ? 'claude-sonnet-5-5'
              : surface === 'legacy'
                ? 'claude-sonnet-4-6'
                : 'sonnet',
          ),
        ),
      ).toBe(error);
      expect(record).toHaveBeenCalledOnce();
      expect(f.reopen().rows).toHaveLength(0);
    },
  );
  it('assertReviewerCurrent rechecks binding on every call without recording', () => {
    const f = fixture();
    const wrapped = f.op.withReviewerLaunchPreflight(f.config, f.owner);
    wrapped.assertReviewerCurrent?.();
    const error = new Error('Binding changed');
    f.resolve.mockImplementation(() => {
      throw error;
    });
    expect(caught(() => wrapped.assertReviewerCurrent?.())).toBe(error);
    expect(f.resolve).toHaveBeenCalledTimes(2);
    expect(f.reopen().rows).toHaveLength(0);
  });
});
