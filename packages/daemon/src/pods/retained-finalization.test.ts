import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DockerContainerManager } from '../containers/docker-container-manager.js';
import { SandboxContainerManager } from '../containers/sandbox-container-manager.js';
import { createDeliveryFixture, pendingStatus } from '../test-utils/delivery-helpers.js';
import { createTestContext, logger } from '../test-utils/mock-helpers.js';
import { retainedCheckpointFixture } from '../test-utils/retained-checkpoint-helpers.js';
import { LocalWorktreeManager } from '../worktrees/local-worktree-manager.js';
import { createApprovalDeliveryExecution } from './approval-delivery-execution.js';
import { createApprovalDeliveryPreparation } from './approval-delivery-preparation.js';
import { createApprovalWorkflow } from './approval-workflow.js';
import { createEventBus } from './event-bus.js';
import { createEventRepository } from './event-repository.js';
import type { createPodRepository } from './pod-repository.js';
import { retainUnresolvedReconciliation } from './reconciliation-ownership.js';
import {
  assertCheckpointResourceNotRetained,
  checkpointHash,
} from './retained-checkpoint-repository.js';
import { createRetainedFinalization } from './retained-finalization.js';
import {
  assertFinalizationPathAvailable,
  createRetainedFinalizationRepository,
} from './retained-finalization-repository.js';
import { SandboxOrphanReaper } from './sandbox-orphan-reaper.js';
import { SandboxTerminalReaper } from './sandbox-terminal-reaper.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.unstubAllEnvs();
});
async function fixture(kind: 'continuation' | 'rewrite' = 'continuation') {
  if (kind === 'rewrite') {
    const f = createDeliveryFixture(true);
    vi.stubEnv('DATA_DIR', path.join(f.directory, 'data'));
    f.podRepo.update('prepare', {
      options: { ...f.pod().options, output: 'pr' },
      prUrl: 'https://github.com/org/repo/pull/27',
    });
    vi.mocked(f.worktreeManager.prepareApprovalRebase!).mockImplementation(async (config) => {
      config.onPrepared('e'.repeat(40));
      return {
        kind: 'candidate',
        baseCommitSha: 'e'.repeat(40),
        worktreePath: path.join(config.root, 'worktree'),
        head: 'a'.repeat(40),
        tree: 'b'.repeat(40),
      };
    });
    const captured = { ...f.mainCaptured, prManagerFactory: () => f.provider };
    await createApprovalWorkflow({
      ...captured,
      ...createApprovalDeliveryPreparation(captured),
      ...createApprovalDeliveryExecution(captured),
    }).approveSession('prepare', { actor: { type: 'human', userId: 'operator' } });
    f.podRepo.update('prepare', {
      status: 'failed',
      containerId: 'replacement',
      executionTarget: 'sandbox',
    });
    vi.mocked(f.worktreeManager.pushBranch).mockClear();
    return {
      ...configure(
        f.podRepo,
        f.db,
        'prepare',
        f.cm,
        f.worktreeManager,
        f.captured.resolveEffectiveBoundProfile,
        f.provider,
        () => ({ ...f.reopen(), db: f.db }),
      ),
      manager: f.manager(),
    };
  }
  const f = await retainedCheckpointFixture('validation');
  cleanup.push(async () => {
    if (f.ctx.db.open) f.ctx.db.close();
    await rm(f.root, { recursive: true, force: true });
  });
  // A separately settled fixture, never a production waiver of the unknown result.
  const result = { ...f.result, infrastructureFailure: undefined };
  f.ctx.podRepo.update(f.podId, {
    lastValidationResult: result,
    options: { ...f.pod().options, output: 'pr' },
    prUrl: 'https://github.com/org/repo/pull/27',
  });
  f.worktrees.selectRetainedContinuationSource = vi.fn(async () => ({
    head: f.prepared.head,
    tree: f.prepared.tree,
    baseCommitSha: 'e'.repeat(40),
  }));
  await f.recovery.continueRetained(
    f.podId,
    { ...f.input, expectedResultHash: checkpointHash(result), prepareOnly: true },
    f.actor,
  );
  await f.recovery.wait(f.input.id);
  return {
    ...configure(f.ctx.podRepo, f.ctx.db, f.podId, f.cm, f.worktrees, f.deps.executionForPod),
    manager: f.manager,
  };
}
function configure(
  pods: ReturnType<typeof createPodRepository>,
  db: Database.Database,
  id: string,
  cm: ReturnType<typeof createTestContext>['containerManager'],
  worktrees: ReturnType<typeof createTestContext>['worktreeManager'],
  settings: Parameters<typeof createRetainedFinalization>[0]['executionForPod'],
  provider = {
    getPrStatus: vi.fn(),
    verifyMergedSourceAncestry: vi.fn(),
    createPr: vi.fn(),
    mergePr: vi.fn(),
  },
  reopen?: () => { pods: ReturnType<typeof createPodRepository>; db: Database.Database },
) {
  const pod = () => pods.getOrThrow(id);
  db.prepare('UPDATE pods SET profile_snapshot=? WHERE id=?').run(
    JSON.stringify(settings(pod())),
    id,
  );
  const checkpoint = pods.retainedCheckpoints!.latest(id);
  const resourceKey =
    checkpoint && !checkpoint.activated
      ? checkpoint.resourceKey
      : `provider/immutable/${pod().containerId}`;
  cm.getResourceKey = vi.fn(async () => resourceKey);
  vi.mocked(cm.getStatus).mockClear().mockResolvedValue('stopped');
  worktrees.inspectSource = vi.fn(async () => ({
    branch: pod().branch,
    commitSha: 'a'.repeat(40),
    treeSha: 'b'.repeat(40),
    worktreeClean: true,
  }));
  const target = {
    repository: settings(pod()).repoUrl!,
    branch: pod().branch,
    baseBranch: pod().baseBranch ?? settings(pod()).defaultBranch!,
  };
  provider.getPrStatus.mockClear();
  provider.getPrStatus.mockResolvedValue(
    pendingStatus({ merged: true, open: false, sourceTarget: target, headSha: 'a'.repeat(40) }),
  );
  const deps = {
    eventBus: createEventBus(createEventRepository(db), logger),
    podRepo: pods,
    executionForPod: settings,
    getContainerManager: () => cm,
    worktreeManager: worktrees,
    prManagerFactory: () => provider,
    isIdle: vi.fn(() => true),
    isGoal: vi.fn(() => false),
    assertGuidanceCollected: vi.fn(),
  };
  const controller = () => createRetainedFinalization(deps);
  const ctrl = controller();
  const view = ctrl.inspectRetainedFinalization(id);
  const request = {
    requestKey: 'human-finalize',
    expectedGeneration: view.generation,
    expectedBinding: view.binding,
    mode: 'stop-retain' as 'stop-retain' | 'complete-merged',
    reason: 'Stop this retained task without destroying source or reports',
  };
  const actor = { type: 'human' as const, userId: 'operator' };
  const submit = () => ctrl.finalizeRetained(id, request, actor);
  return {
    pods,
    db,
    id,
    cm,
    worktrees,
    provider,
    pod,
    deps,
    controller,
    ctrl,
    request,
    actor,
    submit,
    reopen: reopen
      ? () => {
          const next = reopen();
          deps.eventBus = createEventBus(createEventRepository(next.db), logger);
          return next;
        }
      : undefined,
    target,
    resourceKey,
  };
}

describe('retained finalization', () => {
  it.each([
    'stop-retain',
    'complete-merged',
  ] as const)('atomically persists the real terminal event pair for %s and isolates failing subscribers', async (mode) => {
    const f = await fixture('rewrite');
    f.request.mode = mode;
    const events = createEventRepository(f.db);
    const last = events.getSince(0).at(-1)?.id ?? 0;
    const delivered: Array<{ type: string; committed: boolean; state: string | undefined }> = [];
    f.deps.eventBus.subscribe((event) => {
      delivered.push({
        type: event.type,
        committed: !f.db.inTransaction,
        state: f.pods.retainedFinalizations!.get(f.id)?.receipt.state,
      });
      throw new Error('on-finalized subscriber failed');
    });
    const surviving = vi.fn();
    f.deps.eventBus.subscribe(surviving);
    const receipt = await f.submit();
    expect(receipt.state).toBe('finalized');
    const saved = events.getSince(last);
    expect(saved.map((event) => event.type)).toEqual(['pod.status_changed', 'pod.completed']);
    expect(saved[0]?.payload).toMatchObject({
      previousStatus: 'failed',
      newStatus: mode === 'stop-retain' ? 'killed' : 'complete',
    });
    expect(saved[1]?.payload).toMatchObject({
      finalStatus: mode === 'stop-retain' ? 'killed' : 'complete',
    });
    expect(delivered).toEqual(
      saved.map((event) => ({ type: event.type, committed: true, state: 'finalized' })),
    );
    expect(surviving).toHaveBeenCalledTimes(2);
    expect(await f.submit()).toEqual(receipt);
    expect(events.getSince(last)).toEqual(saved);
    expect(surviving).toHaveBeenCalledTimes(2);
  });
  it.each([
    'stop-retain',
    'complete-merged',
  ] as const)('rolls back status, receipt and both %s events on terminal persistence failure', async (mode) => {
    const f = await fixture('rewrite');
    f.request.mode = mode;
    const events = createEventRepository(f.db);
    const last = events.getSince(0).at(-1)?.id ?? 0;
    const broadcast = vi.fn();
    f.deps.eventBus.subscribe(broadcast);
    const persist = f.deps.eventBus.emitAfterCommit.bind(f.deps.eventBus);
    const fault = vi
      .spyOn(f.deps.eventBus, 'emitAfterCommit')
      .mockImplementation((event, afterCommit) => {
        const id = persist(event, afterCommit);
        if (event.type === 'pod.completed')
          throw new Error('terminal event persistence interrupted');
        return id;
      });
    await expect(f.submit()).rejects.toThrow('terminal event persistence interrupted');
    expect(f.pod().status).toBe('failed');
    expect(f.pods.retainedFinalizations!.get(f.id)?.receipt.state).toBe('pending');
    expect(events.getSince(last)).toEqual([]);
    expect(broadcast).not.toHaveBeenCalled();
    fault.mockRestore();
    expect((await f.submit()).state).toBe('finalized');
    expect(events.getSince(last)).toHaveLength(2);
  });
  it.each([
    'stop-retain',
    'complete-merged',
  ] as const)('retains %s events across reopen after commit but before broadcast without replay duplication', async (mode) => {
    const f = await fixture('rewrite');
    f.request.mode = mode;
    const events = createEventRepository(f.db);
    const last = events.getSince(0).at(-1)?.id ?? 0;
    const broadcast = vi.fn();
    f.deps.eventBus.subscribe(broadcast);
    const unsent: Array<() => void> = [];
    vi.spyOn(f.pods, 'afterCommit').mockImplementation((effect) => {
      unsent.push(effect);
    });
    const receipt = await f.submit();
    expect(unsent).toHaveLength(2);
    expect(broadcast).not.toHaveBeenCalled();
    const saved = events.getSince(last);
    expect(saved).toHaveLength(2);
    const next = f.reopen!();
    f.deps.podRepo = next.pods;
    const restartedBroadcast = vi.fn();
    f.deps.eventBus.subscribe(restartedBroadcast);
    expect(await f.controller().finalizeRetained(f.id, f.request, f.actor)).toEqual(receipt);
    expect(createEventRepository(next.db).getSince(last)).toEqual(saved);
    expect(restartedBroadcast).not.toHaveBeenCalled();
  });
  it.each([
    'pending',
    'finalized',
  ] as const)('rejects a different human reusing a %s request', async (state) => {
    const f = await fixture();
    if (state === 'pending')
      vi.mocked(f.cm.getStatus).mockResolvedValueOnce('running').mockResolvedValue('unknown');
    expect((await f.submit()).state).toBe(state);
    const calls = vi.mocked(f.cm.getStatus).mock.calls.length;
    await expect(
      f.ctrl.finalizeRetained(f.id, f.request, { type: 'human', userId: 'other-human' }),
    ).rejects.toThrow(/actor/);
    expect(vi.mocked(f.cm.getStatus).mock.calls).toHaveLength(calls);
  });
  it('fences real facade controls and competing candidate selection during finalization preflight', async () => {
    const f = await fixture();
    let release!: (value: string) => void;
    vi.mocked(f.cm.getResourceKey!).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const view = f.manager.inspectRetainedFinalization(f.id);
    const request = { ...f.request, expectedBinding: view.binding };
    const pending = f.manager.finalizeRetained(f.id, request, f.actor);
    expect(() =>
      f.manager.finalizeRetained(f.id, request, { type: 'human', userId: 'other-human' }),
    ).toThrow(/conflicting/);
    await expect(f.manager.killSession(f.id)).rejects.toThrow(/preflight/);
    const owner = f.pods.retainedCheckpoints!.latest(f.id)!;
    await expect(
      f.manager.checkRetainedCandidate(
        f.id,
        owner.id,
        {
          expectedGeneration: f.pod().lifecycleGeneration,
          expectedResultHash: owner.binding.resultHash,
          candidateHead: owner.prepared!.head,
          reason: 'Competing candidate selection during finalization',
        },
        f.actor,
      ),
    ).rejects.toThrow(/active/);
    expect(f.pods.retainedCheckpoints!.latest(f.id)?.selected).toBeNull();
    expect(f.pods.retainedFinalizations!.get(f.id)).toBeNull();
    release(f.resourceKey);
    expect((await pending).state).toBe('finalized');
    expect(f.cm.kill).not.toHaveBeenCalled();
    expect(f.cm.start).not.toHaveBeenCalled();
    expect(f.cm.spawn).not.toHaveBeenCalled();
  });
  it.each([
    'continuation',
    'rewrite',
  ] as const)('refuses clean merged B when %s owns A', async (kind) => {
    const f = await fixture(kind);
    f.request.mode = 'complete-merged';
    vi.mocked(f.worktrees.inspectSource!).mockResolvedValue({
      branch: f.pod().branch,
      commitSha: 'c'.repeat(40),
      treeSha: 'd'.repeat(40),
      worktreeClean: true,
    });
    f.provider.getPrStatus.mockResolvedValue(
      pendingStatus({ merged: true, sourceTarget: f.target, headSha: 'c'.repeat(40) }),
    );
    await expect(f.submit()).rejects.toThrow();
    expect(f.pods.retainedFinalizations!.get(f.id)).toBeNull();
    expect(f.cm.stop).not.toHaveBeenCalled();
  });
  it('wires the facade and blocks ordinary mutators without changing normal custody guards', async () => {
    const f = await fixture();
    const changes = f.db.prepare('SELECT total_changes() AS n').get();
    const view = f.manager.inspectRetainedFinalization(f.id);
    expect(f.db.prepare('SELECT total_changes() AS n').get()).toEqual(changes);
    expect(f.cm.getStatus).not.toHaveBeenCalled();
    expect(view.canStop, view.blockers.join('; ')).toBe(true);
    const receipt = await f.manager.finalizeRetained(
      f.id,
      { ...f.request, expectedBinding: view.binding },
      f.actor,
    );
    expect(receipt.state).toBe('finalized');
    await expect(f.manager.killSession(f.id)).rejects.toThrow(/finalization/i);
    await expect(f.manager.deleteSession(f.id)).rejects.toThrow(/finalization/i);
    await expect(f.manager.processPod(f.id)).rejects.toThrow(/finalization/i);
    expect(f.cm.kill).not.toHaveBeenCalled();
    expect(f.cm.start).not.toHaveBeenCalled();
  });
  it('refuses a changed original provider namespace before admitting an intent', async () => {
    const f = await fixture();
    vi.mocked(f.cm.getResourceKey!).mockResolvedValue('another-provider/namespace');
    await expect(f.submit()).rejects.toThrow(/immutable original owner/);
    expect(f.pods.retainedFinalizations!.get(f.id)).toBeNull();
    expect(f.cm.stop).not.toHaveBeenCalled();
  });
  it('does not fence ordinary tasks', () => {
    const f = createTestContext();
    expect(createRetainedFinalizationRepository(f.db).get('ordinary')).toBeNull();
    expect(() =>
      createRetainedFinalizationRepository(f.db).assertAvailable('ordinary'),
    ).not.toThrow();
    f.db.close();
  });
  it.each([
    'continuation',
    'rewrite',
  ] as const)('cancels %s without modifying evidence, budgets or resources', async (kind) => {
    const f = await fixture(kind);
    const before = f.pod();
    const task = f.pods.taskExecutions!.snapshot(f.id);
    const budget = f.pods.taskRetries!.state(f.id);
    const result = await f.submit();
    expect(result.state).toBe('finalized');
    expect(f.pod()).toMatchObject({
      status: 'killed',
      containerId: before.containerId,
      worktreePath: before.worktreePath,
      lastValidationResult: before.lastValidationResult,
      validationAttempts: before.validationAttempts,
      maxValidationAttempts: before.maxValidationAttempts,
    });
    expect(f.pods.taskExecutions!.snapshot(f.id)).toEqual(task);
    expect(f.pods.taskRetries!.state(f.id)).toEqual(budget);
    expect(await f.submit()).toEqual(result);
    expect(() => f.pods.update(f.id, { status: 'queued' })).toThrow(/finalization/i);
    expect(() => f.pods.delete(f.id)).toThrow();
    expect(() => assertCheckpointResourceNotRetained(f.db, before.containerId!)).toThrow();
    expect(retainUnresolvedReconciliation(f.id, f.pods)).toBe(true);
    expect(f.cm.stop).not.toHaveBeenCalled();
    expect(f.cm.kill).not.toHaveBeenCalled();
    expect(f.cm.start).not.toHaveBeenCalled();
    expect(f.cm.spawn).not.toHaveBeenCalled();
    expect(f.provider.mergePr).not.toHaveBeenCalled();
    expect(f.worktrees.pushBranch).not.toHaveBeenCalled();
    if (f.reopen) expect(f.reopen().pods.retainedFinalizations!.get(f.id)?.receipt).toEqual(result);
  });
  it('coalesces concurrent requests, durably fences before stop and only observes uncertain stop on retry', async () => {
    const f = await fixture();
    vi.mocked(f.cm.getStatus).mockResolvedValue('running');
    let release!: () => void;
    vi.mocked(f.cm.stop).mockImplementation(async () => {
      expect(f.pods.retainedFinalizations!.get(f.id)?.stopDispatched).toBe(true);
      expect(() => f.pods.update(f.id, { containerId: 'other' })).toThrow();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      throw new Error('response lost');
    });
    const first = f.submit();
    const duplicate = f.submit();
    expect(duplicate).toBe(first);
    await vi.waitFor(() => expect(f.cm.stop).toHaveBeenCalledOnce());
    release();
    expect((await first).state).toBe('pending');
    expect((await f.controller().finalizeRetained(f.id, f.request, f.actor)).state).toBe('pending');
    vi.mocked(f.cm.getStatus).mockResolvedValue('stopped');
    expect((await f.controller().finalizeRetained(f.id, f.request, f.actor)).state).toBe(
      'finalized',
    );
    expect(f.cm.stop).toHaveBeenCalledOnce();
  });
  it.each([
    'before-stop',
    'after-stop',
    'terminal-rollback',
  ] as const)('reopens real SQLite after %s without losing intent or repeating stop', async (crash) => {
    const f = await fixture('rewrite');
    vi.mocked(f.cm.getStatus).mockResolvedValue(
      crash === 'terminal-rollback' ? 'stopped' : 'running',
    );
    if (crash === 'before-stop')
      vi.mocked(f.cm.getStatus)
        .mockResolvedValueOnce('running')
        .mockRejectedValueOnce(new Error('crash before dispatch'));
    if (crash === 'after-stop')
      vi.mocked(f.cm.stop).mockRejectedValueOnce(new Error('crash after dispatch'));
    if (crash === 'terminal-rollback') {
      const finish = vi
        .spyOn(f.pods.retainedFinalizations!, 'finish')
        .mockImplementationOnce(() => {
          throw new Error('crash before terminal commit');
        });
      await expect(f.submit()).rejects.toThrow('crash before terminal commit');
      expect(f.pod().status).toBe('failed');
      expect(f.pods.retainedFinalizations!.get(f.id)?.receipt.state).toBe('pending');
      finish.mockRestore();
    } else expect((await f.submit()).state).toBe('pending');
    const next = f.reopen!();
    f.deps.podRepo = next.pods;
    vi.mocked(f.cm.getStatus).mockResolvedValue('stopped');
    const receipt = await f.controller().finalizeRetained(f.id, f.request, f.actor);
    expect(receipt.state).toBe('finalized');
    expect(next.pods.getOrThrow(f.id).status).toBe('killed');
    expect(f.cm.stop).toHaveBeenCalledTimes(crash === 'after-stop' ? 1 : 0);
    const final = f.reopen!();
    f.deps.podRepo = final.pods;
    expect(await f.controller().finalizeRetained(f.id, f.request, f.actor)).toEqual(receipt);
    expect(final.pods.listReferencedContainerIds()).toContain('replacement');
  });
  it('never reissues after a crash between durable dispatch marker and transport send', async () => {
    const f = await fixture('rewrite');
    vi.mocked(f.cm.getStatus).mockResolvedValueOnce('running').mockResolvedValue('unknown');
    expect((await f.submit()).state).toBe('pending');
    expect(() =>
      f.pods.retainedFinalizations!.dispatchStop(
        f.id,
        () => {
          throw new Error('process loss');
        },
        () => {},
      ),
    ).toThrow('process loss');
    f.deps.podRepo = f.reopen!().pods;
    vi.mocked(f.cm.getStatus).mockResolvedValue('running');
    expect((await f.controller().finalizeRetained(f.id, f.request, f.actor)).state).toBe('pending');
    vi.mocked(f.cm.getStatus).mockResolvedValue('stopped');
    expect((await f.controller().finalizeRetained(f.id, f.request, f.actor)).state).toBe(
      'finalized',
    );
    expect(f.cm.stop).not.toHaveBeenCalled();
  });
  it('holds the intent if source changes across the stop await even when the new source is merged', async () => {
    const f = await fixture();
    f.request.mode = 'complete-merged';
    vi.mocked(f.cm.getStatus).mockResolvedValue('running');
    vi.mocked(f.cm.stop).mockImplementation(async () => {
      vi.mocked(f.cm.getStatus).mockResolvedValue('stopped');
      vi.mocked(f.worktrees.inspectSource!).mockResolvedValue({
        branch: f.pod().branch,
        commitSha: 'c'.repeat(40),
        treeSha: 'd'.repeat(40),
        worktreeClean: true,
      });
      f.provider.getPrStatus.mockResolvedValue(
        pendingStatus({ merged: true, sourceTarget: f.target, headSha: 'c'.repeat(40) }),
      );
    });
    await expect(f.submit()).rejects.toThrow(/source changed/i);
    expect(f.pods.retainedFinalizations!.get(f.id)?.receipt.state).toBe('pending');
    expect(f.pod().status).toBe('review_required');
    expect(f.cm.stop).toHaveBeenCalledOnce();
    expect(f.provider.mergePr).not.toHaveBeenCalled();
  });
  it('grants only exact non-destructive STOP at the managed transport boundary', async () => {
    const f = await fixture();
    vi.mocked(f.cm.getStatus).mockResolvedValueOnce('running').mockResolvedValue('unknown');
    await f.submit();
    const stop = vi.fn(async () => {});
    const getContainer = vi.fn(() => ({ stop }));
    const manager = new DockerContainerManager({
      managedDatabase: f.db,
      docker: { getContainer } as never,
      logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    });
    const id = f.pod().containerId!;
    await expect(manager.stop(id)).rejects.toThrow(/Finalization/);
    await expect(manager.start(id)).rejects.toThrow(/Finalization/);
    await expect(manager.kill(id)).rejects.toThrow(/Finalization/);
    await expect(manager.execInContainer(id, ['true'])).rejects.toThrow(/Finalization/);
    expect(getContainer).not.toHaveBeenCalled();
    const suspend = vi.fn(async () => {});
    const sandbox = new SandboxContainerManager({ suspend } as never, { debug: vi.fn() } as never, {
      managedDatabase: f.db,
    });
    await expect(sandbox.stop(id)).rejects.toThrow(/Finalization/);
    await f.pods.retainedFinalizations!.dispatchStop(
      f.id,
      async () => {
        await expect(manager.kill(id)).rejects.toThrow(/Finalization/);
        await expect(manager.stop(id)).rejects.toThrow(/Finalization/); // wrong execution target
        await sandbox.stop(id);
      },
      () => {},
    );
    expect(suspend).toHaveBeenCalledOnce();
    await expect(sandbox.stop(id)).rejects.toThrow(/Finalization/);
    expect(suspend).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();
    expect(getContainer).not.toHaveBeenCalled();
  });
  it('retains worktrees, ignored reports, common Git storage and ancestors against cleanup', async () => {
    const f = await fixture();
    const source = f.pod().worktreePath!;
    const common = path.join(path.dirname(source), 'gitdata');
    await mkdir(path.join(common, 'worktrees', 'task'), { recursive: true });
    await mkdir(source, { recursive: true });
    await writeFile(
      path.join(source, '.git'),
      `gitdir: ${path.join(common, 'worktrees', 'task')}\n`,
    );
    await writeFile(path.join(common, 'worktrees', 'task', 'commondir'), '../..\n');
    await writeFile(path.join(source, 'ignored-report'), 'retain these bytes');
    f.request.expectedBinding = f.ctrl.inspectRetainedFinalization(f.id).binding;
    await f.submit();
    const manager = new LocalWorktreeManager({
      logger: { warn: vi.fn() } as never,
      assertPathMutable: (location) => assertFinalizationPathAvailable(f.db, location),
    });
    for (const location of [source, common, path.dirname(source)])
      await expect(manager.cleanup(location)).rejects.toThrow(/retains this source location/);
    expect(await readFile(path.join(source, 'ignored-report'), 'utf8')).toBe('retain these bytes');
    expect(f.pods.retainedFinalizations!.get(f.id)?.binding.sourceLocations).toContain(common);
    expect(() =>
      assertFinalizationPathAvailable(f.db, path.join(path.dirname(source), 'unrelated')),
    ).not.toThrow();
  });
  it('accepts exact provider ancestry without claiming to validate additional commits', async () => {
    const f = await fixture();
    f.request.mode = 'complete-merged';
    f.provider.getPrStatus.mockResolvedValue(
      pendingStatus({ merged: true, sourceTarget: f.target, headSha: 'c'.repeat(40) }),
    );
    f.provider.verifyMergedSourceAncestry.mockResolvedValue({
      publishedHeadSha: 'a'.repeat(40),
      mergedHeadSha: 'c'.repeat(40),
      target: f.target,
      observedAt: new Date().toISOString(),
    });
    expect((await f.submit()).state).toBe('finalized');
    expect(f.pod().lastValidationResult?.overall).toBe('fail');
    expect(f.provider.verifyMergedSourceAncestry).toHaveBeenCalledTimes(2);
  });
  it.each([
    'unknown',
    'exception',
  ] as const)('does not stop or finalize on %s observation', async (failure) => {
    const f = await fixture();
    if (failure === 'exception')
      vi.mocked(f.cm.getStatus).mockRejectedValue(new Error('unavailable'));
    else vi.mocked(f.cm.getStatus).mockResolvedValue('unknown');
    await expect(f.submit()).rejects.toThrow();
    expect(f.pods.retainedFinalizations!.get(f.id)).toBeNull();
    expect(f.pod().status).toBe('review_required');
    expect(f.cm.stop).not.toHaveBeenCalled();
  });
  it('retains current replacement resources after terminal state and pointer loss', async () => {
    const f = await fixture('rewrite');
    await f.submit();
    const reaper = new SandboxTerminalReaper({
      podRepo: f.pods,
      sandboxContainerManager: f.cm as never,
      logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn() } as never,
    });
    await reaper.runSweep();
    expect(f.cm.kill).not.toHaveBeenCalled();
    f.db.prepare('UPDATE pods SET container_id=NULL WHERE id=?').run(f.id); // adversarial old binary
    expect(f.pods.listReferencedContainerIds()).toContain('replacement');
    expect(() => assertCheckpointResourceNotRetained(f.db, 'replacement')).toThrow();
    const orphan = new SandboxOrphanReaper({
      podRepo: f.pods,
      sandboxContainerManager: {
        kill: f.cm.kill,
        listSandboxes: vi.fn(async () => [
          {
            id: 'replacement',
            labels: { managedBy: 'autopod' },
            createdAt: '2020-01-01T00:00:00Z',
          },
        ]),
      },
      logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn() } as never,
    });
    expect((await orphan.runSweep()).deleted).toBe(0);
    expect(f.cm.kill).not.toHaveBeenCalled();
  });
  it.each([
    'key',
    'mode',
    'reason',
    'generation',
    'binding',
  ] as const)('rejects conflicting admitted %s', async (field) => {
    const f = await fixture();
    vi.mocked(f.cm.getStatus).mockResolvedValueOnce('running').mockResolvedValue('unknown');
    await f.submit();
    const changed = { ...f.request };
    if (field === 'key') changed.requestKey += '-other';
    if (field === 'mode') changed.mode = 'complete-merged';
    if (field === 'reason') changed.reason += ' changed';
    if (field === 'generation') changed.expectedGeneration++;
    if (field === 'binding') changed.expectedBinding = '0'.repeat(64);
    await expect(f.ctrl.finalizeRetained(f.id, changed, f.actor)).rejects.toThrow(/Conflicting/);
    expect(f.cm.stop).not.toHaveBeenCalled();
  });
  it.each([
    'generation',
    'container',
    'owner',
    'active',
    'unknown-exit',
    'goal',
  ] as const)('rejects %s before intent', async (change) => {
    const f = await fixture();
    if (change === 'generation') f.request.expectedGeneration++;
    if (change === 'container')
      f.db.prepare('UPDATE pods SET container_id=? WHERE id=?').run('drift', f.id);
    if (change === 'owner') f.deps.isIdle.mockReturnValue(false);
    if (change === 'active') f.db.prepare("UPDATE pods SET status='running' WHERE id=?").run(f.id);
    if (change === 'goal') f.deps.isGoal.mockReturnValue(true);
    if (change === 'unknown-exit')
      f.db.prepare('UPDATE pods SET last_validation_result=? WHERE id=?').run(
        JSON.stringify({
          ...f.pod().lastValidationResult,
          infrastructureFailure: { code: 'EXEC_EXIT_UNVERIFIED' },
        }),
        f.id,
      );
    await expect(f.submit()).rejects.toThrow();
    expect(f.pods.retainedFinalizations!.get(f.id)).toBeNull();
    expect(f.cm.stop).not.toHaveBeenCalled();
  });
  it.each([
    'open',
    'closed',
    'repo',
    'branch',
    'base',
    'dirty',
    'ancestry',
    'unavailable',
    'changed',
  ] as const)('refuses %s delivery proof without an intent', async (failure) => {
    const f = await fixture();
    f.request.mode = 'complete-merged';
    if (failure === 'open' || failure === 'closed')
      f.provider.getPrStatus.mockResolvedValue(pendingStatus({ open: failure === 'open' }));
    if (failure === 'unavailable') f.provider.getPrStatus.mockRejectedValue(new Error('offline'));
    if (['repo', 'branch', 'base'].includes(failure))
      f.provider.getPrStatus.mockResolvedValue(
        pendingStatus({
          merged: true,
          sourceTarget: {
            ...f.target,
            [failure === 'repo' ? 'repository' : failure === 'base' ? 'baseBranch' : 'branch']:
              'wrong',
          },
          headSha: 'a'.repeat(40),
        }),
      );
    if (failure === 'ancestry')
      f.provider.getPrStatus.mockResolvedValue(
        pendingStatus({ merged: true, sourceTarget: f.target, headSha: 'c'.repeat(40) }),
      );
    if (failure === 'dirty')
      vi.mocked(f.worktrees.inspectSource!).mockResolvedValue({
        branch: f.pod().branch,
        commitSha: 'a'.repeat(40),
        treeSha: 'b'.repeat(40),
        worktreeClean: false,
      });
    if (failure === 'changed')
      f.provider.getPrStatus.mockImplementation(async () => {
        vi.mocked(f.worktrees.inspectSource!).mockResolvedValue({
          branch: f.pod().branch,
          commitSha: 'c'.repeat(40),
          treeSha: 'b'.repeat(40),
          worktreeClean: true,
        });
        return pendingStatus({ merged: true, sourceTarget: f.target, headSha: 'a'.repeat(40) });
      });
    await expect(f.submit()).rejects.toThrow();
    expect(f.pods.retainedFinalizations!.get(f.id)).toBeNull();
    expect(f.cm.stop).not.toHaveBeenCalled();
    expect(f.provider.mergePr).not.toHaveBeenCalled();
    expect(f.worktrees.pushBranch).not.toHaveBeenCalled();
  });
  it.each([
    'continuation',
    'rewrite',
  ] as const)('records merged %s source independently of failed validation', async (kind) => {
    const f = await fixture(kind);
    f.request.mode = 'complete-merged';
    const result = f.pod().lastValidationResult;
    expect((await f.submit()).state).toBe('finalized');
    expect(f.pod().status).toBe('complete');
    expect(f.pod().lastValidationResult).toEqual(result);
    expect(f.pods.retainedFinalizations!.get(f.id)?.evidence).toMatchObject({
      source: { commitSha: 'a'.repeat(40) },
    });
    expect(f.provider.getPrStatus).toHaveBeenCalledTimes(2);
    expect(f.provider.mergePr).not.toHaveBeenCalled();
    expect(f.cm.kill).not.toHaveBeenCalled();
  });
});
