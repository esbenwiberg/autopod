import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  materializeCheckpointFixture,
  retainedCheckpointFixture,
} from '../test-utils/retained-checkpoint-helpers.js';
import { verifyArtifactSnapshot } from './artifact-snapshot-receipt.js';
import { verifiedCheckpointApprovalSnapshot } from './checkpoint-approval-snapshot.js';

const fixtures: Awaited<ReturnType<typeof retainedCheckpointFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.recovery.wait(f.input.id);
    f.ctx.db.close();
    await rm(f.root, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('retained checkpoint through the real manager workflow (provider and checks mocked)', () => {
  it('a later explicit approval reaches delivery preparation without waking either sandbox or recollecting reports', async () => {
    const f = await retainedCheckpointFixture('wakeup');
    fixtures.push(f);
    vi.stubEnv('DATA_DIR', f.root);
    await materializeCheckpointFixture(f);
    await f.submit();
    await f.recovery.wait(f.input.id);
    await f.manager.processPod(f.podId);
    expect(f.pod().status).toBe('validated');
    const snapshot = f.pod().artifactsPath;
    const extractionCount = vi.mocked(f.cm.extractDirectoryFromContainer).mock.calls.length;
    f.ctx.worktreeManager.inspectSource = f.worktrees.inspectSourceAdoption;
    vi.mocked(f.ctx.worktreeManager.mergeBranch).mockRejectedValue(
      new Error('Fixture stops at external delivery boundary'),
    );
    await expect(
      f.manager.approveSession(f.podId, {
        actor: f.actor,
        reason: 'Explicit fixture approval; external delivery is deliberately not executed',
      }),
    ).rejects.toThrow();
    expect(f.ctx.worktreeManager.mergeBranch).toHaveBeenCalledTimes(1);
    expect(f.cm.start).not.toHaveBeenCalled();
    expect(f.cm.extractDirectoryFromContainer).toHaveBeenCalledTimes(extractionCount);
    expect(f.pod().artifactsPath).toBe(snapshot);
    expect(f.ctx.podRepo.sandboxWakeups!.listForPod(f.podId)[0]).toMatchObject({
      endedAt: null,
      evidence: [],
    });
    expect(f.cm.kill).not.toHaveBeenCalled();
    expect(f.ctx.podRepo.listReferencedContainerIds()).toContain(f.containerId);
  });
  it.each(['validation', 'wakeup'] as const)(
    'takes legacy %s from preserved Git to a fresh validated generation without a worker or delivery',
    async (kind) => {
      const f = await retainedCheckpointFixture(kind);
      fixtures.push(f);
      vi.stubEnv('DATA_DIR', f.root);
      await materializeCheckpointFixture(f);
      const originalWorktree = f.pod().worktreePath!;
      const original = f.pod().lastValidationResult;
      const messages: string[] = [];
      const warnings = vi.spyOn(f.ctx.deps.logger, 'warn');
      f.ctx.eventBus.subscribe((event) => {
        if (event.type === 'pod.agent_activity' && event.event.type === 'status')
          messages.push(event.event.message);
      });
      if (kind === 'validation')
        f.ctx.podRepo.taskRetries!.authorize(
          f.podId,
          'fresh-checks-permission',
          'One fresh isolated validation of the selected checkpoint; retain the original execution',
          f.actor,
        );
      const retryBefore = f.ctx.podRepo.taskRetries!.state(f.podId);
      await f.submit();
      await f.recovery.wait(f.input.id);
      expect(
        f.recovery.list(f.podId)[0]?.blocked,
        String(vi.mocked(f.deps.logger.error).mock.calls[0]?.[0]),
      ).toBeNull();
      await f.manager.processPod(f.podId).catch((error) => {
        throw new Error(
          `${String(error)}; reason=${f.pod().failureReason}; activity=${JSON.stringify(messages)}; warnings=${JSON.stringify(warnings.mock.calls, (_key, value) => (value instanceof Error ? value.stack : value))}`,
          { cause: error },
        );
      });
      const current = f.pod();
      const operation = f.recovery.list(f.podId)[0]!;
      expect(current.status, JSON.stringify({ reason: current.failureReason, operation })).toBe(
        'validated',
      );
      expect(operation.blocked).toBeNull();
      expect(operation.checked?.result.overall).toBe('pass');
      expect(operation.originalEvidence.result).toEqual(original);
      expect(current.lifecycleGeneration).toBe(2);
      expect(current.validationAttempts).toBe(2);
      const retryAfter = f.ctx.podRepo.taskRetries!.state(f.podId);
      expect(retryAfter.executedCount).toBe(retryBefore.executedCount + 1);
      expect(retryAfter.measuredDurationMs).toBeGreaterThanOrEqual(retryBefore.measuredDurationMs);
      expect(retryAfter.backoffsMs).toEqual(retryBefore.backoffsMs);
      expect(retryAfter.authorizations).toHaveLength(kind === 'validation' ? 1 : 0);
      if (kind === 'validation') expect(retryAfter.authorizations[0]?.usedByAttemptId).toBeTruthy();
      expect(current.containerId).toBe('22222222-2222-4222-8222-222222222222');
      expect(current.lastValidationResult?.executionDispatchId).toBeTruthy();
      expect(f.ctx.podRepo.validationExecutions!.unsettled(f.podId)).toBeNull();
      expect(current.worktreePath).toBe(operation.prepared?.worktree);
      expect(f.ctx.validationEngine.validate).toHaveBeenCalledTimes(1);
      expect(f.ctx.runtime.spawn).not.toHaveBeenCalled();
      expect(f.ctx.runtime.resume).not.toHaveBeenCalled();
      expect(f.cm.spawn).toHaveBeenCalledTimes(1);
      expect(f.cm.kill).not.toHaveBeenCalled();
      expect(f.cm.start).not.toHaveBeenCalledWith(f.containerId, expect.anything());
      expect(f.cm.stop).not.toHaveBeenCalledWith(f.containerId);
      expect(f.ctx.worktreeManager.create).not.toHaveBeenCalled();
      expect(f.ctx.worktreeManager.mergeBranch).not.toHaveBeenCalled();
      expect(f.ctx.worktreeManager.pushBranch).not.toHaveBeenCalled();
      expect(f.ctx.worktreeManager.cleanup).not.toHaveBeenCalled();
      expect(await readFile(path.join(originalWorktree, 'ignored-report.txt'), 'utf8')).toContain(
        'Original report',
      );
      expect(
        await readFile(path.join(operation.prepared!.snapshot, 'ignored-report.txt'), 'utf8'),
      ).toContain('Original report');
      const artifactRoot = path.join(f.root, 'artifacts', f.podId);
      await verifyArtifactSnapshot(
        current.artifactsPath!,
        artifactRoot,
        current.lifecycleGeneration,
        current.finalization?.cycle ?? 0,
      );
      const saved = {
        pod: current,
        podRepo: f.ctx.podRepo,
        worktreeManager: f.worktrees,
        artifactRoot,
        assertCurrent: vi.fn(),
      };
      const priorStarts = vi.mocked(f.cm.start!).mock.calls.length;
      expect(await verifiedCheckpointApprovalSnapshot(saved)).toBe(current.artifactsPath);
      expect(vi.mocked(f.cm.start!).mock.calls).toHaveLength(priorStarts);
      await writeFile(path.join(current.artifactsPath!, 'fresh-validation-report.txt'), 'tampered');
      await expect(verifiedCheckpointApprovalSnapshot(saved)).rejects.toMatchObject({
        code: 'ARTIFACT_SNAPSHOT_UNVERIFIED',
      });
      if (kind === 'wakeup')
        expect(f.ctx.podRepo.sandboxWakeups!.listForPod(f.podId)[0]).toMatchObject({
          endedAt: null,
          evidence: [],
        });
    },
  );
});
