import { mkdir, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContainerManager } from '../interfaces/container-manager.js';
import { rewriteRepairFixture } from '../test-utils/approval-rewrite-repair-helpers.js';
import { createApprovalRewriteAbandonment } from './approval-rewrite-abandonment.js';
import { assertFinalizationPathAvailable } from './retained-finalization-repository.js';
import { assertSourceAvailable, assertSourceResourceReleasable } from './source-custody-guards.js';
import { createWorkspaceDeletion } from './workspace-deletion.js';

const fixtures: Array<Awaited<ReturnType<typeof rewriteRepairFixture>>> = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.ctx.db.close();
    await rm(f.root, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});
async function fixture(unknown = true) {
  const f = await rewriteRepairFixture('sandbox', true, true, unknown);
  fixtures.push(f);
  const repo = f.ctx.podRepo;
  const states = new Map([
    [f.containerId, 'stopped'],
    ['original-pre-rebase-resource', 'stopped'],
  ]);
  const cm = {
    ...f.cm,
    getResourceKey: vi.fn<NonNullable<ContainerManager['getResourceKey']>>(
      async (id) => `https://fixture.invalid/sandboxes/${id}`,
    ),
    getStatus: vi.fn<ContainerManager['getStatus']>(
      async (id) => (states.get(id) as 'stopped' | 'deleted') ?? 'deleted',
    ),
    kill: vi.fn<ContainerManager['kill']>(async (id) => {
      assertSourceResourceReleasable(f.ctx.db, id);
      repo.sandboxWakeups!.assertReleasable(id);
      states.set(id, 'deleted');
    }),
  };
  f.worktrees.cleanup = vi.fn(async (p) => {
    await rm(p, { recursive: true, force: true });
  });
  const stopPreview = vi.fn(async () => {});
  const deletion = createWorkspaceDeletion({
    podRepo: repo,
    executionForPod: f.deps.executionForPod,
    clearPreviewTimer: vi.fn(),
    stopSandboxPreviewProxy: stopPreview,
    killSidecarsForPod: vi.fn(async () => {}),
    containerManagerFactory: { get: () => cm },
    destroyPodNetwork: vi.fn(async () => {}),
    cleanupTestRunBranches: vi.fn(async () => {}),
    worktreeManager: f.worktrees,
    pendingUpdateFromBaseIntents: new Set(),
    forceWithLeaseAllowances: new Set(),
    logger: f.ctx.deps.logger,
  });
  let idle = true;
  const deps = {
    podRepo: repo,
    getContainerManager: () => cm,
    worktreeManager: f.worktrees,
    isIdle: () => idle,
    isGoal: () => false,
    deleteSession: deletion.deleteSession,
  };
  const recovery = createApprovalRewriteAbandonment(deps);
  const inspected = await recovery.inspect(f.podId);
  if (!('binding' in inspected)) throw new Error('Missing fresh selection');
  const input = {
    id: 'discard-fixture',
    expectedGeneration: inspected.generation,
    expectedBinding: inspected.binding,
    reason: 'Discard this exact rewrite and all its unpreserved reports',
    acknowledgeDataLoss: true,
  };
  return {
    ...f,
    cm,
    repo,
    states,
    recovery,
    deps,
    input,
    inspected,
    stopPreview,
    setIdle: (v: boolean) => {
      idle = v;
    },
  };
}

describe('explicit approval rewrite abandonment', () => {
  it('confirms both resources deleted, removes the pod with owned cleanup and retains immutable history and exact replay', async () => {
    const f = await fixture();
    expect(f.cm.kill).not.toHaveBeenCalled();
    expect(() => f.repo.delete(f.podId)).toThrow();
    expect(() => f.repo.approvalRewrites!.assertReleasable(f.containerId)).toThrow();
    const result = await f.recovery.submit(f.podId, f.input, f.actor);
    expect(result).toMatchObject({ podDeleted: true });
    expect(f.cm.kill.mock.calls.map((c) => c[0]).sort()).toEqual(
      [f.containerId, 'original-pre-rebase-resource'].sort(),
    );
    expect(() => f.pod()).toThrow();
    expect(f.repo.getForHistory!(f.podId).id).toBe(f.podId);
    expect(f.repo.approvalRewrites!.get(f.rewriteId)).not.toBeNull();
    expect(f.repo.rewriteAbandonments!.get(f.input.id)?.userId).toBe(f.actor.userId);
    expect(
      f.ctx.db.prepare('SELECT 1 FROM validation_dispatches WHERE id=?').get(f.dispatchId),
    ).toBeTruthy();
    expect(f.ctx.db.pragma('integrity_check', { simple: true })).toBe('ok');
    const again = await createApprovalRewriteAbandonment(f.deps).submit(f.podId, f.input, f.actor);
    expect(again).toEqual(result);
    expect(f.cm.kill).toHaveBeenCalledTimes(2);
    await expect(
      f.recovery.submit(f.podId, { ...f.input, reason: 'A conflicting human request' }, f.actor),
    ).rejects.toThrow('conflict');
    expect(() => f.ctx.db.prepare('DELETE FROM approval_rewrite_abandonments').run()).toThrow(
      'immutable',
    );
    expect(() => f.repo.approvalRewrites!.assertReleasable(f.containerId)).toThrow();
  });
  it.each([
    'consent',
    'generation',
    'binding',
    'actor',
    'active',
  ])('refuses %s without admitting a destructive decision', async (kind) => {
    const f = await fixture();
    const input = { ...f.input };
    if (kind === 'consent') input.acknowledgeDataLoss = false;
    if (kind === 'generation') input.expectedGeneration++;
    if (kind === 'binding') input.expectedBinding = 'f'.repeat(64);
    if (kind === 'active') f.setIdle(false);
    await expect(
      f.recovery.submit(
        f.podId,
        input,
        kind === 'actor' ? { type: 'automation', id: 'x' } : f.actor,
      ),
    ).rejects.toThrow();
    expect(f.cm.kill).not.toHaveBeenCalled();
    expect(f.repo.rewriteAbandonments!.get(input.id)).toBeUndefined();
    expect(f.pod().id).toBe(f.podId);
  });
  it('durably fences updates and source admission while an unknown delete is reconciled by observation only', async () => {
    const f = await fixture();
    f.cm.kill.mockImplementationOnce(async () => {
      throw new Error('lost DELETE response');
    });
    await expect(f.recovery.submit(f.podId, f.input, f.actor)).rejects.toThrow(
      'lost DELETE response',
    );
    expect(() => f.repo.update(f.podId, { status: 'running' })).toThrow();
    expect(() =>
      f.ctx.db.prepare("UPDATE pods SET status='running' WHERE id=?").run(f.podId),
    ).toThrow('abandonment');
    expect(() => assertSourceAvailable(f.ctx.db, f.podId)).toThrow('permanently');
    expect(() => f.repo.approvalRewrites!.assertDelivery(f.pod())).toThrow('permanently');
    await expect(
      createApprovalRewriteAbandonment(f.deps).submit(f.podId, f.input, f.actor),
    ).rejects.toThrow('no blind replay');
    expect(f.cm.kill).toHaveBeenCalledTimes(1);
    const first = f.cm.kill.mock.calls[0]![0];
    f.states.set(first, 'deleted');
    const recovered = await createApprovalRewriteAbandonment(f.deps).submit(
      f.podId,
      f.input,
      f.actor,
    );
    expect(recovered).toMatchObject({ podDeleted: true });
    expect(f.cm.kill).toHaveBeenCalledTimes(2);
  });
  it('rejects a changed namespace or new source evidence after inspection', async () => {
    const f = await fixture();
    f.cm.getResourceKey.mockImplementation(async (id) => `https://changed.invalid/${id}`);
    await expect(f.recovery.submit(f.podId, f.input, f.actor)).rejects.toThrow('Stale');
    expect(f.cm.kill).not.toHaveBeenCalled();
  });
  it('resumes an exact failed pod cleanup without replaying confirmed resource deletion', async () => {
    const f = await fixture();
    f.stopPreview.mockRejectedValueOnce(new Error('Synthetic cleanup error'));
    const recovery = createApprovalRewriteAbandonment(f.deps);
    await expect(recovery.submit(f.podId, f.input, f.actor)).rejects.toMatchObject({
      code: 'POD_DELETE_CLEANUP_UNVERIFIED',
    });
    expect(() => f.repo.deletionOwnership!.assertTaskAvailable(f.podId)).toThrow();
    expect(f.cm.kill).toHaveBeenCalledTimes(2);
    expect(await recovery.submit(f.podId, f.input, f.actor)).toMatchObject({ podDeleted: true });
    expect(f.cm.kill).toHaveBeenCalledTimes(2);
  });
  it('rejects a foreign nested or symlink-aliased source and reserves selected paths during deletion', async () => {
    const f = await fixture();
    const foreignId = 'foreign-fixture';
    // The peer is an ordinary separate task; selected sandbox/path claims must still be fenced.
    f.repo.insert({
      ...f.pod(),
      id: foreignId,
      task: 'Foreign task',
      branch: 'foreign',
      prUrl: null,
    });
    const peer = f.repo.getOrThrow(foreignId);
    await mkdir(path.join(f.root, 'aliases'));
    const alias = path.join(f.root, 'aliases', 'source');
    await symlink(f.original, alias);
    f.repo.update(peer.id, { worktreePath: path.join(alias, 'nested') });
    await expect(f.recovery.submit(f.podId, f.input, f.actor)).rejects.toThrow('overlapping');
    expect(f.cm.kill).not.toHaveBeenCalled();
    f.repo.update(peer.id, { worktreePath: null });
    f.cm.kill.mockImplementationOnce(async () => {
      expect(() =>
        f.ctx.db.prepare('UPDATE pods SET container_id=? WHERE id=?').run(f.containerId, peer.id),
      ).toThrow('reserves');
      expect(() =>
        f.ctx.db
          .prepare('UPDATE pods SET worktree_path=? WHERE id=?')
          .run(path.join(f.original, 'nested'), peer.id),
      ).toThrow('reserves');
      expect(() => f.repo.update(peer.id, { worktreePath: alias })).toThrow('reserves');
      // Resolve aliases inside the actual SQL write, not just the earlier JS guard.
      expect(() =>
        f.ctx.db.prepare('UPDATE pods SET worktree_path=? WHERE id=?').run(alias, peer.id),
      ).toThrow('reserves');
      expect(() => assertFinalizationPathAvailable(f.ctx.db, alias)).toThrow('reserves');
      throw new Error('Observe reservations without completing deletion');
    });
    await expect(f.recovery.submit(f.podId, f.input, f.actor)).rejects.toThrow(
      'Observe reservations',
    );
  });
  it('rechecks a foreign claim acquired during final inspection before making the decision immutable', async () => {
    const f = await fixture();
    f.repo.insert({
      ...f.pod(),
      id: 'late-foreign',
      task: 'Foreign source',
      branch: 'foreign',
      prUrl: null,
    });
    const last = f.inspected.snapshot.resources.at(-1)!.sandboxId;
    f.cm.getResourceKey.mockImplementation(async (id) => {
      if (id === last) f.repo.update('late-foreign', { containerId: last });
      return `https://fixture.invalid/sandboxes/${id}`;
    });
    await expect(f.recovery.submit(f.podId, f.input, f.actor)).rejects.toThrow('foreign');
    expect(f.repo.rewriteAbandonments!.get(f.input.id)).toBeUndefined();
    expect(f.cm.kill).not.toHaveBeenCalled();
  });
  it('permits unrelated reference cleanup without changing abandonment source authority', async () => {
    const f = await fixture();
    f.repo.insert({
      ...f.pod(),
      id: 'referenced-peer',
      task: 'Foreign task',
      branch: 'foreign',
      prUrl: null,
    });
    f.repo.update(f.podId, { fixPodId: 'referenced-peer' });
    f.cm.kill.mockRejectedValueOnce(new Error('Lost deletion response'));
    await expect(f.recovery.submit(f.podId, f.input, f.actor)).rejects.toThrow(
      'Lost deletion response',
    );
    f.repo.delete('referenced-peer');
    expect(f.pod().fixPodId).toBeNull();
    const first = f.cm.kill.mock.calls[0]![0];
    f.states.set(first, 'deleted');
    expect(await f.recovery.submit(f.podId, f.input, f.actor)).toMatchObject({ podDeleted: true });
  });
  it('coalesces concurrent identical requests and blocks a conflicting second key', async () => {
    const f = await fixture(false);
    const results = await Promise.allSettled([
      f.recovery.submit(f.podId, f.input, f.actor),
      f.recovery.submit(f.podId, f.input, f.actor),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(results[0]).toEqual(results[1]);
    expect(f.cm.kill).toHaveBeenCalledTimes(2);
    await expect(
      f.recovery.submit(f.podId, { ...f.input, id: 'different-key' }, f.actor),
    ).rejects.toThrow();
  });
});
