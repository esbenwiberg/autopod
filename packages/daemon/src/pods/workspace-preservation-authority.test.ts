import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createTestContext } from '../test-utils/mock-helpers.js';
import { createPodManager } from './pod-manager.js';
import { captureValidationMutationGuard } from './validation-recovery-policy.js';
import { WorkspaceCheckpointController } from './workspace-checkpoint-controller.js';

describe('public preservation captured authority composition', () => {
  for (const route of ['direct', 'controller'] as const) {
    it.each(['generation', 'resource', 'dispatch'] as const)(
      `${route} refuses %s custody loss before physical checkpoint I/O`,
      async (change) => {
        const ctx = createTestContext();
        const root = await mkdtemp(path.join(os.tmpdir(), 'preservation-authority-'));
        let release = () => {};
        let entered = () => {};
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const started = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const source = path.join(root, 'source.txt');
        const report = path.join(root, 'ignored-report.txt');
        await writeFile(source, 'original source');
        await writeFile(report, 'original failed assertion');
        const io = vi.fn(async (assertCurrent: () => void) => {
          entered();
          await gate;
          assertCurrent();
          await writeFile(source, 'unsafe host promotion');
          await writeFile(report, 'unsafe guest checkpoint');
          throw new Error('Physical mutation must be fenced');
        });
        ctx.deps.sandboxWorkspaceCheckpoint = async ({ assertCurrent }) => io(assertCurrent);
        if (route === 'controller') {
          ctx.deps.workspaceCheckpointController = new WorkspaceCheckpointController({
            captureAuthority: (id) =>
              captureValidationMutationGuard(ctx.podRepo, ctx.podRepo.getOrThrow(id)),
            observe: async () => ({ head: 'a'.repeat(40), tree: 'b'.repeat(40), dirty: true }),
            checkpoint: async (_id, _reason, _sequence, assertCurrent) => io(assertCurrent),
            records: {
              save: async () => {},
              latest: async () => null,
              latestVerified: async () => null,
              incomplete: async () => [],
            },
          });
        }
        const manager = createPodManager(ctx.deps);
        const pod = manager.createSession(
          { profileName: 'test-profile', task: 'Preserve original evidence' },
          'operator',
        );
        ctx.podRepo.update(pod.id, { status: 'failed', containerId: null });
        ctx.podRepo.update(pod.id, {
          executionTarget: 'sandbox',
          containerId: '11111111-1111-4111-8111-111111111111',
          worktreePath: root,
        });
        vi.mocked(ctx.containerManager.getStatus).mockResolvedValue('running');
        const pending = manager.preserveWorkspace(pod.id, 'authority regression');
        void pending.catch(() => {});
        try {
          await started;
          if (change === 'generation') ctx.podRepo.incrementLifecycleGeneration(pod.id);
          else if (change === 'resource')
            ctx.podRepo.update(pod.id, { containerId: 'replacement' });
          else {
            const retries = ctx.podRepo.taskRetries;
            const ledger = ctx.podRepo.validationExecutions;
            if (!retries || !ledger) throw new Error('Missing real validation ledger');
            const current = ctx.podRepo.getOrThrow(pod.id);
            const admission = retries.admit(
              pod.id,
              current.lifecycleGeneration,
              {
                source: 'a'.repeat(64),
                contract: 'b'.repeat(64),
                commands: 'c'.repeat(64),
                environment: null,
                implementation: null,
              },
              'd'.repeat(64),
              [],
            );
            retries.start(admission.id);
            expect(ledger.dispatch(current, admission.id, 1, 'test-scope')).not.toBeNull();
          }
          release();
          await expect(pending).rejects.toThrow();
          expect(await readFile(source, 'utf8')).toBe('original source');
          expect(await readFile(report, 'utf8')).toBe('original failed assertion');
          expect(ctx.containerManager.execInContainer).not.toHaveBeenCalled();
          expect(ctx.containerManager.extractDirectoryFromContainer).not.toHaveBeenCalled();
          expect(ctx.containerManager.kill).not.toHaveBeenCalled();
          expect(ctx.worktreeManager.cleanup).not.toHaveBeenCalled();
        } finally {
          release();
          await pending.catch(() => {});
          ctx.db.close();
          await rm(root, { recursive: true, force: true });
        }
      },
    );
  }
});
