import { execFile } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFailingValidationResult } from '../test-utils/mock-helpers.js';
import {
  materializeCheckpointFixture,
  retainedCheckpointFixture,
} from '../test-utils/retained-checkpoint-helpers.js';
import { LocalWorktreeManager } from '../worktrees/local-worktree-manager.js';
import { verifiedCheckpointApprovalSnapshot } from './checkpoint-approval-snapshot.js';
import { checkpointHash } from './retained-checkpoint-repository.js';
import { assertSourceDeliveryAllowed } from './source-custody-guards.js';

const exec = promisify(execFile);
const fixtures: Awaited<ReturnType<typeof retainedCheckpointFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.recovery.wait(f.input.id);
    if (f.ctx.db.open) f.ctx.db.close();
    await rm(f.root, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});

describe('retained repaired source through real manager checks (provider and engine mocked)', () => {
  it('records failed checks without coding feedback, automatic retries or destructive legacy recovery', async () => {
    const f = await retainedCheckpointFixture('validation');
    fixtures.push(f);
    vi.stubEnv('DATA_DIR', f.root);
    await materializeCheckpointFixture(f);
    f.worktrees.selectRetainedContinuationSource = vi.fn(async (input) => {
      const source = await f.worktrees.inspectSourceAdoption(input.worktreePath, input.branch);
      return {
        head: source.commitSha,
        tree: source.treeSha,
        baseCommitSha: f.input.checkpointHead,
      };
    });
    vi.mocked(f.ctx.validationEngine.validate).mockImplementation(async (config) =>
      createFailingValidationResult(config.podId, config.attempt),
    );
    f.ctx.podRepo.taskRetries!.authorize(
      f.podId,
      'one-retained-failure-check',
      'One isolated check while retaining original execution and accounting',
      f.actor,
    );
    await f.recovery.continueRetained(f.podId, f.input, f.actor);
    await f.recovery.wait(f.input.id);
    await f.manager.processPod(f.podId);
    expect(f.recovery.list(f.podId)[0]).toMatchObject({
      blocked: null,
      checked: { result: { overall: 'fail' } },
    });
    expect(() => assertSourceDeliveryAllowed(f.ctx.db, f.podId)).toThrow('current exact-source');
    expect(() => f.manager.assertCanRework(f.podId)).toThrow('Retained continuation owns');
    expect(() => f.manager.assertCanRetryValidation(f.podId)).toThrow('Retained continuation owns');
    expect(f.ctx.validationEngine.validate).toHaveBeenCalledTimes(1);
    expect(f.ctx.runtime.spawn).not.toHaveBeenCalled();
    expect(f.ctx.runtime.resume).not.toHaveBeenCalled();
    expect(f.ctx.worktreeManager.mergeBranch).not.toHaveBeenCalled();
    expect(f.cm.kill).not.toHaveBeenCalled();
  });
  it('holds an apparent pass without independent review instead of admitting publication', async () => {
    const f = await retainedCheckpointFixture('validation');
    fixtures.push(f);
    vi.stubEnv('DATA_DIR', f.root);
    await materializeCheckpointFixture(f);
    f.worktrees.selectRetainedContinuationSource = vi.fn(async (input) => {
      const source = await f.worktrees.inspectSourceAdoption(input.worktreePath, input.branch);
      return {
        head: source.commitSha,
        tree: source.treeSha,
        baseCommitSha: f.input.checkpointHead,
      };
    });
    f.ctx.podRepo.taskRetries!.authorize(
      f.podId,
      'one-retained-check',
      'One fresh isolated check; original unknown execution stays retained',
      f.actor,
    );
    await f.recovery.continueRetained(f.podId, f.input, f.actor);
    await f.recovery.wait(f.input.id);
    await expect(f.manager.processPod(f.podId)).rejects.toMatchObject({
      code: 'CONTINUATION_REVIEW_UNVERIFIED',
    });
    expect(f.recovery.list(f.podId)[0]).toMatchObject({
      checked: null,
      blocked: { code: 'CONTINUATION_REVIEW_UNVERIFIED' },
    });
    expect(() => assertSourceDeliveryAllowed(f.ctx.db, f.podId)).toThrow('current exact-source');
    expect(f.ctx.runtime.spawn).not.toHaveBeenCalled();
    expect(f.ctx.worktreeManager.mergeBranch).not.toHaveBeenCalled();
    expect(f.cm.kill).not.toHaveBeenCalled();
  });

  it('pins manual repair, runs new checks/review, preserves reports and waits for another approval', async () => {
    const f = await retainedCheckpointFixture('validation');
    fixtures.push(f);
    vi.stubEnv('DATA_DIR', f.root);
    const result = { ...f.result, infrastructureFailure: undefined };
    f.ctx.podRepo.update(f.podId, { lastValidationResult: result });
    f.input.expectedResultHash = checkpointHash(result);
    await materializeCheckpointFixture(f);
    const validate = vi.mocked(f.ctx.validationEngine.validate).getMockImplementation();
    if (!validate) throw new Error('Missing validation fixture implementation');
    vi.mocked(f.ctx.validationEngine.validate).mockImplementation(async (config) => ({
      ...(await validate(config)),
      taskReview: {
        status: 'pass',
        reasoning: 'Fixture independent review of selected repair',
        issues: [],
        model: 'fixture',
        screenshots: [],
        diff: config.diff,
      },
    }));
    const original = f.pod();
    f.worktrees.selectRetainedContinuationSource = vi.fn(async (input) => {
      const source = await f.worktrees.inspectSourceAdoption(input.worktreePath, input.branch);
      return {
        head: source.commitSha,
        tree: source.treeSha,
        baseCommitSha: f.input.checkpointHead,
      };
    });
    const real = new LocalWorktreeManager({
      cacheDir: path.join(f.root, 'cache'),
      worktreeDir: path.join(f.root, 'unused'),
      logger: f.ctx.deps.logger,
    });
    f.worktrees.assertSourceDescendsFrom = real.assertSourceDescendsFrom.bind(real);
    await f.recovery.continueRetained(f.podId, { ...f.input, prepareOnly: true }, f.actor);
    await f.recovery.wait(f.input.id);
    const prepared = f.recovery.list(f.podId)[0]!.prepared!;
    expect(f.pod().lifecycleGeneration).toBe(original.lifecycleGeneration);
    expect(f.cm.spawn).not.toHaveBeenCalled();
    await writeFile(
      path.join(prepared.worktree, 'source.ts'),
      'export const preserved = true;\nexport const repaired = true;\n',
    );
    await exec('git', ['add', 'source.ts'], { cwd: prepared.worktree });
    await exec(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-m',
        'fix: targeted retained repair',
      ],
      { cwd: prepared.worktree },
    );
    const head = (
      await exec('git', ['rev-parse', 'HEAD'], { cwd: prepared.worktree })
    ).stdout.trim();
    f.ctx.podRepo.taskRetries!.authorize(
      f.podId,
      'one-fresh-repaired-source-check',
      'One validation on explicitly repaired isolated source; retain original failure and retry accounting',
      f.actor,
    );
    const retries = f.ctx.podRepo.taskRetries!.state(f.podId);
    await f.recovery.checkCandidate(
      f.podId,
      f.input.id,
      {
        expectedGeneration: original.lifecycleGeneration,
        expectedResultHash: f.input.expectedResultHash,
        candidateHead: head,
        reason:
          'Select committed targeted repair for fresh independent validation; retain original resource',
      },
      f.actor,
    );
    expect(() => assertSourceDeliveryAllowed(f.ctx.db, f.podId)).toThrow('current exact-source');
    await f.manager.processPod(f.podId);
    const current = f.pod();
    const record = f.recovery.list(f.podId)[0]!;
    expect(record.blocked, current.failureReason ?? JSON.stringify(record)).toBeNull();
    expect(current.status, current.failureReason ?? '').toBe('validated');
    expect(record.checked?.result.overall).toBe('pass');
    expect(record.checked?.result.taskReview?.status).toBe('pass');
    expect(record.selected?.head).toBe(head);
    expect(record.prepared?.head).toBe(f.input.checkpointHead);
    expect(current.validationAttempts).toBe(original.validationAttempts + 1);
    expect(f.ctx.podRepo.taskRetries!.state(f.podId).executedCount).toBe(retries.executedCount + 1);
    expect(f.ctx.runtime.spawn).not.toHaveBeenCalled();
    expect(f.ctx.runtime.resume).not.toHaveBeenCalled();
    expect(f.ctx.worktreeManager.mergeBranch).not.toHaveBeenCalled();
    expect(f.cm.kill).not.toHaveBeenCalled();
    expect(f.cm.start).not.toHaveBeenCalledWith(f.containerId, expect.anything());
    expect(f.cm.stop).not.toHaveBeenCalledWith(f.containerId);
    expect(await readFile(path.join(original.worktreePath!, 'source.ts'), 'utf8')).not.toContain(
      'repaired',
    );
    expect(
      await readFile(path.join(original.worktreePath!, 'ignored-report.txt'), 'utf8'),
    ).toContain('Original report');
    expect(() => assertSourceDeliveryAllowed(f.ctx.db, f.podId)).not.toThrow();
    expect(() => f.manager.assertCanRework(f.podId)).toThrow('Retained continuation owns');
    expect(() => f.manager.assertCanRetryValidation(f.podId)).toThrow('Retained continuation owns');
    await expect(f.manager.triggerValidation(f.podId, { force: true })).rejects.toMatchObject({
      code: 'CONTINUATION_SOURCE_HELD',
    });
    await expect(
      f.manager.approveSession(f.podId, {
        actor: { type: 'automation', id: 'unattended-fixture' },
        reason: 'Attempted unattended approval must not authorize retained-source delivery',
      }),
    ).rejects.toThrow('fresh authenticated human approval');
    expect(f.ctx.worktreeManager.mergeBranch).not.toHaveBeenCalled();
    expect(f.cm.kill).not.toHaveBeenCalled();
    const snapshot = await verifiedCheckpointApprovalSnapshot({
      pod: current,
      podRepo: f.ctx.podRepo,
      worktreeManager: f.worktrees,
      artifactRoot: path.join(f.root, 'artifacts', f.podId),
      assertCurrent() {},
    });
    expect(snapshot).toBe(current.artifactsPath);
    expect(snapshot).toBeTruthy();
  });
});
