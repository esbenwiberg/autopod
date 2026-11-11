import type { EffectiveLaunchConfig, OperatorActor } from '@autopod/shared';
import { describe, expect, it, vi } from 'vitest';
import { configurationDigest, resolveLaunch } from '../configuration/launch-resolver.js';
import { createAdmissionFixture, flushAdmission } from '../test-utils/admission-queries-helpers.js';
import { createAdmissionResolved } from './admission-resolved.js';

async function fixture() {
  const f = createAdmissionFixture();
  f.podRepo.update('prepare', { status: 'killing' });
  f.podRepo.update('prepare', { status: 'killed' });
  const n = await f.native();
  const config = await resolveLaunch(
    {
      repositoryId: 'repo-a',
      task: 'Finish the preserved work',
      work: { touches: ['src/'], baseBranch: 'main' },
      overrides: { workflow: { preflightConflictPolicy: 'block', tokenBudget: 10000 } },
    },
    n.services,
  );
  const parent = n.admit(config).podId;
  f.podRepo.update(parent, { status: 'provisioning' });
  f.podRepo.update(parent, { containerId: 'a'.repeat(64), tokenTelemetryAccuracy: 'partial' });
  f.podRepo.update(parent, { status: 'failed' });
  await flushAdmission();
  f.enqueueSession.mockClear();
  const isIdle = vi.fn(() => true);
  const resolved = createAdmissionResolved(f.live, {
    ...f.captured,
    ...f.dependents,
    isRerunSourceIdle: isIdle,
  });
  vi.mocked(f.cm.getStatus).mockResolvedValue('stopped');
  const child = await resolveLaunch(
    {
      repositoryId: 'repo-a',
      task: config.task,
      work: {
        touches: ['src/'],
        baseBranch: 'main',
        branch: 'replacement',
        intentionalRerun: {
          ofPodId: parent,
          requestKey: 'exact-human-rerun',
          reason: 'Explicitly start a distinct task while retaining the failed original',
        },
      },
      overrides: { workflow: { preflightConflictPolicy: 'block', tokenBudget: 10000 } },
    },
    n.services,
  );
  const actor: OperatorActor = { type: 'human', userId: 'operator' };
  const prepare = (value = child, owner = 'operator', selectedActor = actor) =>
    resolved.prepareResolvedSession(value, owner, undefined, selectedActor);
  const admit = (create: Awaited<ReturnType<typeof prepare>>, value = child) =>
    n.snapshots.admit({
      config: value,
      requestDigest: value.digest,
      createPod: () => create().id,
    });
  return { ...f, n, config, parent, child, resolved, isIdle, prepare, admit };
}

describe('explicit rerun overlap preflight', () => {
  it('exempts only the observed stopped source and preserves its row, budget and execution evidence', async () => {
    const f = await fixture();
    const run = f.podRepo.taskExecutions?.beginRun(f.parent, 1, 1, {
      runtime: 'claude',
      model: 'claude-sonnet-4-6',
      providerAccountId: 'account',
      resource: { executionTarget: 'local', containerId: 'a'.repeat(64) },
    });
    if (!run) throw new Error('Missing task ledger');
    f.podRepo.taskExecutions?.finishRun(run, 'failed', 'unknown');
    const original = f.podRepo.getOrThrow(f.parent);
    const before = f.podRepo.taskExecutions?.snapshot(f.parent);
    expect(before?.budgetCheck?.status).toBe('unavailable');
    const create = await f.prepare();
    expect(f.cm.getStatus).toHaveBeenCalledExactlyOnceWith('a'.repeat(64));
    const admitted = f.admit(create);
    await flushAdmission();
    expect(f.enqueueSession).toHaveBeenCalledExactlyOnceWith(admitted.podId);
    expect(f.podRepo.getOrThrow(f.parent)).toEqual(original);
    expect(f.podRepo.taskExecutions?.snapshot(f.parent)).toEqual(before);
    const next = f.podRepo.taskExecutions?.snapshot(admitted.podId);
    expect(next?.taskId).not.toBe(before?.taskId);
    expect(next?.tokenBudget).toBe(10000);
    const evidence = f.podRepo.dispatchPreflight?.inspect(
      admitted.podId,
      1,
      f.config.repository?.config.remote ?? '',
      'main',
      'b'.repeat(40),
    );
    expect(evidence).toMatchObject({ status: 'admitted', rerun: { ofPodId: f.parent } });
    expect(f.cm.kill).not.toHaveBeenCalled();
    expect(f.cm.execInContainer).not.toHaveBeenCalled();
  });

  it.each(['running', 'unknown'] as const)('refuses a %s source resource', async (status) => {
    const f = await fixture();
    vi.mocked(f.cm.getStatus).mockResolvedValue(status);
    await expect(f.prepare()).rejects.toMatchObject({ code: 'RERUN_SOURCE_NOT_QUIESCENT' });
    expect(f.enqueueSession).not.toHaveBeenCalled();
  });

  it.each([
    'complete',
    'killed',
  ] as const)('preserves ordinary reruns from %s sources without observing old resources', async (status) => {
    const f = await fixture();
    f.db.prepare('UPDATE pods SET status=? WHERE id=?').run(status, f.parent);
    expect(f.admit(await f.prepare()).created).toBe(true);
    expect(f.cm.getStatus).not.toHaveBeenCalled();
  });

  it('preserves an explicit warn policy without observing or exempting the old resource', async () => {
    const f = await fixture();
    vi.mocked(f.cm.getStatus).mockResolvedValue('unknown');
    const { digest: _, ...body } = f.child;
    const next = {
      ...body,
      workflow: { ...body.workflow, preflightConflictPolicy: 'warn' as const },
    };
    const config: EffectiveLaunchConfig = { ...next, digest: configurationDigest(next) };
    expect(f.admit(await f.prepare(config), config).created).toBe(true);
    expect(f.cm.getStatus).not.toHaveBeenCalled();
  });

  it('refuses failed resource observation rather than assuming deletion', async () => {
    const f = await fixture();
    vi.mocked(f.cm.getStatus).mockRejectedValue(new Error('Docker unavailable'));
    await expect(f.prepare()).rejects.toMatchObject({ code: 'RERUN_SOURCE_NOT_QUIESCENT' });
  });

  it('accepts positively observed deletion of the exact full Docker ID', async () => {
    const f = await fixture();
    vi.mocked(f.cm.getStatus).mockResolvedValue('deleted');
    expect(f.admit(await f.prepare()).created).toBe(true);
  });

  it.each([
    'queued',
    'provisioning',
    'running',
    'paused',
    'validated',
  ] as const)('does not exempt a source whose state changed to %s', async (status) => {
    const f = await fixture();
    // Simulate a concurrent lifecycle owner; admission itself must never change this row.
    f.db.prepare('UPDATE pods SET status=? WHERE id=?').run(status, f.parent);
    await expect(f.prepare()).rejects.toMatchObject({ code: 'RERUN_SOURCE_NOT_QUIESCENT' });
    expect(f.cm.getStatus).not.toHaveBeenCalled();
  });

  it('refuses automation, another owner, active process controls, aliases, sandbox and publication', async () => {
    const f = await fixture();
    await expect(
      f.prepare(f.child, 'operator', { type: 'automation', id: 'test' }),
    ).rejects.toMatchObject({ code: 'RERUN_SOURCE_NOT_QUIESCENT' });
    await expect(
      f.prepare(f.child, 'other', { type: 'human', userId: 'other' }),
    ).rejects.toMatchObject({ code: 'RERUN_SOURCE_NOT_QUIESCENT' });
    f.isIdle.mockReturnValue(false);
    await expect(f.prepare()).rejects.toMatchObject({ code: 'RERUN_SOURCE_NOT_QUIESCENT' });
    f.isIdle.mockReturnValue(true);
    for (const changes of [
      { containerId: 'docker-name' },
      { containerId: 'a'.repeat(64), executionTarget: 'sandbox' as const },
      {
        containerId: 'a'.repeat(64),
        executionTarget: 'local' as const,
        prUrl: 'https://github.com/o/r/pull/1',
      },
    ]) {
      if ('executionTarget' in changes) f.podRepo.update(f.parent, { containerId: null });
      f.podRepo.update(f.parent, changes);
      await expect(f.prepare()).rejects.toMatchObject({ code: 'RERUN_SOURCE_NOT_QUIESCENT' });
    }
    expect(f.cm.getStatus).not.toHaveBeenCalled();
  });

  it('refuses unsettled worker evidence before even observing the resource', async () => {
    const f = await fixture();
    f.podRepo.taskExecutions?.beginRun(f.parent, 1, 1, {
      runtime: 'claude',
      model: 'claude-sonnet-4-6',
      providerAccountId: 'account',
      resource: { executionTarget: 'local', containerId: 'a'.repeat(64) },
    });
    await expect(f.prepare()).rejects.toMatchObject({ code: 'TASK_EXECUTION_UNSETTLED' });
    expect(f.cm.getStatus).not.toHaveBeenCalled();
  });

  it('rechecks resource binding after awaiting observation and again inside admission', async () => {
    const f = await fixture();
    vi.mocked(f.cm.getStatus).mockImplementation(async () => {
      f.podRepo.update(f.parent, { containerId: 'b'.repeat(64) });
      return 'stopped';
    });
    await expect(f.prepare()).rejects.toMatchObject({ code: 'RERUN_SOURCE_NOT_QUIESCENT' });
    vi.mocked(f.cm.getStatus).mockResolvedValue('stopped');
    const create = await f.prepare();
    f.podRepo.update(f.parent, { status: 'queued' });
    expect(() => f.admit(create)).toThrow('confirmed stopped local Docker resource');
    await flushAdmission();
    expect(f.enqueueSession).not.toHaveBeenCalled();
  });

  it('does not exempt unrelated failed conflicts or ordinary launches or unprepared reruns', async () => {
    const f = await fixture();
    expect(() =>
      f.n.snapshots.admit({
        config: f.child,
        requestDigest: f.child.digest,
        createPod: () =>
          f.resolved.createResolvedSession(f.child, 'operator', undefined, {
            type: 'human',
            userId: 'operator',
          }).id,
      }),
    ).toThrow('touches overlap');
    const ordinary = await resolveLaunch(
      {
        repositoryId: 'repo-a',
        task: 'Ordinary overlapping work',
        work: { touches: ['src/'] },
        overrides: { workflow: { preflightConflictPolicy: 'block' } },
      },
      f.n.services,
    );
    expect(() => f.admit(awaitableCreate(f, ordinary), ordinary)).toThrow('touches overlap');
    const unrelated = await resolveLaunch(
      {
        repositoryId: 'repo-a',
        task: 'Unrelated preserved work',
        work: { touches: ['src/'], baseBranch: 'main' },
        overrides: { workflow: { preflightConflictPolicy: 'warn' } },
      },
      f.n.services,
    );
    f.n.admit(unrelated);
    expect(() => f.admit(awaitableCreate(f, f.child))).toThrow('touches overlap');
    const create = await f.prepare();
    expect(() => f.admit(create)).toThrow('touches overlap');
  });

  it('still validates exact task identity transactionally and rolls back a mismatched rerun', async () => {
    const f = await fixture();
    const { digest: _, ...body } = f.child;
    const changedBody = { ...body, task: 'A different task' };
    const changed: EffectiveLaunchConfig = {
      ...changedBody,
      digest: configurationDigest(changedBody),
    };
    const create = await f.prepare(changed);
    const count = f.podRepo.list().length;
    expect(() => f.admit(create, changed)).toThrow('preserve the referenced request');
    expect(f.podRepo.list()).toHaveLength(count);
    expect(f.db.prepare('SELECT * FROM execution_rerun_intents').all()).toHaveLength(0);
  });
});

function awaitableCreate(f: Awaited<ReturnType<typeof fixture>>, config: EffectiveLaunchConfig) {
  return () =>
    f.resolved.createResolvedSession(config, 'operator', undefined, {
      type: 'human',
      userId: 'operator',
    });
}
