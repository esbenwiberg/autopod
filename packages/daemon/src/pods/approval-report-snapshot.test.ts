import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { AutopodError } from '@autopod/shared';
import { describe, expect, it, vi } from 'vitest';
import { createDeliveryFixture } from '../test-utils/delivery-helpers.js';
import { mockPrMerge } from '../test-utils/mock-helpers.js';
import { LocalWorktreeManager } from '../worktrees/local-worktree-manager.js';
import { createApprovalDeliveryExecution } from './approval-delivery-execution.js';
import { createApprovalDeliveryPreparation } from './approval-delivery-preparation.js';
import {
  preserveApprovalReportSnapshot,
  verifiedApprovalReportSnapshot,
} from './approval-report-snapshot.js';
import { createApprovalWorkflow } from './approval-workflow.js';

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Missing fixture value');
  return value;
}

function fixture(disk = false) {
  const f = createDeliveryFixture(disk);
  f.podRepo.update('prepare', { containerId: null });
  f.podRepo.update('prepare', { executionTarget: 'sandbox' });
  f.podRepo.update('prepare', { containerId: 'container-123' });
  vi.mocked(f.cm.extractDirectoryFromContainer).mockImplementation(
    async (_id, _source, destination, _excludes, options) => {
      options?.assertCurrent?.();
      options?.onExportStarted?.();
      writeFileSync(join(destination, 'ignored-report.txt'), 'private validation and QA report');
    },
  );
  const input = () => ({
    pod: f.pod(),
    podRepo: f.podRepo,
    worktreeManager: f.worktreeManager,
    containerManager: f.cm,
    assertCurrent: () => f.context.assertApprovalCurrent(f.pod()),
  });
  async function pass(revalidate = false) {
    f.validating();
    const context = f.passContext();
    f.podRepo.update('prepare', { lastValidationResult: context.result });
    if (revalidate)
      await f.repass().completeRevalidationPass.call(f.calls, {
        ...context,
        revalDefaultBranch: 'main',
        newCommits: true,
      });
    else await f.pass().completeValidationPass.call(f.calls, context);
  }
  f.provider.mergePr.mockImplementation(mockPrMerge);
  const captured = { ...f.mainCaptured, prManagerFactory: () => f.provider };
  return {
    ...f,
    input,
    passValidation: pass,
    workflow: () =>
      createApprovalWorkflow({
        ...captured,
        ...createApprovalDeliveryPreparation(captured),
        ...createApprovalDeliveryExecution(captured),
      }),
  };
}

describe('ordinary sandbox approval report preservation', () => {
  it.each([
    ['validation', 'pr'],
    ['validation', 'branch'],
    ['revalidation', 'pr'],
    ['revalidation', 'branch'],
  ] as const)('%s (%s) saves reports before stop; approval never wakes/export again', async (kind, output) => {
    const f = fixture();
    f.podRepo.update('prepare', { options: { ...f.pod().options, output } });
    await f.passValidation(kind === 'revalidation');
    const snapshot = f.pod().artifactsPath;
    expect(snapshot).toBeTruthy();
    expect(readFileSync(join(required(snapshot), 'ignored-report.txt'), 'utf8')).toContain(
      'private validation',
    );
    expect(JSON.parse(readFileSync(`${snapshot}.receipt.json`, 'utf8')).approvalBinding).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(f.cm.extractDirectoryFromContainer).toHaveBeenCalledOnce();
    expect(vi.mocked(f.cm.extractDirectoryFromContainer).mock.invocationCallOrder[0]).toBeLessThan(
      required(vi.mocked(f.cm.stop).mock.invocationCallOrder[0]),
    );
    // Model the incident: this stopped sandbox cannot safely be woken again.
    vi.mocked(f.cm.extractDirectoryFromContainer).mockRejectedValue(
      new Error('resume outcome unknown'),
    );
    await f.workflow().approveSession('prepare');
    expect(f.cm.extractDirectoryFromContainer).toHaveBeenCalledOnce();
    expect(f.cm.start).not.toHaveBeenCalled();
    expect(f.pod().status).toBe('complete');
    expect(f.pod().artifactsPath).toBe(snapshot);
  });

  it('auto-approval reuses the snapshot after stop', async () => {
    const f = fixture();
    f.podRepo.update('prepare', { autoApprove: true });
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const approved = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    f.calls.approveSession.mockImplementation(async () => {
      try {
        await f.workflow().approveSession('prepare');
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    await f.passValidation();
    await approved;
    expect(f.pod().status).toBe('complete');
    expect(f.cm.stop).toHaveBeenCalledOnce();
    expect(f.cm.extractDirectoryFromContainer).toHaveBeenCalledOnce();
  });

  it('includes final advisory reports/results rather than an earlier validation snapshot', async () => {
    const f = fixture();
    f.passCaptured.runAdvisoryAfterValidation.mockImplementationOnce(
      async (_id, _config, result) => {
        expect(f.cm.extractDirectoryFromContainer).not.toHaveBeenCalled();
        const final = {
          ...result,
          advisoryBrowserQa: {
            status: 'pass' as const,
            reasoning: 'final QA',
            observations: [],
            screenshots: [],
            durationMs: 1,
          },
        };
        f.podRepo.update('prepare', { lastValidationResult: final });
        return final;
      },
    );
    await f.passValidation();
    await expect(verifiedApprovalReportSnapshot(f.input())).resolves.toBe(f.pod().artifactsPath);
    f.podRepo.update('prepare', {
      lastValidationResult: {
        ...required(f.pod().lastValidationResult),
        advisoryBrowserQa: undefined,
      },
    });
    await expect(verifiedApprovalReportSnapshot(f.input())).resolves.toBeNull();
  });

  it('approval joins an in-flight pre-stop export and does not race suspension with another copy', async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const copying = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.mocked(f.cm.extractDirectoryFromContainer).mockImplementationOnce(
      async (_id, _src, target, _excludes, options) => {
        options?.onExportStarted?.();
        started();
        await gate;
        writeFileSync(join(target, 'ignored-report.txt'), 'complete private report');
      },
    );
    const finalization = f.passValidation();
    await copying;
    const approval = f.workflow().approveSession('prepare');
    await new Promise((resolve) => setImmediate(resolve));
    expect(f.cm.stop).not.toHaveBeenCalled();
    expect(f.cm.extractDirectoryFromContainer).toHaveBeenCalledOnce();
    release();
    await Promise.all([finalization, approval]);
    expect(f.pod().status).toBe('complete');
    expect(f.cm.extractDirectoryFromContainer).toHaveBeenCalledOnce();
  });

  it('verifies the private snapshot after database reopen, without provider access', async () => {
    const f = fixture(true);
    await f.passValidation();
    const input = f.input();
    const snapshot = input.pod.artifactsPath;
    const reopened = f.reopen();
    vi.mocked(f.cm.extractDirectoryFromContainer).mockRejectedValue(new Error('must not wake'));
    await expect(
      verifiedApprovalReportSnapshot({
        ...input,
        pod: reopened.pods.getOrThrow('prepare'),
        podRepo: reopened.pods,
        assertCurrent: () => {},
      }),
    ).resolves.toBe(snapshot);
    expect(f.cm.extractDirectoryFromContainer).toHaveBeenCalledOnce();
  });

  it.each([
    'validation',
    'revalidation',
  ])('%s preservation failure retains the running sandbox and prevents auto-approval', async (kind) => {
    const f = fixture();
    f.podRepo.update('prepare', { autoApprove: true });
    vi.mocked(f.cm.extractDirectoryFromContainer).mockRejectedValueOnce(new Error('export failed'));
    await f.passValidation(kind === 'revalidation');
    await new Promise((resolve) => setImmediate(resolve));
    expect(f.pod()).toMatchObject({
      status: 'validated',
      containerId: 'container-123',
      artifactsPath: null,
    });
    expect(f.pod().failureReason).toContain('reports could not be preserved before stop');
    expect(f.cm.stop).not.toHaveBeenCalled();
    expect(f.cm.kill).not.toHaveBeenCalled();
    expect(f.calls.approveSession).not.toHaveBeenCalled();
  });

  it('preserves actionable unknown-resume evidence if the resource suspended before capture', async () => {
    const f = fixture();
    const failure = new AutopodError(
      'Resume retained-intent is unknown. No additional resume was sent.',
      'SANDBOX_WAKEUP_RECONCILIATION_REQUIRED',
      409,
    );
    vi.mocked(f.cm.extractDirectoryFromContainer).mockRejectedValueOnce(failure);
    await f.passValidation();
    expect(f.pod().failureReason).toContain(failure.message);
    expect(f.pod().failureReason).not.toContain('retry approval');
    expect(f.cm.stop).not.toHaveBeenCalled();
    expect(f.cm.kill).not.toHaveBeenCalled();
  });

  it('rejects corrupt saved reports without fresh export, publication or cleanup', async () => {
    const f = fixture();
    await f.passValidation();
    writeFileSync(join(required(f.pod().artifactsPath), 'ignored-report.txt'), 'tampered');
    vi.mocked(f.worktreeManager.mergeBranch).mockClear();
    await expect(f.workflow().approveSession('prepare')).rejects.toMatchObject({
      code: 'ARTIFACT_SNAPSHOT_UNVERIFIED',
    });
    expect(f.pod().status).toBe('validated');
    expect(f.cm.extractDirectoryFromContainer).toHaveBeenCalledOnce();
    expect(f.worktreeManager.mergeBranch).not.toHaveBeenCalled();
    expect(f.mainCaptured.cleanupContainerAfterAdvisorySettles).not.toHaveBeenCalled();
  });

  it.each([
    'resource',
    'result',
    'base-branch',
    'source',
    'options',
  ] as const)('does not reuse reports after changing %s', async (change) => {
    const f = fixture();
    await f.passValidation();
    if (change === 'resource') f.podRepo.update('prepare', { containerId: 'replacement' });
    if (change === 'result')
      f.podRepo.update('prepare', {
        lastValidationResult: { ...required(f.pod().lastValidationResult), attempt: 2 },
      });
    if (change === 'base-branch') f.podRepo.update('prepare', { baseBranch: 'replacement' });
    if (change === 'options')
      f.podRepo.update('prepare', { options: { ...f.pod().options, output: 'branch' } });
    if (change === 'source')
      vi.mocked(required(f.worktreeManager.inspectSource))
        .mockResolvedValueOnce({
          branch: f.pod().branch,
          commitSha: 'b'.repeat(40),
          treeSha: 'c'.repeat(40),
          worktreeClean: true,
        })
        .mockResolvedValueOnce({
          branch: f.pod().branch,
          commitSha: 'b'.repeat(40),
          treeSha: 'c'.repeat(40),
          worktreeClean: true,
        });
    await expect(verifiedApprovalReportSnapshot(f.input())).resolves.toBeNull();
  });

  it('a new lifecycle cannot reuse an old receipt', async () => {
    const f = fixture();
    await f.passValidation();
    f.podRepo.incrementLifecycleGeneration('prepare');
    await expect(verifiedApprovalReportSnapshot(f.input())).rejects.toMatchObject({
      code: 'ARTIFACT_SNAPSHOT_UNVERIFIED',
    });
  });

  it('does not publish a snapshot if lifecycle changes during export', async () => {
    const f = fixture();
    vi.mocked(f.cm.extractDirectoryFromContainer).mockImplementationOnce(async () => {
      f.podRepo.incrementLifecycleGeneration('prepare');
    });
    await expect(preserveApprovalReportSnapshot(f.input())).rejects.toThrow();
    expect(f.pod().artifactsPath).toBeNull();
    expect(f.cm.stop).not.toHaveBeenCalled();
  });

  it('checks real Git cleanliness and exact commits, not just equal tree content', async () => {
    const f = fixture();
    const repo = join(f.directory, 'real-source');
    mkdirSync(repo);
    const exec = promisify(execFile);
    const git = (...args: string[]) => exec('git', ['-C', repo, ...args]);
    await git('init', '--quiet', '-b', 'branch');
    await git('config', 'user.name', 'Synthetic test');
    await git('config', 'user.email', 'test@example.invalid');
    writeFileSync(join(repo, 'source.txt'), 'validated source');
    await git('add', 'source.txt');
    await git('-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'initial');
    f.podRepo.update('prepare', { worktreePath: repo });
    const local = new LocalWorktreeManager({ logger: f.deps.logger });
    f.worktreeManager.inspectSource = local.inspectSource.bind(local);
    await f.passValidation();
    const snapshot = f.pod().artifactsPath;
    await expect(verifiedApprovalReportSnapshot(f.input())).resolves.toBe(snapshot);
    writeFileSync(join(repo, 'source.txt'), 'unvalidated edit');
    await expect(verifiedApprovalReportSnapshot(f.input())).rejects.toMatchObject({
      code: 'APPROVAL_REPORT_SOURCE_UNVERIFIED',
    });
    await git('checkout', '--', 'source.txt');
    await git(
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '--quiet',
      '--allow-empty',
      '-m',
      'unrelated same-tree commit',
    );
    await expect(verifiedApprovalReportSnapshot(f.input())).resolves.toBeNull();
    expect(f.cm.extractDirectoryFromContainer).toHaveBeenCalledOnce();
  });

  it('a later unresolved resume cannot be bypassed using saved reports', async () => {
    const f = fixture();
    await f.passValidation();
    const journal = required(f.podRepo.sandboxWakeups);
    journal.observeRunning('exact-test-resource', 'container-123');
    const intent = journal.claim('exact-test-resource', 'container-123', 'prepare');
    journal.beginDispatch(intent.id);
    await expect(verifiedApprovalReportSnapshot(f.input())).resolves.toBeNull();
    const failure = new AutopodError(
      'Original resume remains unknown',
      'SANDBOX_WAKEUP_RECONCILIATION_REQUIRED',
      409,
    );
    vi.mocked(f.cm.extractDirectoryFromContainer).mockRejectedValueOnce(failure);
    await expect(f.workflow().approveSession('prepare')).rejects.toBe(failure);
    expect(journal.listForPod('prepare')[0]).toMatchObject({ id: intent.id, endedAt: null });
    expect(f.pod().status).toBe('validated');
    expect(f.mainCaptured.cleanupContainerAfterAdvisorySettles).not.toHaveBeenCalled();
  });

  it('a changed source during pre-stop capture does not authorize suspension or snapshot reuse', async () => {
    const f = fixture();
    vi.mocked(required(f.worktreeManager.inspectSource))
      .mockResolvedValueOnce({
        branch: 'branch',
        commitSha: 'a'.repeat(40),
        treeSha: 'b'.repeat(40),
        worktreeClean: true,
      })
      .mockResolvedValueOnce({
        branch: 'branch',
        commitSha: 'c'.repeat(40),
        treeSha: 'd'.repeat(40),
        worktreeClean: true,
      });
    await f.passValidation();
    expect(f.pod().artifactsPath).toBeNull();
    expect(f.pod().status).toBe('validated');
    expect(f.cm.stop).not.toHaveBeenCalled();
  });

  it.each([
    'validation',
    'revalidation',
  ])('a superseded %s copy cannot park or stop the replacement lifecycle', async (kind) => {
    const f = fixture();
    vi.mocked(f.cm.extractDirectoryFromContainer).mockImplementationOnce(async () => {
      f.podRepo.incrementLifecycleGeneration('prepare');
      f.podRepo.update('prepare', {
        lastValidationResult: { ...required(f.pod().lastValidationResult), attempt: 2 },
      });
    });
    await expect(f.passValidation(kind === 'revalidation')).rejects.toMatchObject({
      code: 'STALE_VALIDATION_EXECUTION',
    });
    expect(f.pod().artifactsPath).toBeNull();
    expect(f.pod().failureReason).toBeNull();
    expect(f.cm.stop).not.toHaveBeenCalled();
    expect(f.calls.approveSession).not.toHaveBeenCalled();
  });

  it('a stale intact binding uses the ordinary guarded fresh collection path', async () => {
    const f = fixture();
    await f.passValidation();
    const previous = f.pod().artifactsPath;
    f.podRepo.update('prepare', {
      lastValidationResult: { ...required(f.pod().lastValidationResult), attempt: 2 },
    });
    await f.workflow().approveSession('prepare');
    expect(f.cm.extractDirectoryFromContainer).toHaveBeenCalledTimes(2);
    expect(f.pod().artifactsPath).not.toBe(previous);
  });
});
