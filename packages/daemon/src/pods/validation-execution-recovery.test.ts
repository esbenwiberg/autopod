import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../test-utils/mock-helpers.js';
import { validationRecoveryFixture } from '../test-utils/validation-recovery-helpers.js';
import { writeArtifactSnapshotReceipt } from './artifact-snapshot-receipt.js';
import { createEventBus } from './event-bus.js';
import { createEventRepository } from './event-repository.js';
import { createPodRepository } from './pod-repository.js';
import { sourcePodFingerprint } from './source-adoption-repository.js';
import { validationResultHash } from './validation-execution-ledger.js';
import { createValidationExecutionRecovery } from './validation-execution-recovery.js';
import { createValidationPublication } from './validation-publication.js';
import { assertValidationExecutionSettled } from './validation-recovery-policy.js';
import { createValidationRepository } from './validation-repository.js';

const actor = { type: 'human' as const, userId: 'operator' };
const resource = '11111111-1111-4111-8111-111111111111';
const identity = {
  source: 'a'.repeat(64),
  contract: 'b'.repeat(64),
  commands: 'c'.repeat(64),
  environment: null,
  implementation: null,
};
const reason = 'Preserve the original failed tests and settle exact resource';
const fixtures: ReturnType<typeof validationRecoveryFixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.db.close();
  vi.useRealTimers();
});
function fixture(legacy = false, legacyResultShape = false, publish = true, dataDir?: string) {
  const f = validationRecoveryFixture();
  fixtures.push(f);
  f.podRepo.update(f.podId, { containerId: null });
  f.podRepo.update(f.podId, {
    executionTarget: 'sandbox',
    containerId: resource,
    status: 'validating',
  });
  const ledger = f.podRepo.validationExecutions!;
  const admission = f.podRepo.taskRetries!.admit(
    f.podId,
    f.podRepo.getOrThrow(f.podId).lifecycleGeneration,
    identity,
    'd'.repeat(64),
    [],
  );
  f.podRepo.taskRetries!.start(admission.id);
  const dispatch = legacy
    ? null
    : ledger.dispatch(f.podRepo.getOrThrow(f.podId), admission.id, 1, 'test-scope');
  const result = {
    ...f.result,
    attempt: 1,
    ...(dispatch && !legacyResultShape ? { executionDispatchId: dispatch } : {}),
    test: {
      status: 'fail' as const,
      duration: 600751,
      stdout: 'Actual assertion failed at 9638ms',
    },
    infrastructureFailure: {
      phase: 'test' as const,
      code: 'EXEC_EXIT_UNVERIFIED',
      message: 'Streaming exit unverified',
      retryable: false,
    },
  };
  if (dispatch && publish) ledger.recordResult(result, dispatch);
  f.podRepo.taskRetries!.finish(admission.id, 'nonretryable', 600751);
  f.podRepo.update(f.podId, { status: 'review_required', lastValidationResult: result });
  const cm = f.containerManager;
  Object.assign(cm, { executionResourceScope: 'test-scope' });
  vi.mocked(cm.getStatus).mockResolvedValue('running');
  vi.mocked(cm.kill).mockImplementation(async () => {
    vi.mocked(cm.getStatus).mockResolvedValue('deleted');
  });
  let active = false;
  const create = () =>
    createValidationExecutionRecovery({
      podRepo: f.podRepo,
      getContainerManager: () => cm,
      isActive: () => active,
      dataDir,
    });
  const recovery = create();
  return {
    ...f,
    ledger,
    admission,
    dispatch,
    result,
    recovery,
    create,
    setActive: (value: boolean) => {
      active = value;
    },
    input: {
      expectedGeneration: f.podRepo.getOrThrow(f.podId).lifecycleGeneration,
      expectedResultHash: validationResultHash(result),
      reason,
    },
  };
}
async function expectProviderBlocked(f: ReturnType<typeof fixture>, recovery = f.recovery) {
  const before = f.podRepo.getOrThrow(f.podId);
  const retries = f.podRepo.taskRetries?.state(f.podId);
  const intents = f.db.prepare('SELECT * FROM validation_recovery_intents').all();
  await expect(
    recovery.reconcileValidationExecution(f.podId, f.input, actor),
  ).rejects.toMatchObject({ code: 'VALIDATION_FINAL_CONTENT_UNVERIFIED' });
  expect(f.podRepo.getOrThrow(f.podId)).toEqual(before);
  expect(f.podRepo.taskRetries?.state(f.podId)).toEqual(retries);
  expect(f.db.prepare('SELECT * FROM validation_recovery_intents').all()).toEqual(intents);
  expect(f.containerManager.getStatus).not.toHaveBeenCalled();
  expect(f.containerManager.start).not.toHaveBeenCalled();
  expect(f.containerManager.execInContainer).not.toHaveBeenCalled();
  expect(f.containerManager.extractDirectoryFromContainer).not.toHaveBeenCalled();
  expect(f.containerManager.kill).not.toHaveBeenCalled();
  expect(f.worktreeManager.cleanup).not.toHaveBeenCalled();
  expect(f.runtime.spawn).not.toHaveBeenCalled();
}
describe('exact validation execution recovery', () => {
  it('rolls back durable completion event insertion failure and publishes exactly once after restart', async () => {
    const f = fixture(false, false, false);
    if (!f.dispatch) throw new Error('Missing dispatch');
    f.ledger.recordOutcome(f.result, f.dispatch);
    const history = createValidationRepository(f.db);
    const events = createEventRepository(f.db);
    const bus = createEventBus(events, logger);
    const pub = createValidationPublication({
      podRepo: f.podRepo,
      validationRepo: history,
      eventBus: bus,
    });
    const observed: boolean[] = [];
    bus.subscribe((event) => {
      if (event.type === 'pod.validation_completed') observed.push(f.db.inTransaction);
    });
    f.db.exec(
      `CREATE TRIGGER fail_completion_event BEFORE INSERT ON events WHEN NEW.type='pod.validation_completed' BEGIN SELECT RAISE(ABORT,'event insert failed'); END;`,
    );
    expect(() => pub.publishValidationResult(f.podId, 1, f.result)).toThrow('event insert failed');
    expect(history.getForSession(f.podId)).toHaveLength(0);
    expect(f.db.prepare('SELECT * FROM validation_logical_publications').all()).toEqual([]);
    expect(observed).toEqual([]);
    f.db.exec('DROP TRIGGER fail_completion_event');
    const root = await mkdtemp(path.join(os.tmpdir(), 'validation-event-restart-'));
    try {
      const file = path.join(root, 'state.db');
      await writeFile(file, f.db.serialize());
      const restarted = new Database(file);
      try {
        const repo = createPodRepository(restarted);
        const saved = createValidationRepository(restarted);
        const savedEvents = createEventRepository(restarted);
        const eventBus = createEventBus(savedEvents, logger);
        const send = createValidationPublication({
          podRepo: repo,
          validationRepo: saved,
          eventBus,
        });
        let broadcasts = 0;
        eventBus.subscribe((event) => {
          if (event.type === 'pod.validation_completed') {
            expect(restarted.inTransaction).toBe(false);
            expect(saved.getForSession(f.podId)).toHaveLength(1);
            broadcasts++;
          }
        });
        send.publishValidationResult(f.podId, 1, f.result);
        send.publishValidationResult(f.podId, 1, f.result);
        expect(saved.getForSession(f.podId)).toHaveLength(1);
        expect(savedEvents.countForSession(f.podId, 'pod.validation_completed')).toBe(1);
        expect(broadcasts).toBe(1);
      } finally {
        restarted.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retains a durable completion event across a crash before broadcast without duplicate replay publication', async () => {
    const f = fixture(false, false, false);
    if (!f.dispatch) throw new Error('Missing dispatch');
    f.ledger.recordOutcome(f.result, f.dispatch);
    const events = createEventRepository(f.db);
    const history = createValidationRepository(f.db);
    const bus = createEventBus(events, logger);
    let broadcasts = 0;
    bus.subscribe((event) => {
      if (event.type === 'pod.validation_completed') broadcasts++;
    });
    const after = f.podRepo.afterCommit;
    if (!after) throw new Error('Missing transactional authority');
    vi.spyOn(f.podRepo, 'afterCommit').mockImplementation((effect) =>
      after(() => {
        /* Simulated process exit: committed row survives, broadcast does not. */ void effect;
      }),
    );
    createValidationPublication({
      podRepo: f.podRepo,
      validationRepo: history,
      eventBus: bus,
    }).publishValidationResult(f.podId, 1, f.result);
    expect(broadcasts).toBe(0);
    expect(events.countForSession(f.podId, 'pod.validation_completed')).toBe(1);
    const root = await mkdtemp(path.join(os.tmpdir(), 'completion-broadcast-restart-'));
    try {
      const file = path.join(root, 'state.db');
      await writeFile(file, f.db.serialize());
      const db = new Database(file);
      try {
        const repo = createPodRepository(db);
        const saved = createValidationRepository(db);
        const replay = createEventRepository(db);
        const eventBus = createEventBus(replay, logger);
        createValidationPublication({
          podRepo: repo,
          validationRepo: saved,
          eventBus,
        }).publishValidationResult(f.podId, 1, f.result);
        const completions = replay
          .getSince(0)
          .filter((event) => event.type === 'pod.validation_completed');
        expect(completions).toHaveLength(1);
        expect(completions[0]?.payload).toMatchObject({ podId: f.podId, result: f.result });
        expect(saved.getForSession(f.podId)).toHaveLength(1);
      } finally {
        db.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accounts immutable intermediate dispatch evidence without duplicating logical history or completion events', () => {
    const f = fixture(false, false, false);
    if (!f.dispatch) throw new Error('Missing dispatch');
    const result = {
      ...f.result,
      infrastructureFailure: {
        phase: 'test' as const,
        code: 'RETRYABLE_SERVICE_FAILURE',
        message: 'Measured completed retryable failure',
        retryable: true,
      },
      reviewTokenUsage: { inputTokens: 11, outputTokens: 7 },
    };
    f.podRepo.update(f.podId, { lastValidationResult: null });
    f.ledger.recordOutcome(result, f.dispatch);
    const emit = vi.fn();
    const eventBus = {
      emit,
      emitAfterCommit: (
        event: Parameters<typeof emit>[0],
        schedule: (effect: () => void) => void,
      ) => {
        schedule(() => emit(event));
        return 1;
      },
    };
    const history = createValidationRepository(f.db);
    const pub = createValidationPublication({
      podRepo: f.podRepo,
      validationRepo: history,
      eventBus,
    });
    pub.publishValidationResult(f.podId, 1, result, { intermediate: true });
    pub.publishValidationResult(f.podId, 1, result, { intermediate: true });
    expect(history.getForSession(f.podId)).toHaveLength(0);
    expect(f.podRepo.getOrThrow(f.podId)).toMatchObject({
      lastValidationResult: null,
      phaseTokenUsage: { review: { inputTokens: 11, outputTokens: 7 } },
    });
    expect(eventBus.emit).not.toHaveBeenCalled();
    expect(f.ledger.evidence(f.podId, f.dispatch, validationResultHash(result)).result).toEqual(
      result,
    );
    expect(() => f.ledger.assertTaskSettled(f.podId)).not.toThrow();
    vi.spyOn(history, 'insert').mockImplementationOnce(() => {
      throw new Error('Logical history insert failed');
    });
    expect(() => pub.publishValidationResult(f.podId, 1, result)).toThrow(
      'Logical history insert failed',
    );
    expect(f.db.prepare('SELECT * FROM validation_logical_publications').all()).toEqual([]);
    expect(f.podRepo.getOrThrow(f.podId).lastValidationResult).toBeNull();
    pub.publishValidationResult(f.podId, 1, result);
    pub.publishValidationResult(f.podId, 1, result);
    expect(history.getForSession(f.podId)).toHaveLength(1);
    expect(eventBus.emit).toHaveBeenCalledTimes(1);
    expect(f.podRepo.getOrThrow(f.podId).phaseTokenUsage?.review).toMatchObject({
      inputTokens: 11,
      outputTokens: 7,
    });
    expect(f.db.prepare('SELECT * FROM validation_dispatch_outcomes').all()).toHaveLength(1);
    expect(f.db.prepare('SELECT * FROM validation_logical_publications').all()).toHaveLength(1);
  });

  it('serves the exact immutable unpublished outcome without publishing or settling it', async () => {
    const f = fixture(false, false, false);
    if (!f.dispatch) throw new Error('Missing dispatch');
    f.ledger.recordOutcome(f.result, f.dispatch);
    f.podRepo.update(f.podId, { lastValidationResult: null });
    const before = f.podRepo.getOrThrow(f.podId);
    const evidence = await f.manager.readValidationEvidence(
      f.podId,
      f.dispatch,
      validationResultHash(f.result),
    );
    expect(evidence).toMatchObject({ evidenceKind: 'outcome', result: f.result });
    expect(f.podRepo.getOrThrow(f.podId)).toEqual(before);
    expect(
      f.db.prepare('SELECT * FROM validation_dispatch_results WHERE dispatch_id=?').all(f.dispatch),
    ).toEqual([]);
    expect(() => f.ledger.assertTaskSettled(f.podId)).toThrow();
    await expect(
      f.manager.readValidationEvidence(f.podId, f.dispatch, 'a'.repeat(64)),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('keeps failed-task validation custody when active-only dispatch preflight admits the same request', () => {
    const f = fixture();
    f.podRepo.update(f.podId, { status: 'failed' });
    const execution = f.db
      .prepare('SELECT task_id,execution_id FROM task_executions WHERE pod_id=?')
      .get(f.podId);
    const retries = f.podRepo.taskRetries?.state(f.podId);
    const preflight = f.podRepo.dispatchPreflight;
    if (!preflight) throw new Error('Missing dispatch preflight fixture');
    expect(
      preflight.inspect(
        f.podId,
        f.input.expectedGeneration,
        'https://github.com/org/repo',
        'main',
        'a'.repeat(40),
      ),
    ).toMatchObject({ status: 'admitted', conflicts: [] });
    expect(() => f.ledger.assertTaskSettled(f.podId)).toThrow('termination is unverified');
    expect(() => f.manager.assertCanRework(f.podId)).toThrow();
    expect(
      f.db.prepare('SELECT task_id,execution_id FROM task_executions WHERE pod_id=?').get(f.podId),
    ).toEqual(execution);
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM task_executions').get()).toEqual({
      count: 1,
    });
    expect(f.podRepo.taskRetries?.state(f.podId)).toEqual(retries);
    expect(f.podRepo.getOrThrow(f.podId).lastValidationResult).toEqual(f.result);
    expect(f.podRepo.listReferencedContainerIds()).toContain(resource);
    expect(f.containerManager.kill).not.toHaveBeenCalled();
  });
  it('does not release missing publication if durable publication fails after recording a normal outcome', () => {
    const f = fixture(false, false, false);
    const result = { ...f.result, infrastructureFailure: undefined };
    f.podRepo.update(f.podId, { lastValidationResult: null });
    f.ledger.recordOutcome(result, f.dispatch!);
    const emit = vi.fn();
    const eventBus = {
      emit,
      emitAfterCommit: (
        event: Parameters<typeof emit>[0],
        schedule: (effect: () => void) => void,
      ) => {
        schedule(() => emit(event));
        return 1;
      },
    };
    const publication = createValidationPublication({ podRepo: f.podRepo, eventBus });
    vi.spyOn(f.podRepo, 'update').mockImplementationOnce(() => {
      throw new Error('Interrupted publication');
    });
    expect(() => publication.publishValidationResult(f.podId, 1, result)).toThrow(
      'Interrupted publication',
    );
    expect(
      f.db.prepare('SELECT * FROM validation_dispatch_results WHERE dispatch_id=?').all(f.dispatch),
    ).toEqual([]);
    expect(f.ledger.unsettled(f.podId)).not.toBeNull();
    expect(eventBus.emit).not.toHaveBeenCalled();
  });
  it('serves immutable ignored reports after container loss and repair worktree drift', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'validation-evidence-access-'));
    vi.stubEnv('DATA_DIR', dir);
    try {
      const f = fixture(false, false, true, dir);
      const root = path.join(dir, 'validation-recovery', f.podId);
      const snapshot = path.join(root, `generation-${f.input.expectedGeneration}-${randomUUID()}`);
      await mkdir(path.join(snapshot, 'reports'), { recursive: true });
      await writeFile(path.join(snapshot, 'reports/failure.txt'), 'original failed assertion');
      await symlink('/etc/passwd', path.join(snapshot, 'outside'));
      await writeArtifactSnapshotReceipt(snapshot, snapshot, f.input.expectedGeneration, 0);
      f.ledger.begin(f.podRepo.getOrThrow(f.podId), actor, reason);
      f.ledger.preserve(f.dispatch!, { snapshot, checkpointCommit: 'a'.repeat(40) });
      // Historical source drift is not evidence rebinding. Simulate the retained
      // post-recovery row directly while preserving immutable dispatch/intents.
      f.db
        .prepare('UPDATE pods SET container_id=NULL,worktree_path=? WHERE id=?')
        .run('/replacement-worktree', f.podId);
      const read = (file?: string) =>
        f.manager.readValidationEvidence(f.podId, f.dispatch!, f.input.expectedResultHash, file);
      expect(await read('reports/failure.txt')).toMatchObject({
        content: Buffer.from('original failed assertion').toString('base64'),
        encoding: 'base64',
      });
      for (const file of [
        '../secret',
        '/etc/passwd',
        'outside',
        `reports${String.fromCharCode(92)}failure.txt`,
        `reports${String.fromCharCode(0)}failure.txt`,
      ])
        await expect(read(file)).rejects.toThrow();
      await expect(
        f.recovery.readValidationEvidence(f.podId, f.dispatch!, '0'.repeat(64)),
      ).rejects.toThrow();
      await expect(
        f.recovery.readValidationEvidence('another-pod', f.dispatch!, f.input.expectedResultHash),
      ).rejects.toThrow();
      await writeFile(path.join(snapshot, 'reports/failure.txt'), 'tampered');
      await expect(read('reports/failure.txt')).rejects.toThrow();
    } finally {
      vi.unstubAllEnvs();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('cannot delete when the unknown execution writes reports after export', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'validation-report-race-'));
    try {
      const f = fixture(false, false, true, dir);
      const original = path.join(dir, 'live-report.txt');
      const snapshot = path.join(
        dir,
        'validation-recovery',
        f.podId,
        `generation-${f.input.expectedGeneration}-${randomUUID()}`,
      );
      await mkdir(snapshot, { recursive: true });
      await writeFile(original, 'partial');
      await copyFile(original, path.join(snapshot, 'report.txt'));
      await writeArtifactSnapshotReceipt(snapshot, snapshot, f.input.expectedGeneration, 0);
      f.ledger.begin(f.podRepo.getOrThrow(f.podId), actor, reason);
      f.ledger.preserve(f.dispatch!, { snapshot, checkpointCommit: 'a'.repeat(40) });
      // Real filesystem write after the inventory receipt has been committed.
      await writeFile(original, 'late failed assertion');
      vi.mocked(f.containerManager.kill).mockImplementation(async () => {
        await rm(original);
      });
      await expectProviderBlocked(f);
      expect(await readFile(original, 'utf8')).toBe('late failed assertion');
      expect(await readFile(path.join(snapshot, 'report.txt'), 'utf8')).toBe('partial');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('cannot reuse an older export after restart without final-content proof', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'validation-report-restart-'));
    try {
      const f = fixture(false, false, true, dir);
      const original = path.join(dir, 'live-report.txt');
      const snapshot = path.join(
        dir,
        'validation-recovery',
        f.podId,
        `generation-${f.input.expectedGeneration}-${randomUUID()}`,
      );
      await mkdir(snapshot, { recursive: true });
      await writeFile(original, 'partial before restart');
      await copyFile(original, path.join(snapshot, 'report.txt'));
      await writeArtifactSnapshotReceipt(snapshot, snapshot, f.input.expectedGeneration, 0);
      f.ledger.begin(f.podRepo.getOrThrow(f.podId), actor, reason);
      f.ledger.preserve(f.dispatch!, { snapshot, checkpointCommit: 'a'.repeat(40) });
      const restarted = f.create();
      await writeFile(original, 'failed assertion after restart');
      vi.mocked(f.containerManager.kill).mockImplementation(async () => {
        await rm(original);
      });
      await expectProviderBlocked(f, restarted);
      expect(await readFile(original, 'utf8')).toBe('failed assertion after restart');
      expect(await readFile(path.join(snapshot, 'report.txt'), 'utf8')).toBe(
        'partial before restart',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('blocks Kill for a dispatch with neither returned outcome nor published result', async () => {
    const f = fixture(false, false, false);
    f.podRepo.update(f.podId, { lastValidationResult: null });
    await expect(f.manager.killSession(f.podId)).rejects.toMatchObject({
      code: 'VALIDATION_EXECUTION_UNVERIFIED',
    });
    expect(f.containerManager.kill).not.toHaveBeenCalled();
    expect(f.worktreeManager.cleanup).not.toHaveBeenCalled();
  });
  it.each([undefined, 'AZURE_SANDBOX_EXEC_INVALID_RESPONSE'])(
    'retains unpublished outcomes independently of termination classification (%s)',
    (code) => {
      const f = fixture(false, false, false);
      f.ledger.recordOutcome(
        {
          ...f.result,
          infrastructureFailure: code
            ? { phase: 'test', code, message: 'No valid exit', retryable: false }
            : undefined,
        },
        f.dispatch!,
      );
      expect(f.ledger.unsettled(f.podId)).not.toBeNull();
      expect(() => f.ledger.assertTaskSettled(f.podId)).toThrow();
    },
  );
  it('ordinary Delete/Kill and direct deletion admission cannot bypass source/report preservation', async () => {
    const f = fixture();
    await expect(f.manager.deleteSession(f.podId)).rejects.toMatchObject({
      code: 'VALIDATION_EXECUTION_UNVERIFIED',
    });
    await expect(f.manager.killSession(f.podId)).rejects.toMatchObject({
      code: 'VALIDATION_EXECUTION_UNVERIFIED',
    });
    expect(() => f.podRepo.deletionOwnership?.acquire(f.podId, 'unsafe-delete')).toThrow(
      'termination is unverified',
    );
    expect(() => f.podRepo.delete(f.podId)).toThrow('termination is unverified');
    expect(f.containerManager.kill).not.toHaveBeenCalled();
    expect(f.worktreeManager.cleanup).not.toHaveBeenCalled();
    expect(f.podRepo.getOrThrow(f.podId).lastValidationResult).toEqual(f.result);
  });
  it('rejects another pod, attempt or dispatch ID before recording result evidence', () => {
    const f = fixture();
    for (const result of [
      { ...f.result, podId: 'another-pod' },
      { ...f.result, attempt: 99 },
      { ...f.result, executionDispatchId: 'another-dispatch' },
    ]) {
      expect(() => f.ledger.recordResult(result, f.dispatch ?? 'missing')).toThrow(
        'exact dispatch identity',
      );
    }
    expect(f.podRepo.getOrThrow(f.podId).lastValidationResult).toEqual(f.result);
  });
  it('does not confuse its facade reconciliation request with another active control', async () => {
    const f = fixture();
    await expect(
      f.manager.reconcileValidationExecution(f.podId, f.input, actor),
    ).rejects.toMatchObject({ code: 'VALIDATION_FINAL_CONTENT_UNVERIFIED' });
    expect(f.containerManager.getStatus).not.toHaveBeenCalled();
    expect(f.containerManager.kill).not.toHaveBeenCalled();
  });
  it('preserves source adoption custody instead of deleting its original reports', async () => {
    const f = fixture();
    const pod = f.podRepo.getOrThrow(f.podId);
    f.podRepo.sourceAdoptions?.claim(
      'source-owner',
      f.podId,
      {
        generation: pod.lifecycleGeneration,
        fingerprint: sourcePodFingerprint(pod),
        repository: 'https://github.com/org/repo',
        branch: pod.branch,
        baseBranch: 'main',
        containerId: resource,
        resourceKey: 'test-scope',
        worktreePath: pod.worktreePath ?? '',
        oldHead: 'a'.repeat(40),
        targetHead: 'b'.repeat(40),
      },
      actor,
      reason,
      () => {},
    );
    expect(f.recovery.getValidationExecutionRecovery(f.podId)).toMatchObject({ allowed: false });
    await expect(f.recovery.reconcileValidationExecution(f.podId, f.input, actor)).rejects.toThrow(
      'Source adoption',
    );
    expect(() => f.ledger.begin(pod, actor, reason)).toThrow('Source adoption');
    expect(f.containerManager.execInContainer).not.toHaveBeenCalled();
    expect(f.containerManager.kill).not.toHaveBeenCalled();
  });
  it('cannot settle or replay an outcome-unknown sandbox wakeup', async () => {
    const f = fixture();
    const wakeups = f.podRepo.sandboxWakeups;
    if (!wakeups) throw new Error('Missing wakeup journal');
    wakeups.observeRunning('test-scope', resource);
    const wakeup = wakeups.claim('test-scope', resource, f.podId);
    wakeups.beginDispatch(wakeup.id);
    await expect(
      f.recovery.reconcileValidationExecution(f.podId, f.input, actor),
    ).rejects.toMatchObject({ code: 'SANDBOX_WAKEUP_OUTCOME_UNVERIFIED' });
    expect(() => f.ledger.begin(f.podRepo.getOrThrow(f.podId), actor, reason)).toThrow(
      'unresolved wakeup',
    );
    expect(f.containerManager.start).not.toHaveBeenCalled();
    expect(f.containerManager.kill).not.toHaveBeenCalled();
  });
  it('retains the immutable validation resource after its current pointer is cleared', async () => {
    const f = fixture();
    f.podRepo.update(f.podId, { containerId: null });
    expect(f.podRepo.listReferencedContainerIds()).toContain(resource);
    await expectProviderBlocked(f);
    expect(f.podRepo.listReferencedContainerIds()).toContain(resource);
  });
  it('rechecks competing deletion ownership in the durable acquisition transaction', () => {
    const f = fixture();
    const pod = f.podRepo.getOrThrow(f.podId);
    // Retained pre-feature deletion ownership must still fence reconciliation.
    f.db
      .prepare(`INSERT INTO deletion_cleanup_intents(id,pod_id,task_id,identity,created_at)
      SELECT 'legacy-cleanup',pod_id,task_id,'legacy-identity','now' FROM task_executions WHERE pod_id=?`)
      .run(f.podId);
    expect(() => f.ledger.begin(pod, actor, reason)).toThrow();
    expect(f.ledger.intent(f.dispatch ?? 'missing')).toBeNull();
  });
  it('refuses a stale pod snapshot at durable acquisition', () => {
    const f = fixture();
    const pod = f.podRepo.getOrThrow(f.podId);
    f.podRepo.update(f.podId, { status: 'running' });
    expect(() => f.ledger.begin(pod, actor, reason)).toThrow('Pod changed');
    expect(f.ledger.intent(f.dispatch ?? 'missing')).toBeNull();
  });
  it('cannot use a restored source checkpoint alone as final-content proof after restart', async () => {
    const f = fixture();
    f.ledger.begin(f.podRepo.getOrThrow(f.podId), actor, reason);
    f.ledger.preserve(f.dispatch!, {
      snapshot: '/retained/old-export',
      checkpointCommit: 'a'.repeat(40),
    });
    await expectProviderBlocked(f, f.create());
    expect(f.ledger.isSettled(f.podRepo.getOrThrow(f.podId))).toBe(false);
  });
  it('does not apply a selected test budget to another failed result', () => {
    const f = fixture();
    f.recovery.authorizeValidationRecoveryBudget(
      f.podId,
      { ...f.input, testTimeoutSeconds: 900 },
      actor,
    );
    f.podRepo.update(f.podId, { lastValidationResult: { ...f.result, duration: 99 } });
    expect(f.ledger.budget(f.podRepo.getOrThrow(f.podId))).toBeNull();
    expect(f.ledger.budgets(f.podId)).toHaveLength(1);
  });
  it('GET is read-only, including legacy incident with missing execution metadata', () => {
    const f = fixture(true);
    const state = f.recovery.getValidationExecutionRecovery(f.podId);
    expect(state).toMatchObject({
      required: true,
      allowed: false,
      settled: false,
      code: 'VALIDATION_LEGACY_OWNERSHIP_UNAVAILABLE',
    });
    expect(f.containerManager.getStatus).not.toHaveBeenCalled();
    expect(f.containerManager.kill).not.toHaveBeenCalled();
    expect(f.containerManager.execInContainer).not.toHaveBeenCalled();
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM validation_recovery_intents').get()).toEqual(
      { count: 0 },
    );
  });
  it('preserves original failures, output, admission and usage without inventing settlement', async () => {
    const f = fixture();
    await expectProviderBlocked(f);
    expect(f.podRepo.getOrThrow(f.podId)).toMatchObject({
      containerId: resource,
      lastValidationResult: f.result,
    });
    expect(f.recovery.getValidationExecutionRecovery(f.podId)).toMatchObject({
      allowed: false,
      settled: false,
      receipt: null,
      code: 'VALIDATION_FINAL_CONTENT_UNVERIFIED',
    });
    expect(() =>
      assertValidationExecutionSettled(
        f.podRepo.getOrThrow(f.podId),
        f.ledger.isSettled(f.podRepo.getOrThrow(f.podId)),
      ),
    ).toThrow('termination is unverified');
    await expectProviderBlocked(f);
  });
  it('does not infer ownership from a current replacement container', async () => {
    const f = fixture();
    f.podRepo.update(f.podId, { containerId: '00000000-0000-0000-0000-000000000001' });
    await expect(
      f.recovery.reconcileValidationExecution(f.podId, f.input, actor),
    ).rejects.toMatchObject({ code: 'VALIDATION_DISPATCH_BINDING_CHANGED' });
    expect(f.containerManager.kill).not.toHaveBeenCalled();
  });
  it.each(['unknown', 'deleted'] as const)(
    'fails closed on %s before preservation',
    async (status) => {
      const f = fixture();
      vi.mocked(f.containerManager.getStatus).mockResolvedValue(status);
      await expect(
        f.recovery.reconcileValidationExecution(f.podId, f.input, actor),
      ).rejects.toMatchObject({ code: 'VALIDATION_FINAL_CONTENT_UNVERIFIED' });
      expect(f.containerManager.kill).not.toHaveBeenCalled();
      expect(f.containerManager.getStatus).not.toHaveBeenCalled();
      expect(() => f.ledger.assertTaskSettled(f.podId)).toThrow();
    },
  );
  it('does not treat stopped/suspended as termination or blindly resume for export', async () => {
    const f = fixture();
    vi.mocked(f.containerManager.getStatus).mockResolvedValue('stopped');
    await expectProviderBlocked(f);
  });
  it('retains the sandbox and task fence when a saved export is unverified', async () => {
    const f = fixture();
    f.ledger.begin(f.podRepo.getOrThrow(f.podId), actor, reason);
    f.ledger.preserve(f.dispatch!, {
      snapshot: '/missing/export',
      checkpointCommit: 'a'.repeat(40),
    });
    await expectProviderBlocked(f);
    await expect(
      f.recovery.readValidationEvidence(
        f.podId,
        f.dispatch!,
        f.input.expectedResultHash,
        'report.xml',
      ),
    ).rejects.toThrow();
    expect(() => f.manager.assertCanRework(f.podId)).toThrow();
  });
  it('retains a lost deletion outcome across restart without repeating mutation or claiming final content', async () => {
    const f = fixture();
    f.ledger.begin(f.podRepo.getOrThrow(f.podId), actor, reason);
    f.ledger.preserve(f.dispatch!, {
      snapshot: '/retained/old-export',
      checkpointCommit: 'a'.repeat(40),
    });
    f.db
      .prepare('UPDATE validation_recovery_intents SET deletion_started_at=? WHERE dispatch_id=?')
      .run(new Date().toISOString(), f.dispatch);
    expect(f.recovery.getValidationExecutionRecovery(f.podId).operation).toBe(
      'deletion-outcome-pending',
    );
    await expectProviderBlocked(f, f.create());
    vi.mocked(f.containerManager.getStatus).mockResolvedValue('deleted');
    await expectProviderBlocked(f, f.create());
    expect(f.recovery.getValidationExecutionRecovery(f.podId).settled).toBe(false);
  });
  it('rejects simultaneous requests without creating intents, receipts, checks or workers', async () => {
    const f = fixture();
    const responses = await Promise.allSettled([
      f.recovery.reconcileValidationExecution(f.podId, f.input, actor),
      f.recovery.reconcileValidationExecution(f.podId, f.input, {
        type: 'human',
        userId: 'second',
      }),
    ]);
    for (const response of responses)
      expect(response).toMatchObject({
        status: 'rejected',
        reason: { code: 'VALIDATION_FINAL_CONTENT_UNVERIFIED' },
      });
    expect(f.ledger.intent(f.dispatch!)).toBeNull();
    await expectProviderBlocked(f);
  });
  it('rejects active execution, stale hash/generation, invalid reason and nonhuman actor', async () => {
    const f = fixture();
    for (const input of [
      { ...f.input, expectedGeneration: 999 },
      { ...f.input, expectedResultHash: 'f'.repeat(64) },
      { ...f.input, reason: 'short' },
    ])
      await expect(
        f.recovery.reconcileValidationExecution(f.podId, input, actor),
      ).rejects.toThrow();
    await expect(
      f.recovery.reconcileValidationExecution(f.podId, f.input, { type: 'human', userId: ' ' }),
    ).rejects.toThrow();
    f.setActive(true);
    await expect(f.recovery.reconcileValidationExecution(f.podId, f.input, actor)).rejects.toThrow(
      'no active worker',
    );
    expect(f.containerManager.kill).not.toHaveBeenCalled();
  });
  it('rejects a result changed after dispatch and preserves all original proof', async () => {
    const f = fixture();
    f.podRepo.update(f.podId, { lastValidationResult: { ...f.result, duration: 99 } });
    expect(f.recovery.getValidationExecutionRecovery(f.podId)).toMatchObject({
      allowed: false,
      settled: false,
    });
    expect(f.ledger.intent(f.dispatch!)).toBeNull();
  });
  it('allows a narrow finite budget without changing frozen settings or granting retries, then consumes it once', () => {
    const f = fixture();
    const before = f.podRepo.getOrThrow(f.podId).profileSnapshot;
    const selected = f.recovery.authorizeValidationRecoveryBudget(
      f.podId,
      { ...f.input, testTimeoutSeconds: 900 },
      actor,
    );
    expect(selected).toMatchObject({ seconds: 900 });
    expect(f.ledger.budget(f.podRepo.getOrThrow(f.podId))).toMatchObject({ seconds: 900 });
    expect(f.podRepo.getOrThrow(f.podId).profileSnapshot).toEqual(before);
    expect(f.podRepo.taskRetries!.state(f.podId).authorizations).toHaveLength(0);
    const budget = f.ledger.budget(f.podRepo.getOrThrow(f.podId))!;
    f.ledger.consumeBudget(budget.id, f.dispatch!);
    expect(f.ledger.budget(f.podRepo.getOrThrow(f.podId))).toBeNull();
    expect(() => f.ledger.consumeBudget(budget.id, f.dispatch!)).toThrow();
  });
  it('expires a one-shot finite budget and rejects infinite, fractional and oversized values', () => {
    const f = fixture();
    for (const seconds of [0, Number.POSITIVE_INFINITY, 900.1, 3601])
      expect(() =>
        f.recovery.authorizeValidationRecoveryBudget(
          f.podId,
          { ...f.input, testTimeoutSeconds: seconds },
          actor,
        ),
      ).toThrow();
    vi.useFakeTimers();
    f.recovery.authorizeValidationRecoveryBudget(
      f.podId,
      { ...f.input, testTimeoutSeconds: 900 },
      actor,
    );
    vi.advanceTimersByTime(3600001);
    expect(f.ledger.budget(f.podRepo.getOrThrow(f.podId))).toBeNull();
  });
  it('keeps an incomplete source checkpoint fenced across restart instead of replaying it', async () => {
    const f = fixture();
    f.ledger.begin(f.podRepo.getOrThrow(f.podId), actor, reason);
    f.ledger.claimPreservation(f.dispatch!);
    await expect(
      f.create().reconcileValidationExecution(f.podId, f.input, actor),
    ).rejects.toMatchObject({ code: 'VALIDATION_PRESERVATION_UNVERIFIED' });
    expect(f.containerManager.execInContainer).not.toHaveBeenCalled();
    expect(f.containerManager.kill).not.toHaveBeenCalled();
  });
  it('refuses export retry even after a previously verified source checkpoint without final-content proof', async () => {
    const f = fixture();
    f.ledger.begin(f.podRepo.getOrThrow(f.podId), actor, reason);
    f.ledger.preserve(f.dispatch!, {
      snapshot: '/retained/old-export',
      checkpointCommit: 'a'.repeat(40),
    });
    await expectProviderBlocked(f);
    await expectProviderBlocked(f, f.create());
  });
  it('refuses changed provider namespace and thrown 404 without treating either as proof', async () => {
    const f = fixture();
    Object.assign(f.containerManager, { executionResourceScope: 'replacement-scope' });
    await expectProviderBlocked(f);
    Object.assign(f.containerManager, { executionResourceScope: 'test-scope' });
    vi.mocked(f.containerManager.getStatus).mockRejectedValue(
      Object.assign(new Error('Ambiguous 404'), { statusCode: 404 }),
    );
    await expectProviderBlocked(f);
    expect(f.ledger.isSettled(f.podRepo.getOrThrow(f.podId))).toBe(false);
  });
  it('does not repeat deletion after a crash or accept resource absence as final report proof', async () => {
    const f = fixture();
    f.ledger.begin(f.podRepo.getOrThrow(f.podId), actor, reason);
    f.ledger.preserve(f.dispatch!, {
      snapshot: '/retained/old-export',
      checkpointCommit: 'a'.repeat(40),
    });
    f.db
      .prepare('UPDATE validation_recovery_intents SET deletion_started_at=? WHERE dispatch_id=?')
      .run(new Date().toISOString(), f.dispatch);
    vi.mocked(f.containerManager.getStatus).mockResolvedValue('deleted');
    await expectProviderBlocked(f, f.create());
    expect(() => f.ledger.startDeletion(f.dispatch!)).toThrow('immutable final');
    expect(() => f.ledger.settle(f.podRepo.getOrThrow(f.podId), new Date().toISOString())).toThrow(
      'immutable final',
    );
  });
  it('rejects native Goals and does not contact an unavailable provider for destructive recovery', async () => {
    const f = fixture();
    const goal = vi.spyOn(f.ledger, 'hasGoal').mockReturnValue(true);
    await expect(f.recovery.reconcileValidationExecution(f.podId, f.input, actor)).rejects.toThrow(
      'native Goal',
    );
    goal.mockRestore();
    vi.mocked(f.containerManager.getStatus).mockImplementation(() => new Promise(() => {}));
    await expectProviderBlocked(f);
  });
  it('can inspect an old result with maintained immutable ownership but cannot invent final-content proof', async () => {
    const f = fixture(false, true);
    expect(f.result).not.toHaveProperty('executionDispatchId');
    expect(f.result.infrastructureFailure).not.toHaveProperty('execution');
    expect(f.recovery.getValidationExecutionRecovery(f.podId)).toMatchObject({
      dispatchId: f.dispatch,
      code: 'VALIDATION_FINAL_CONTENT_UNVERIFIED',
      allowed: false,
      settled: false,
    });
    await expectProviderBlocked(f);
    expect(f.podRepo.getOrThrow(f.podId).lastValidationResult).toEqual(f.result);
  });
  it('blocks task-wide worker/validation admissions even when an old deletion receipt exists', async () => {
    const f = fixture();
    const binding = f.ledger.find(f.podRepo.getOrThrow(f.podId))?.binding;
    if (!binding) throw new Error('Missing binding');
    f.ledger.begin(f.podRepo.getOrThrow(f.podId), actor, reason);
    const receipt = {
      dispatchId: f.dispatch,
      binding,
      resultHash: f.input.expectedResultHash,
      actor,
      reason,
      proof: 'sandbox-deleted',
      observedAt: new Date().toISOString(),
      snapshot: '/retained/old-export',
      checkpointCommit: 'a'.repeat(40),
      reconciledAt: new Date().toISOString(),
    };
    f.db
      .prepare('UPDATE validation_recovery_intents SET receipt=? WHERE dispatch_id=?')
      .run(JSON.stringify(receipt), f.dispatch);
    expect(f.recovery.getValidationExecutionRecovery(f.podId)).toMatchObject({
      settled: false,
      receipt,
    });
    expect(f.ledger.isSettled(f.podRepo.getOrThrow(f.podId))).toBe(false);
    expect(() => f.ledger.assertTaskSettled(f.podId)).toThrow('termination is unverified');
    await expectProviderBlocked(f);
    expect(() => f.db.prepare('UPDATE validation_recovery_intents SET receipt=NULL').run()).toThrow(
      'immutable',
    );
  });
  it('does not duplicate source import across daemon instances or blindly take over interrupted preservation', async () => {
    const f = fixture();
    f.ledger.begin(f.podRepo.getOrThrow(f.podId), actor, reason);
    const claim = f.ledger.claimPreservation(f.dispatch ?? 'missing');
    expect(f.create().getValidationExecutionRecovery(f.podId)).toMatchObject({
      allowed: false,
      code: 'VALIDATION_PRESERVATION_UNVERIFIED',
    });
    await expect(
      f.create().reconcileValidationExecution(f.podId, f.input, actor),
    ).rejects.toMatchObject({ code: 'VALIDATION_PRESERVATION_UNVERIFIED' });
    expect(f.containerManager.execInContainer).not.toHaveBeenCalled();
    expect(f.containerManager.kill).not.toHaveBeenCalled();
    f.ledger.finishPreservation(claim, 'failed');
    await expectProviderBlocked(f, f.create());
  });
  it('honors unresolved durable human decisions even when the legacy pending-escalation field is empty', async () => {
    const f = fixture();
    vi.spyOn(f.podRepo, 'hasUnansweredDecision').mockReturnValue(true);
    await expect(f.recovery.reconcileValidationExecution(f.podId, f.input, actor)).rejects.toThrow(
      'human decision',
    );
    expect(f.containerManager.kill).not.toHaveBeenCalled();
  });
});
