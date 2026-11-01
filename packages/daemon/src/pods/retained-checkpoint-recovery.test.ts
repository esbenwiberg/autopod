import { randomBytes } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPodTokenIssuer } from '../crypto/pod-tokens.js';
import {
  createFailingValidationResult,
  createPassingValidationResult,
} from '../test-utils/mock-helpers.js';
import { retainedCheckpointFixture } from '../test-utils/retained-checkpoint-helpers.js';
import { createRetainedCheckpointRecovery } from './retained-checkpoint-recovery.js';
import {
  assertCheckpointResourceNotRetained,
  checkpointCredentialEpoch,
  checkpointHash,
  createRetainedCheckpointRepository,
} from './retained-checkpoint-repository.js';
import { assertSourceResourceReleasable } from './source-custody-guards.js';
import { assertValidationResourceSettled } from './validation-execution-evidence.js';

const fixtures: Awaited<ReturnType<typeof retainedCheckpointFixture>>[] = [];
async function fixture(kind: 'validation' | 'wakeup' = 'validation') {
  const f = await retainedCheckpointFixture(kind);
  fixtures.push(f);
  return f;
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.recovery.wait(f.input.id);
    if (f.ctx.db.open) f.ctx.db.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

describe('explicit retained-checkpoint recovery', () => {
  it.each(['validation', 'wakeup'] as const)(
    'prepares the real legacy %s shape without claiming historical settlement or touching the original',
    async (kind) => {
      const f = await fixture(kind);
      const before = f.ctx.podRepo.taskExecutions!.snapshot(f.podId);
      await f.submit();
      await f.recovery.wait(f.input.id);
      const op = f.recovery.list(f.podId)[0]!;
      expect(
        op.blocked,
        String(
          (vi.mocked(f.deps.logger.error).mock.calls[0]?.[0] as { err?: unknown } | undefined)?.err,
        ),
      ).toBeNull();
      expect(op.activated).toEqual({ generation: 2 });
      expect(op.originalEvidence.result).toEqual(f.result);
      expect(op.containerId).toBe(f.containerId);
      expect(f.pod()).toMatchObject({
        lifecycleGeneration: 2,
        status: 'queued',
        containerId: null,
        worktreePath: f.prepared.worktree,
        recoveryWorktreePath: f.prepared.worktree,
        skipAgent: true,
        autoApprove: false,
        lastValidationResult: null,
      });
      expect(f.pod().options.validationSuite).toBe('custom');
      expect(f.deps.enqueue).toHaveBeenCalledExactlyOnceWith(f.podId);
      expect(f.cm.start).not.toHaveBeenCalled();
      expect(f.cm.stop).not.toHaveBeenCalled();
      expect(f.cm.kill).not.toHaveBeenCalled();
      expect(f.cm.spawn).not.toHaveBeenCalled();
      expect(f.cm.execInContainer).not.toHaveBeenCalled();
      expect(f.cm.extractDirectoryFromContainer).not.toHaveBeenCalled();
      expect(f.ctx.podRepo.listReferencedContainerIds()).toContain(f.containerId);
      expect(f.ctx.podRepo.taskExecutions!.snapshot(f.podId).taskId).toBe(before.taskId);
      expect(f.ctx.podRepo.taskExecutions!.snapshot(f.podId).agentRunCount).toBe(
        before.agentRunCount,
      );
      expect(() => assertValidationResourceSettled(f.ctx.db, f.containerId)).toThrow(
        'retains unknown',
      );
      expect(() => assertSourceResourceReleasable(f.ctx.db, f.containerId)).toThrow(
        'retains unknown',
      );
      expect(() => f.ctx.podRepo.delete(f.podId)).toThrow('remain retained');
      if (kind === 'wakeup') {
        expect(f.ctx.podRepo.sandboxWakeups!.listForPod(f.podId)[0]).toMatchObject({
          endedAt: null,
          settledBy: null,
          evidence: [],
        });
        expect(() => f.ctx.podRepo.sandboxWakeups!.assertReleasable(f.containerId)).toThrow(
          'outcome-unknown',
        );
        expect(() => f.ctx.podRepo.sandboxWakeups!.assertPodReleasable(f.podId)).not.toThrow();
      }
    },
  );

  it('revokes old credentials at claim and keeps the new epoch across repository reconstruction', async () => {
    const f = await fixture();
    const key = path.join(f.root, 'key');
    await writeFile(key, randomBytes(32));
    const issuer = createPodTokenIssuer(key, (id) => checkpointCredentialEpoch(f.ctx.db, id));
    const old = issuer.generate(f.podId);
    await f.submit();
    await f.recovery.wait(f.input.id);
    expect(issuer.verify(old)).toBeNull();
    const replacement = issuer.generate(f.podId);
    const reopened = createRetainedCheckpointRepository(f.ctx.db);
    expect(reopened.latest(f.podId)?.id).toBe(f.input.id);
    expect(
      createPodTokenIssuer(key, (id) => checkpointCredentialEpoch(f.ctx.db, id)).verify(
        replacement,
      ),
    ).toBe(f.podId);
  });

  it('observes a replay after activation without another allocation, queue entry or generation increment', async () => {
    const f = await fixture();
    await f.submit();
    await f.recovery.wait(f.input.id);
    const first = f.recovery.list(f.podId)[0];
    expect(await f.submit()).toEqual(first);
    expect(f.deps.prepare).toHaveBeenCalledTimes(1);
    expect(f.deps.enqueue).toHaveBeenCalledTimes(1);
    expect(f.pod().lifecycleGeneration).toBe(2);
    await expect(
      f.recovery.submit(f.podId, { ...f.input, checkpointHead: 'e'.repeat(40) }, f.actor),
    ).rejects.toMatchObject({ code: 'CHECKPOINT_RECOVERY_CONFLICT' });
    await expect(
      f.recovery.submit(f.podId, f.input, { type: 'human', userId: 'another' }),
    ).rejects.toMatchObject({ code: 'CHECKPOINT_RECOVERY_CONFLICT' });
  });

  it('retains a failed/interrupted preparation rather than silently trying again', async () => {
    const f = await fixture();
    vi.mocked(f.deps.prepare!).mockRejectedValueOnce(new Error('source snapshot failed'));
    await f.submit();
    await f.recovery.wait(f.input.id);
    const op = await f.submit();
    expect(op.blocked?.code).toBe('CHECKPOINT_PREPARATION_FAILED');
    expect(op.activated).toBeNull();
    expect(f.pod().containerId).toBe(f.containerId);
    expect(f.pod().lastValidationResult).toEqual(f.result);
    expect(f.deps.enqueue).not.toHaveBeenCalled();
    expect(f.deps.prepare).toHaveBeenCalledTimes(1);
    expect(() => f.ctx.podRepo.update(f.podId, { skipAgent: false })).toThrow('owns this task');
  });

  it.each(['running', 'deleted', 'unknown'] as const)(
    'rejects provider %s without mutation',
    async (status) => {
      const f = await fixture();
      vi.mocked(f.cm.getStatus).mockResolvedValue(status);
      await expect(f.submit()).rejects.toThrow('retained stopped');
      expect(f.recovery.list(f.podId)).toEqual([]);
      expect(f.deps.prepare).not.toHaveBeenCalled();
      expect(f.cm.start).not.toHaveBeenCalled();
    },
  );

  it('refuses stale generation/result/head and nonhuman claims', async () => {
    const f = await fixture();
    for (const input of [
      { ...f.input, expectedGeneration: 8 },
      { ...f.input, expectedResultHash: '0'.repeat(64) },
      { ...f.input, checkpointHead: 'e'.repeat(40) },
    ])
      await expect(f.recovery.submit(f.podId, input, f.actor)).rejects.toThrow();
    await expect(
      f.recovery.submit(f.podId, f.input, { type: 'automation', id: 'worker' }),
    ).rejects.toThrow('human');
    expect(f.recovery.list(f.podId)).toEqual([]);
  });

  it('rechecks ownership after provider observation', async () => {
    const f = await fixture();
    vi.mocked(f.cm.getStatus).mockImplementation(async () => {
      f.ctx.podRepo.incrementLifecycleGeneration(f.podId);
      return 'stopped';
    });
    await expect(f.submit()).rejects.toMatchObject({ code: 'STALE_CHECKPOINT_RECOVERY' });
    expect(f.deps.prepare).not.toHaveBeenCalled();
  });

  it('keeps normal controls and coding workers out while admitting exactly the owned checks invocation', async () => {
    const f = await fixture();
    await f.submit();
    await f.recovery.wait(f.input.id);
    await expect(f.manager.triggerValidation(f.podId, { force: true })).rejects.toThrow();
    const original = f.result;
    await f.recovery.process(f.podId, async () => {
      expect(() => f.ctx.podRepo.retainedCheckpoints!.assertWorkerAllowed(f.podId)).toThrow(
        'checks only',
      );
      f.deps.transition(f.pod(), 'provisioning');
      f.deps.transition(f.pod(), 'running');
      f.deps.transition(f.pod(), 'validating');
      f.ctx.podRepo.update(f.podId, {
        containerId: 'new-sandbox',
        skipAgent: false,
        lastValidationResult: createPassingValidationResult(f.podId),
        artifactsPath: '/fixture/new-report-snapshot',
      });
      f.deps.transition(f.pod(), 'validated');
    });
    const op = f.recovery.list(f.podId)[0]!;
    expect(op.checked?.result.overall).toBe('pass');
    expect(op.checked?.resultHash).toBe(checkpointHash(f.pod().lastValidationResult));
    expect(op.originalEvidence.result).toEqual(original);
    expect(() => assertCheckpointResourceNotRetained(f.ctx.db, f.containerId)).toThrow(
      'retains unknown',
    );
    expect(() => assertCheckpointResourceNotRetained(f.ctx.db, 'new-sandbox')).not.toThrow();
  });

  it('does not certify a fresh pass without preserved new reports', async () => {
    const f = await fixture();
    await f.submit();
    await f.recovery.wait(f.input.id);
    await expect(
      f.recovery.process(f.podId, async () => {
        f.deps.transition(f.pod(), 'provisioning');
        f.deps.transition(f.pod(), 'running');
        f.deps.transition(f.pod(), 'validating');
        f.ctx.podRepo.update(f.podId, {
          lastValidationResult: createPassingValidationResult(f.podId),
        });
        f.deps.transition(f.pod(), 'validated');
      }),
    ).rejects.toMatchObject({ code: 'CHECKPOINT_REPORTS_UNVERIFIED' });
    expect(f.recovery.list(f.podId)[0]?.checked).toBeNull();
    expect(f.recovery.list(f.podId)[0]?.blocked?.code).toBe('CHECKPOINT_REPORTS_UNVERIFIED');
  });

  it('coalesces concurrent same-request selections across asynchronous provider/source observations', async () => {
    const f = await fixture();
    await Promise.all([f.submit(), f.submit(), f.submit()]);
    await f.recovery.wait(f.input.id);
    expect(f.deps.prepare).toHaveBeenCalledTimes(1);
    expect(f.deps.enqueue).toHaveBeenCalledTimes(1);
    expect(f.pod().lifecycleGeneration).toBe(2);
  });

  it('coalesces queue callbacks and never automatically repeats an interrupted checks invocation after restart', async () => {
    const f = await fixture();
    await f.submit();
    await f.recovery.wait(f.input.id);
    const run = vi.fn(async () => {
      f.deps.transition(f.pod(), 'provisioning');
      f.ctx.podRepo.update(f.podId, {
        lastValidationResult: createFailingValidationResult(f.podId),
      });
      f.deps.transition(f.pod(), 'failed');
    });
    await Promise.all([f.recovery.process(f.podId, run), f.recovery.process(f.podId, run)]);
    expect(run).toHaveBeenCalledTimes(1);
    const interrupted = await fixture();
    await interrupted.submit();
    await interrupted.recovery.wait(interrupted.input.id);
    interrupted.ctx.podRepo.retainedCheckpoints!.append(interrupted.input.id, 'checking', {
      generation: 2,
    });
    const restarted = createRetainedCheckpointRecovery(interrupted.deps);
    const replay = vi.fn(async () => {});
    await expect(restarted.process(interrupted.podId, replay)).rejects.toThrow('not eligible');
    expect(replay).not.toHaveBeenCalled();
    expect(interrupted.cm.spawn).not.toHaveBeenCalled();
    expect(interrupted.pod().containerId).toBeNull();
  });

  it('blocks changed source before fresh resource allocation and retains original evidence', async () => {
    const f = await fixture();
    await f.submit();
    await f.recovery.wait(f.input.id);
    f.worktrees.inspectSourceAdoption.mockResolvedValue({
      branch: f.pod().branch,
      commitSha: f.prepared.head,
      treeSha: 'e'.repeat(40),
      worktreeClean: true,
    });
    const run = vi.fn(async () => {});
    await expect(f.recovery.process(f.podId, run)).rejects.toMatchObject({
      code: 'CHECKPOINT_SOURCE_CHANGED',
    });
    expect(run).not.toHaveBeenCalled();
    expect(f.recovery.list(f.podId)[0]).toMatchObject({
      checked: null,
      blocked: { code: 'CHECKPOINT_SOURCE_CHANGED' },
      originalEvidence: { result: f.result },
    });
    expect(f.ctx.podRepo.taskRetries!.state(f.podId).authorizations).toEqual([]);
  });

  it('SQLite forbids rewriting or deleting original evidence and step receipts', async () => {
    const f = await fixture();
    await f.submit();
    await f.recovery.wait(f.input.id);
    expect(() =>
      f.ctx.db
        .prepare('UPDATE retained_checkpoint_recoveries SET original_evidence=? WHERE id=?')
        .run('{}', f.input.id),
    ).toThrow('immutable');
    expect(() =>
      f.ctx.db.prepare('DELETE FROM retained_checkpoint_recoveries WHERE id=?').run(f.input.id),
    ).toThrow('cannot be deleted');
    expect(() =>
      f.ctx.db
        .prepare('DELETE FROM retained_checkpoint_recovery_events WHERE recovery_id=?')
        .run(f.input.id),
    ).toThrow('cannot be deleted');
  });
});
