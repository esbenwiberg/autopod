import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFailingValidationResult } from '../test-utils/mock-helpers.js';
import {
  materializeCheckpointFixture,
  retainedCheckpointFixture,
} from '../test-utils/retained-checkpoint-helpers.js';
import * as checkpointSource from '../worktrees/retained-checkpoint-source.js';
import { verifyArtifactSnapshot } from './artifact-snapshot-receipt.js';
import { verifiedCheckpointApprovalSnapshot } from './checkpoint-approval-snapshot.js';
import { checkpointHash } from './retained-checkpoint-repository.js';

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
  it('resolves the historical transport-blocked failure without rerunning, then checks a separately authorized corrected generation', async () => {
    const f = await retainedCheckpointFixture('wakeup', true);
    fixtures.push(f);
    vi.stubEnv('DATA_DIR', f.root);
    await materializeCheckpointFixture(f);
    const actualProof = checkpointSource.verifyRetainedCheckpointSource;
    // Reproduce deployed #477's exact raw-HEAD gate, with the REAL transport.
    const legacyGate = vi
      .spyOn(checkpointSource, 'verifyRetainedCheckpointSource')
      .mockImplementation(async (input) => {
        const proof = await actualProof(input);
        return proof?.head === input.head ? proof : null;
      });
    const validate = vi.mocked(f.ctx.validationEngine.validate).getMockImplementation()!;
    vi.mocked(f.ctx.validationEngine.validate).mockImplementation(async (...args) => {
      await validate(...args);
      return createFailingValidationResult(args[0].podId, args[0].attempt);
    });
    await f.submit();
    await f.recovery.wait(f.input.id);
    await expect(f.manager.processPod(f.podId)).rejects.toMatchObject({
      code: 'CHECKPOINT_SOURCE_CHANGED',
    });
    legacyGate.mockRestore();
    const failed = f.pod();
    const first = f.recovery.list(f.podId)[0]!;
    expect(first.blocked?.code).toBe('CHECKPOINT_SOURCE_CHANGED');
    const observed = await f.worktrees.inspectSourceAdoption(failed.worktreePath!, failed.branch);
    const input = {
      id: 'resolve-failed-transport',
      resolveFailureOf: first.id,
      expectedGeneration: failed.lifecycleGeneration,
      expectedResultHash: checkpointHash(failed.lastValidationResult),
      checkpointHead: observed.commitSha,
      reason:
        'Resolve verified transport metadata only; retain the failed result and all accounting',
    };
    const before = f.ctx.podRepo.taskRetries!.state(f.podId);
    await expect(
      f.recovery.submit(f.podId, { ...input, expectedResultHash: 'f'.repeat(64) }, f.actor),
    ).rejects.toThrow();
    await expect(
      f.recovery.submit(f.podId, { ...input, setupCommand: 'true' }, f.actor),
    ).rejects.toThrow();
    const resolved = await f.recovery.submit(f.podId, input, f.actor);
    expect(resolved.checked?.result).toEqual(failed.lastValidationResult);
    expect(resolved.blocked).toEqual(first.blocked);
    expect(await f.recovery.submit(f.podId, input, f.actor)).toEqual(resolved);
    expect(f.ctx.podRepo.taskRetries!.state(f.podId)).toEqual(before);
    expect(f.ctx.validationEngine.validate).toHaveBeenCalledTimes(1);
    expect(f.pod().lifecycleGeneration).toBe(2);
    const next = {
      id: 'corrected-setup-checks',
      expectedGeneration: 2,
      expectedResultHash: input.expectedResultHash,
      checkpointHead: observed.commitSha,
      reason:
        'One fresh generation with dependency bootstrap before lint; no waiver or counter reset',
      setupCommand: 'npm ci',
    };
    vi.mocked(f.cm.getStatus).mockResolvedValue('stopped');
    vi.mocked(f.cm.getResourceKey!).mockImplementation(async (id) =>
      f.resourceKey.replace(f.containerId, id),
    );
    await expect(f.recovery.submit(f.podId, next, f.actor)).rejects.toThrow('one-shot');
    f.ctx.podRepo.taskRetries!.authorize(
      f.podId,
      'extra-checks-authority',
      'Owner permits exactly one additional checks execution',
      f.actor,
    );
    await f.recovery.submit(f.podId, next, f.actor);
    await f.recovery.wait(next.id);
    expect(f.recovery.list(f.podId)[0]?.blocked).toBeNull();
    const fresh = '33333333-3333-4333-8333-333333333333';
    vi.mocked(f.cm.getStatus).mockImplementation(async (id) =>
      id === fresh ? 'running' : 'stopped',
    );
    vi.mocked(f.cm.spawn).mockResolvedValue(fresh);
    vi.mocked(f.ctx.validationEngine.validate).mockImplementation(validate);
    await f.manager.processPod(f.podId);
    expect(f.pod().status).toBe('validated');
    expect(f.pod().lifecycleGeneration).toBe(3);
    expect(f.pod().validationAttempts).toBe(4);
    expect(f.ctx.validationEngine.validate).toHaveBeenLastCalledWith(
      expect.objectContaining({ validationSetupCommand: 'npm ci' }),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(
      f.ctx.podRepo.taskRetries!.state(f.podId).authorizations[0]?.usedByAttemptId,
    ).toBeTruthy();
    expect(f.ctx.podRepo.listReferencedContainerIds()).toEqual(
      expect.arrayContaining([f.containerId, failed.containerId!]),
    );
    expect(f.ctx.runtime.spawn).not.toHaveBeenCalled();
    expect(f.ctx.worktreeManager.pushBranch).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    'a later explicit approval (frozen launch=%s) reaches delivery preparation without waking either sandbox or recollecting reports',
    async (native) => {
      const f = await retainedCheckpointFixture('wakeup', native);
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
    },
  );
  it.each([
    { kind: 'validation', native: false },
    { kind: 'wakeup', native: false },
    { kind: 'validation', native: true },
    { kind: 'wakeup', native: true },
  ] as const)(
    'takes legacy $kind (frozen launch=$native) to a fresh validated generation without a worker or delivery',
    async ({ kind, native }) => {
      const f = await retainedCheckpointFixture(kind, native);
      fixtures.push(f);
      vi.stubEnv('DATA_DIR', f.root);
      await materializeCheckpointFixture(f);
      const originalWorktree = f.pod().worktreePath!;
      const original = f.pod().lastValidationResult;
      const priorAttempts = f.pod().validationAttempts;
      const digest = f.pod().launchConfigDigest;
      if (native) expect(digest).toMatch(/^[a-f0-9]{64}$/);
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
      expect(operation.checked?.source?.head).not.toBe(operation.prepared?.head);
      expect(operation.checked?.source?.checkpoints.length).toBeGreaterThan(0);
      expect(operation.originalEvidence.result).toEqual(original);
      expect(current.lifecycleGeneration).toBe(2);
      expect(current.validationAttempts).toBe(priorAttempts + 1);
      expect(current.launchConfigDigest).toBe(digest);
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
      expect(
        await readFile(
          path.join(current.artifactsPath!, '.autopod/evidence/fixture/fixture-report.txt'),
          'utf8',
        ),
      ).toBe('Fresh generated evidence\n');
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
