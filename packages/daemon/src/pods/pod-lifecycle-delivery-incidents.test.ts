import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrManager, PrMergeStatus } from '../interfaces/pr-manager.js';
import {
  createTestContext,
  mockBranchPublication,
  mockPrMerge,
} from '../test-utils/mock-helpers.js';
import { inspectAdoptionGit } from '../worktrees/source-adoption-git.js';
import { createPodManager } from './pod-manager.js';
import {
  assertPublicationMutationAllowed,
  assertSourceResourceReleasable,
} from './source-custody-guards.js';

const cleanup: Array<() => void> = [];
const directories: string[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

function fixture() {
  const ctx = createTestContext();
  let disposition: 'open' | 'merged' = 'open';
  const status = (): PrMergeStatus => ({
    merged: disposition === 'merged',
    open: disposition === 'open',
    headSha: 'a'.repeat(40),
    sourceTarget: {
      repository: 'https://github.com/org/repo',
      branch: pod.branch,
      baseBranch: 'main',
    },
    blockReason: null,
    ciFailures: [],
    reviewComments: [],
  });
  const provider = {
    findPr: vi.fn<NonNullable<PrManager['findPr']>>(async () => null),
    createPr: vi.fn(async () => ({
      url: 'https://github.com/org/repo/pull/42',
      usedFallback: false,
    })),
    mergePr: vi.fn(mockPrMerge),
    getPrStatus: vi.fn(async () => status()),
    verifyMergedSourceAncestry: vi.fn(async () => null),
    replyToReviewFeedback: vi.fn(async () => ({
      posted: 0,
      skipped: 0,
      resolved: 0,
      errors: [],
      resolutionErrors: [],
    })),
  };
  ctx.deps.prManagerFactory = () => provider;
  const manager = createPodManager(ctx.deps);
  const pod = manager.createSession(
    { profileName: 'test-profile', task: 'Publish checked source', skipValidation: false },
    'operator',
  );
  const f = {
    ctx,
    manager,
    pod,
    provider,
    status,
    current: () => manager.getSession(pod.id),
    process: () => manager.processPod(pod.id),
    merged: () => {
      disposition = 'merged';
    },
    approve: () =>
      manager.approveSession(pod.id, {
        actor: { type: 'human', userId: 'operator' },
        reason: 'Recognize exactly this task source and external delivery.',
      }),
  };
  cleanup.push(() => ctx.db.close());
  return f;
}
function count(f: ReturnType<typeof fixture>, table: string) {
  return (f.ctx.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}
function noExtraDelivery(f: ReturnType<typeof fixture>, pushes: number, merges = 0) {
  expect(f.ctx.worktreeManager.pushBranch).toHaveBeenCalledTimes(pushes);
  expect(f.ctx.worktreeManager.mergeBranch).not.toHaveBeenCalled();
  expect(f.provider.mergePr).toHaveBeenCalledTimes(merges);
  expect(f.ctx.runtime.spawn).toHaveBeenCalledTimes(1);
}

describe('composed delivery incidents', () => {
  it.each([
    'metadata',
    'preparation',
  ] as const)('recovers %s failure through checked publication without coding or fabricated receipts', async (phase) => {
    const f = fixture();
    if (phase === 'metadata')
      f.provider.createPr.mockRejectedValueOnce(new Error('metadata temporarily unavailable'));
    // No onPrepared/admission and therefore no uncertain external push.
    else
      vi.mocked(f.ctx.worktreeManager.pushBranch).mockRejectedValueOnce(
        new Error('publication preparation unavailable'),
      );
    await f.process();
    expect(f.current().status).toBe(phase === 'metadata' ? 'validated' : 'failed');
    expect(f.current().lastValidationResult?.overall).toBe('pass');
    expect(count(f, 'source_publication_receipts')).toBe(phase === 'metadata' ? 1 : 0);
    const checks = vi.mocked(f.ctx.validationEngine.validate).mock.calls.length;
    if (phase === 'metadata') {
      // The first response was ambiguous. Only provider lookup, not a second
      // create request or a null search result, can settle that operation.
      f.provider.findPr.mockResolvedValue({
        url: 'https://github.com/org/repo/pull/42',
        disposition: 'open',
      });
      await f.manager.retryCreatePr(f.pod.id);
    } else await f.manager.resumePod(f.pod.id);
    expect(f.current().status).toBe('validated');
    expect(f.current().prUrl).toBe('https://github.com/org/repo/pull/42');
    expect(f.ctx.worktreeManager.mergeBranch).not.toHaveBeenCalled();
    expect(f.ctx.worktreeManager.pushBranch).toHaveBeenCalledTimes(phase === 'metadata' ? 1 : 2);
    expect(f.ctx.validationEngine.validate).toHaveBeenCalledTimes(checks);
    expect(f.ctx.runtime.resume).not.toHaveBeenCalled();
    expect(f.provider.createPr).toHaveBeenCalledTimes(1);
    expect(count(f, 'source_publication_receipts')).toBe(1);
  });

  it.each([
    false,
    true,
  ])('binds publication to actual Git source and refuses hidden drift (drift: %s)', async (drift) => {
    const f = fixture();
    const root = await mkdtemp(path.join(os.tmpdir(), 'delivery-source-'));
    directories.push(root);
    const run = promisify(execFile);
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    };
    const git = (args: string[]) => run('git', args, { cwd: root, env });
    await git(['init', '--initial-branch', f.pod.branch]);
    await writeFile(path.join(root, 'checked.txt'), 'checked source\n');
    await git(['add', 'checked.txt']);
    await git(['commit', '-m', 'checked source']);
    const head = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    const tree = (await git(['rev-parse', 'HEAD^{tree}'])).stdout.trim();
    vi.mocked(f.ctx.worktreeManager.create).mockResolvedValue({
      worktreePath: root,
      bareRepoPath: root,
      startCommitSha: head,
    });
    const exec = vi.mocked(f.ctx.containerManager.execInContainer).getMockImplementation();
    if (!exec) throw new Error('Missing container mock');
    vi.mocked(f.ctx.containerManager.execInContainer).mockImplementation(
      async (id, args, options) => {
        if (!args[2]?.includes('autopod-validation-source-v1')) return exec(id, args, options);
        try {
          return { ...(await git(args.slice(args.indexOf('/usr/bin/git') + 3))), exitCode: 0 };
        } catch {
          return { stdout: '', stderr: 'Git source unavailable', exitCode: 1 };
        }
      },
    );
    vi.mocked(f.ctx.worktreeManager.inspectSource!).mockImplementation(async (_root, branch) => {
      const source = await inspectAdoptionGit(git, branch);
      return { branch, commitSha: source.head, treeSha: source.tree, worktreeClean: true };
    });
    vi.mocked(f.ctx.worktreeManager.pushBranch).mockImplementation(
      async (_root, branch, options) => {
        const source = await inspectAdoptionGit(git, branch);
        const receipt = {
          branch,
          repository: 'https://github.com/org/repo',
          commitSha: source.head,
          treeSha: source.tree,
          remoteRef: `refs/heads/${branch}`,
          observedRemoteCommitSha: source.head,
          worktreeClean: true as const,
          observedAt: new Date().toISOString(),
        };
        options?.onPrepared?.(receipt);
        return receipt;
      },
    );
    if (drift) {
      const validate = vi.mocked(f.ctx.validationEngine.validate).getMockImplementation();
      if (!validate) throw new Error('Missing validation mock');
      vi.mocked(f.ctx.validationEngine.validate).mockImplementationOnce(async (...args) => {
        const result = await validate(...args);
        await git(['update-index', '--assume-unchanged', 'checked.txt']);
        await writeFile(path.join(root, 'checked.txt'), 'unreviewed source\n');
        return result;
      });
    }
    await f.process();
    expect((await git(['rev-parse', 'HEAD'])).stdout.trim()).toBe(head);
    expect(f.ctx.worktreeManager.mergeBranch).not.toHaveBeenCalled();
    if (drift) {
      expect(count(f, 'source_publication_receipts')).toBe(0);
      expect(f.provider.createPr).not.toHaveBeenCalled();
      expect(f.current().lastValidationResult?.overall).toBe('pass');
    } else {
      expect(f.current().status).toBe('validated');
      expect(
        f.ctx.podRepo.sourcePublications?.latestConfirmedForMerge?.(f.current()),
      ).toMatchObject({ commitSha: head, treeSha: tree });
    }
  });
  it('records normal initial publication and completes ordinary delivery', async () => {
    const f = fixture();
    await f.process();
    expect(f.current()).toMatchObject({
      status: 'validated',
      prUrl: 'https://github.com/org/repo/pull/42',
    });
    const publication = f.ctx.podRepo.sourcePublications?.latestConfirmedForMerge?.(f.current());
    expect(publication).toMatchObject({
      commitSha: 'a'.repeat(40),
      treeSha: 'b'.repeat(40),
      publicationPrUrl: null,
    });
    expect(count(f, 'validation_source_results')).toBe(1);
    expect(count(f, 'source_publication_receipts')).toBe(1);
    expect(count(f, 'validation_source_publications')).toBe(1);
    expect(() =>
      f.ctx.db.prepare("UPDATE validation_source_results SET result_hash='changed'").run(),
    ).toThrow('immutable');
    expect(f.ctx.worktreeManager.mergeBranch).not.toHaveBeenCalled();
    await f.approve();
    expect(f.current().status).toBe('complete');
    expect(count(f, 'merge_attempts')).toBe(1);
    noExtraDelivery(f, 2, 1);
  });

  it('refuses a changed validation projection at source admission and preserves its failed result', async () => {
    const f = fixture();
    let externalPushes = 0;
    vi.mocked(f.ctx.worktreeManager.pushBranch).mockImplementation(
      async (worktree, branch, options) => {
        const result = f.current().lastValidationResult;
        if (!result) throw new Error('Missing validation');
        f.ctx.podRepo.update(f.pod.id, { lastValidationResult: { ...result, overall: 'fail' } });
        const receipt = await mockBranchPublication(worktree, branch, options);
        externalPushes++;
        return receipt;
      },
    );
    await f.process();
    expect(externalPushes).toBe(0);
    expect(count(f, 'source_publication_intents')).toBe(0);
    expect(count(f, 'source_publication_receipts')).toBe(0);
    expect(f.current().lastValidationResult?.overall).toBe('fail');
    expect(f.provider.createPr).not.toHaveBeenCalled();
  });

  it('retains a factual push receipt without creating a PR when validation changes during the push', async () => {
    const f = fixture();
    vi.mocked(f.ctx.worktreeManager.pushBranch).mockImplementation(
      async (worktree, branch, options) => {
        const receipt = await mockBranchPublication(worktree, branch, options);
        const result = f.current().lastValidationResult;
        if (!result) throw new Error('Missing validation');
        f.ctx.podRepo.update(f.pod.id, { lastValidationResult: { ...result, overall: 'fail' } });
        return receipt;
      },
    );
    await f.process();
    expect(count(f, 'source_publication_receipts')).toBe(1);
    expect(f.current().lastValidationResult?.overall).toBe('fail');
    expect(f.provider.createPr).not.toHaveBeenCalled();
    expect(f.ctx.containerManager.kill).not.toHaveBeenCalled();
    noExtraDelivery(f, 1);
  });

  it('observes external merge before first approval without another push or merge', async () => {
    const f = fixture();
    await f.process();
    f.merged();
    await f.approve();
    expect(f.current().status).toBe('complete');
    expect(count(f, 'merge_attempts')).toBe(0);
    expect(count(f, 'merge_disposition_observations')).toBe(1);
    noExtraDelivery(f, 1);
    await expect(f.approve()).rejects.toBeDefined();
    noExtraDelivery(f, 1);
  });

  it('reobserves disposition after approval waits for delivery ownership, before pushing', async () => {
    const f = fixture();
    await f.process();
    f.provider.getPrStatus.mockImplementationOnce(async () => {
      const open = f.status();
      f.merged();
      return open;
    });
    await f.approve();
    expect(f.current().status).toBe('complete');
    expect(f.ctx.worktreeManager.prepareApprovalRebase).not.toHaveBeenCalled();
    noExtraDelivery(f, 1);
  });

  it('fences concurrent duplicate approval while provider evidence is pending', async () => {
    const f = fixture();
    await f.process();
    f.merged();
    let release = () => {};
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.provider.getPrStatus.mockImplementationOnce(async () => {
      await waiting;
      return f.status();
    });
    const approval = f.approve();
    await expect(f.approve()).rejects.toMatchObject({ code: 'APPROVAL_IN_PROGRESS' });
    release();
    await approval;
    expect(f.current().status).toBe('complete');
    noExtraDelivery(f, 1);
  });

  it.each([
    true,
    false,
  ])('requires immutable historical validation-source proof (available: %s)', async (proven) => {
    const f = fixture();
    if (!proven) {
      const exec = vi.mocked(f.ctx.containerManager.execInContainer).getMockImplementation()!;
      vi.mocked(f.ctx.containerManager.execInContainer).mockImplementation(
        async (id, args, options) =>
          args[2]?.includes('autopod-validation-source-v1')
            ? { stdout: '', stderr: 'Historical source observation unavailable', exitCode: 1 }
            : exec(id, args, options),
      );
    }
    vi.mocked(f.ctx.worktreeManager.pushBranch).mockRejectedValueOnce(
      new Error('Historical producer did not admit publication'),
    );
    await f.process();
    expect(f.current().lastValidationResult?.overall).toBe('pass');
    expect(count(f, 'source_publication_intents')).toBe(0);
    // Historical projection: a PR exists, but no publication receipt ever existed.
    f.ctx.podRepo.update(f.pod.id, {
      status: 'validated',
      prUrl: 'https://github.com/org/repo/pull/42',
    });
    f.merged();
    if (proven) {
      await f.approve();
      await f.approve();
      expect(f.current().status).toBe('complete');
      expect(count(f, 'external_delivery_observations')).toBe(1);
      expect(
        f.ctx.db
          .prepare('SELECT publication_id,validation_id FROM external_delivery_source_evidence')
          .get(),
      ).toEqual({ publication_id: null, validation_id: expect.any(String) });
    } else {
      await expect(f.approve()).rejects.toThrow('immutable passing result');
      expect(f.current().status).toBe('validated');
      expect(count(f, 'external_delivery_observations')).toBe(0);
    }
    expect(count(f, 'source_publication_receipts')).toBe(0);
    expect(f.ctx.containerManager.kill).not.toHaveBeenCalled();
    expect(f.ctx.worktreeManager.cleanup).not.toHaveBeenCalled();
    noExtraDelivery(f, proven ? 1 : 0);
  });

  it.each([
    'head',
    'target',
    'generation',
    'task',
  ] as const)('refuses stale external %s proof and retains resources', async (kind) => {
    const f = fixture();
    await f.process();
    f.merged();
    if (kind === 'head')
      f.provider.getPrStatus.mockImplementation(async () => ({
        ...f.status(),
        headSha: 'c'.repeat(40),
      }));
    if (kind === 'target')
      f.provider.getPrStatus.mockImplementation(async () => ({
        ...f.status(),
        sourceTarget: { ...f.status().sourceTarget!, baseBranch: 'other' },
      }));
    if (kind === 'generation') f.ctx.podRepo.incrementLifecycleGeneration(f.pod.id);
    if (kind === 'task') f.ctx.podRepo.update(f.pod.id, { task: 'A different task' });
    await expect(f.approve()).rejects.toBeDefined();
    expect(f.current().status).toBe('validated');
    expect(f.ctx.containerManager.kill).not.toHaveBeenCalled();
    expect(f.ctx.worktreeManager.cleanup).not.toHaveBeenCalled();
    noExtraDelivery(f, 1);
  });

  it('reconciles external merge racing rewrite preparation without activating the candidate', async () => {
    const f = fixture();
    await f.process();
    const original = f.current();
    vi.mocked(f.ctx.worktreeManager.prepareApprovalRebase!).mockImplementation(async (config) => {
      config.onPrepared('e'.repeat(40));
      f.merged();
      return {
        kind: 'candidate',
        baseCommitSha: 'e'.repeat(40),
        worktreePath: path.join(config.root, 'worktree'),
        head: 'c'.repeat(40),
        tree: 'd'.repeat(40),
      };
    });
    await f.approve();
    expect(f.current()).toMatchObject({
      status: 'complete',
      worktreePath: original.worktreePath,
      containerId: original.containerId,
      lifecycleGeneration: original.lifecycleGeneration,
      lastValidationResult: original.lastValidationResult,
    });
    const rewrite = f.ctx.podRepo.approvalRewrites?.latest(f.current());
    expect(rewrite?.prepared).toMatchObject({ head: 'c'.repeat(40), tree: 'd'.repeat(40) });
    expect(rewrite?.activated).toBeUndefined();
    expect(rewrite?.checked).toBeUndefined();
    expect(count(f, 'approval_rewrite_predecessor_deliveries')).toBe(1);
    expect(f.ctx.enqueuedSessions).toHaveLength(1);
    expect(f.ctx.validationEngine.validate).toHaveBeenCalledTimes(1);
    expect(f.ctx.containerManager.kill).not.toHaveBeenCalled();
    expect(f.ctx.worktreeManager.cleanup).not.toHaveBeenCalled();
    noExtraDelivery(f, 2);
  });

  it('retains a changed predecessor result instead of clearing it when a prepared candidate would activate', async () => {
    const f = fixture();
    await f.process();
    const original = f.current();
    const rebase = f.ctx.worktreeManager.prepareApprovalRebase;
    if (!rebase || !original.lastValidationResult) throw new Error('Missing rewrite premise');
    const failed = { ...original.lastValidationResult, overall: 'fail' as const };
    vi.mocked(rebase).mockImplementation(async (config) => {
      config.onPrepared('e'.repeat(40));
      f.ctx.podRepo.update(f.pod.id, { lastValidationResult: failed });
      return {
        kind: 'candidate',
        baseCommitSha: 'e'.repeat(40),
        worktreePath: path.join(config.root, 'worktree'),
        head: 'c'.repeat(40),
        tree: 'd'.repeat(40),
      };
    });
    await expect(f.approve()).rejects.toThrow('changed before candidate activation');
    expect(f.current()).toMatchObject({
      lifecycleGeneration: original.lifecycleGeneration,
      lastValidationResult: failed,
      worktreePath: original.worktreePath,
      containerId: original.containerId,
    });
    expect(f.ctx.podRepo.approvalRewrites?.latest(f.current())?.activated).toBeUndefined();
    expect(f.ctx.validationEngine.validate).toHaveBeenCalledTimes(1);
    expect(f.ctx.containerManager.kill).not.toHaveBeenCalled();
    noExtraDelivery(f, 2);
  });

  it('retains an admitted push after lost response and reconciles it by reads only', async () => {
    const f = fixture();
    vi.mocked(f.ctx.worktreeManager.pushBranch).mockImplementationOnce(
      async (worktree, branch, options) => {
        await mockBranchPublication(worktree, branch, options);
        throw new Error('Push response lost');
      },
    );
    await f.process();
    expect(count(f, 'source_publication_intents')).toBe(1);
    expect(count(f, 'source_publication_receipts')).toBe(0);
    expect(f.ctx.containerManager.kill).not.toHaveBeenCalled();
    expect(f.current().status).toBe('validated');
    expect(() => assertSourceResourceReleasable(f.ctx.db, f.current().containerId ?? '')).toThrow(
      'unconfirmed publication',
    );
    f.ctx.worktreeManager.observeSourceBranch = vi.fn(async () => 'c'.repeat(40));
    await expect(f.approve()).rejects.toThrow('original publication outcome');
    expect(count(f, 'source_publication_receipts')).toBe(0);
    noExtraDelivery(f, 1);
    f.ctx.worktreeManager.observeSourceBranch = vi.fn(async () => 'a'.repeat(40));
    await f.approve();
    expect(f.current().status).toBe('complete');
    expect(count(f, 'source_publication_receipts')).toBe(1);
    noExtraDelivery(f, 1, 1);
  });

  it('observes a lost push from a review hold without certifying changed checks or replaying publication', async () => {
    const f = fixture();
    vi.mocked(f.ctx.worktreeManager.pushBranch).mockImplementationOnce(
      async (worktree, branch, options) => {
        await mockBranchPublication(worktree, branch, options);
        const result = f.current().lastValidationResult;
        if (!result) throw new Error('Missing native validation');
        f.ctx.podRepo.update(f.pod.id, { lastValidationResult: { ...result, overall: 'fail' } });
        throw new Error('Push response lost after validation changed');
      },
    );
    await f.process();
    expect(f.current().status).toBe('review_required');
    expect(count(f, 'source_publication_receipts')).toBe(0);
    expect(() => assertPublicationMutationAllowed(f.ctx.db, f.pod.id)).toThrow();
    f.ctx.worktreeManager.observeSourceBranch = vi.fn(async () => 'c'.repeat(40));
    await expect(f.manager.resumePod(f.pod.id)).rejects.toBeDefined();
    expect(count(f, 'source_publication_receipts')).toBe(0);
    f.ctx.worktreeManager.observeSourceBranch = vi.fn(async () => 'a'.repeat(40));
    // Factual settlement is not a passing-check override or a new retry grant.
    await expect(f.manager.resumePod(f.pod.id)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(count(f, 'source_publication_receipts')).toBe(1);
    expect(() => assertPublicationMutationAllowed(f.ctx.db, f.pod.id)).not.toThrow();
    expect(f.current().status).toBe('review_required');
    expect(f.current().lastValidationResult?.overall).toBe('fail');
    expect(f.ctx.validationEngine.validate).toHaveBeenCalledTimes(1);
    expect(f.ctx.runtime.resume).not.toHaveBeenCalled();
    expect(f.provider.createPr).not.toHaveBeenCalled();
    noExtraDelivery(f, 1);
  });

  it.each([
    false,
    true,
  ])('never republishes an observed original push (remote changes again=%s)', async (drift) => {
    const f = fixture();
    vi.mocked(f.ctx.worktreeManager.pushBranch).mockImplementationOnce(
      async (root, branch, options) => {
        await mockBranchPublication(root, branch, options);
        throw new Error('Original publication response lost');
      },
    );
    await f.process();
    f.ctx.worktreeManager.observeSourceBranch = vi
      .fn()
      .mockResolvedValueOnce('a'.repeat(40))
      .mockResolvedValue((drift ? 'c' : 'a').repeat(40));
    if (drift) await expect(f.manager.retryCreatePr(f.pod.id)).rejects.toBeDefined();
    else await f.manager.retryCreatePr(f.pod.id);
    expect(f.ctx.worktreeManager.pushBranch).toHaveBeenCalledTimes(1);
    expect(count(f, 'source_publication_intents')).toBe(1);
    expect(count(f, 'source_publication_receipts')).toBe(1);
    expect(f.provider.createPr).toHaveBeenCalledTimes(drift ? 0 : 1);
    expect(f.ctx.runtime.resume).not.toHaveBeenCalled();
    expect(f.ctx.validationEngine.validate).toHaveBeenCalledTimes(1);
  });

  it.each([
    'resume',
    'retry-pr',
    'approve',
  ] as const)('observes original publication on %s without consuming pending guidance or authorizing delivery', async (action) => {
    const f = fixture();
    const physicalPush = vi.mocked(f.ctx.worktreeManager.pushBranch).getMockImplementation();
    if (!physicalPush) throw new Error('Missing physical publication adapter');
    vi.mocked(f.ctx.worktreeManager.pushBranch).mockImplementationOnce(
      async (worktree, branch, options) => {
        await physicalPush(worktree, branch, options);
        throw new Error('Lost publication response');
      },
    );
    await f.process();
    if (action === 'resume') f.ctx.podRepo.update(f.pod.id, { status: 'failed' });
    f.ctx.nudgeRepo.queue(f.pod.id, 'Apply the new instruction before any further delivery');
    const before = f.current();
    await expect(
      action === 'resume'
        ? f.manager.resumePod(f.pod.id)
        : action === 'retry-pr'
          ? f.manager.retryCreatePr(f.pod.id)
          : f.approve(),
    ).rejects.toMatchObject({ code: 'UNCOLLECTED_HUMAN_GUIDANCE' });
    expect(count(f, 'source_publication_receipts')).toBe(1);
    expect(count(f, 'source_publication_intents')).toBe(1);
    expect(f.ctx.nudgeRepo.hasPending(f.pod.id)).toBe(true);
    expect(f.current().lastValidationResult).toEqual(before.lastValidationResult);
    expect(f.current().lifecycleGeneration).toBe(before.lifecycleGeneration);
    expect(f.current().containerId).toBe(before.containerId);
    expect(f.ctx.worktreeManager.pushBranch).toHaveBeenCalledTimes(1);
    expect(f.provider.createPr).not.toHaveBeenCalled();
    expect(f.ctx.runtime.resume).not.toHaveBeenCalled();
    expect(f.ctx.validationEngine.validate).toHaveBeenCalledTimes(1);
  });

  it('observes the original push without clearing a genuine infrastructure report or resuming work', async () => {
    const f = fixture();
    const physicalPush = vi.mocked(f.ctx.worktreeManager.pushBranch).getMockImplementation();
    if (!physicalPush) throw new Error('Missing physical publication adapter');
    vi.mocked(f.ctx.worktreeManager.pushBranch).mockImplementationOnce(
      async (worktree, branch, options) => {
        await physicalPush(worktree, branch, options);
        throw new Error('Lost publication response');
      },
    );
    await f.process();
    f.ctx.podRepo.update(f.pod.id, { status: 'failed' });
    f.ctx.escalationRepo.insert({
      id: 'live-infrastructure-hold',
      podId: f.pod.id,
      type: 'report_blocker',
      timestamp: new Date().toISOString(),
      response: null,
      payload: {
        kind: 'infrastructure',
        lifecycleGeneration: f.current().lifecycleGeneration,
        requiresResponse: false,
        owner: 'validation',
        phase: 'build',
        description: 'Configured runner unavailable',
        attempted: ['configured build'],
        needs: 'Repair the qualified runner',
      },
    });
    await expect(f.manager.resumePod(f.pod.id)).rejects.toMatchObject({
      code: 'INFRASTRUCTURE_BLOCKED',
    });
    expect(count(f, 'source_publication_receipts')).toBe(1);
    expect(count(f, 'source_publication_intents')).toBe(1);
    expect(f.ctx.podRepo.hasInfrastructureBlocker(f.pod.id)).toBe(true);
    expect(f.current().status).toBe('failed');
    expect(f.ctx.worktreeManager.pushBranch).toHaveBeenCalledTimes(1);
    expect(f.provider.createPr).not.toHaveBeenCalled();
    expect(f.ctx.runtime.resume).not.toHaveBeenCalled();
    expect(f.ctx.validationEngine.validate).toHaveBeenCalledTimes(1);
  });

  it.each([
    'before retry',
    'during observation',
  ] as const)('does not let prior checked source authorize PR retry when worker termination becomes unverified %s', async (timing) => {
    const f = fixture();
    f.provider.findPr.mockRejectedValueOnce(
      new Error('Provider lookup unavailable before create dispatch'),
    );
    await f.process();
    // Source was checked and published, but the failed read never authorized
    // PR dispatch. Neither fact is authority over a later unknown worker.
    expect(count(f, 'source_publication_receipts')).toBe(1);
    expect(f.provider.createPr).not.toHaveBeenCalled();
    expect(f.current().prUrl).toBeNull();
    const pod = f.current();
    const executions = f.ctx.podRepo.taskExecutions;
    if (!executions) throw new Error('Missing execution ledger');
    const discoverUnknownExecution = () => {
      const run = executions.beginRun(
        pod.id,
        pod.lifecycleGeneration,
        (pod.finalization?.cycle ?? 0) + 1,
        {
          runtime: pod.runtime,
          model: pod.model,
          providerAccountId: pod.providerAccountIdSnapshot ?? null,
          resource: { containerId: pod.containerId, executionTarget: pod.executionTarget },
        },
      );
      executions.retainUnverifiedRun(run);
    };
    if (timing === 'before retry') discoverUnknownExecution();
    else {
      const observer = f.ctx.worktreeManager.observeSourceBranch;
      if (!observer) throw new Error('Missing source observer');
      const observe = vi.mocked(observer).getMockImplementation();
      if (!observe) throw new Error('Missing source observation adapter');
      vi.mocked(observer).mockImplementationOnce(async (...args: Parameters<typeof observe>) => {
        const head = await observe(...args);
        discoverUnknownExecution();
        return head;
      });
    }
    await expect(f.manager.retryCreatePr(pod.id)).rejects.toMatchObject({
      code: 'TASK_EXECUTION_TERMINATION_UNVERIFIED',
    });
    expect(executions.hasUnverifiedTermination(pod.id)).toBe(true);
    expect(f.current().prUrl).toBeNull();
    expect(f.ctx.worktreeManager.pushBranch).toHaveBeenCalledTimes(1);
    expect(f.provider.createPr).not.toHaveBeenCalled();
    expect(f.ctx.runtime.resume).not.toHaveBeenCalled();
  });

  it('does not adopt a pending push from another generation', async () => {
    const f = fixture();
    vi.mocked(f.ctx.worktreeManager.pushBranch).mockImplementationOnce(
      async (worktree, branch, options) => {
        await mockBranchPublication(worktree, branch, options);
        throw new Error('Lost response');
      },
    );
    await f.process();
    expect(() => f.ctx.podRepo.incrementLifecycleGeneration(f.pod.id)).toThrow(
      'unconfirmed publication',
    );
    expect(() => f.ctx.podRepo.update(f.pod.id, { containerId: null })).toThrow();
    expect(() => f.ctx.podRepo.delete(f.pod.id)).toThrow();
    expect(f.ctx.podRepo.listReferencedContainerIds()).toContain(f.current().containerId);
    // Model an already stale historical caller, bypassing the public epoch guard.
    f.ctx.db
      .prepare('UPDATE pods SET lifecycle_generation=lifecycle_generation+1 WHERE id=?')
      .run(f.pod.id);
    f.ctx.worktreeManager.observeSourceBranch = vi.fn(async () => 'a'.repeat(40));
    await expect(f.approve()).rejects.toBeDefined();
    expect(count(f, 'source_publication_receipts')).toBe(0);
    expect(f.ctx.worktreeManager.observeSourceBranch).not.toHaveBeenCalled();
    expect(() => assertSourceResourceReleasable(f.ctx.db, f.current().containerId ?? '')).toThrow();
    noExtraDelivery(f, 1);
  });

  it('retains failed candidate checks and routes already activated rewrites to their owner', async () => {
    const f = fixture();
    await f.process();
    const rebase = f.ctx.worktreeManager.prepareApprovalRebase;
    if (!rebase) throw new Error('Missing rebase support');
    vi.mocked(rebase).mockImplementation(async (config) => {
      config.onPrepared('e'.repeat(40));
      return {
        kind: 'candidate',
        baseCommitSha: 'e'.repeat(40),
        worktreePath: path.join(config.root, 'worktree'),
        head: 'c'.repeat(40),
        tree: 'd'.repeat(40),
      };
    });
    const original = f.current();
    await f.approve();
    const candidate = f.current();
    expect(candidate.status).toBe('queued');
    const failed = {
      ...original.lastValidationResult!,
      overall: 'fail' as const,
      test: { status: 'fail' as const, stdout: 'ENOTEMPTY', duration: 1 },
    };
    f.ctx.podRepo.update(f.pod.id, { status: 'validated', lastValidationResult: failed });
    f.merged();
    await expect(f.approve()).rejects.toThrow('source-bound checks');
    expect(f.current().lastValidationResult).toEqual(failed);
    expect(f.current().worktreePath).toBe(candidate.worktreePath);
    expect(count(f, 'approval_rewrite_predecessor_deliveries')).toBe(0);
    expect(f.ctx.podRepo.approvalRewrites?.latest(f.current())?.binding.worktreePath).toBe(
      original.worktreePath,
    );
    expect(f.ctx.containerManager.kill).not.toHaveBeenCalled();
    expect(f.ctx.worktreeManager.cleanup).not.toHaveBeenCalled();
    noExtraDelivery(f, 2);
  });

  it('observes a lost merge reply without replaying the external mutation', async () => {
    const f = fixture();
    await f.process();
    f.provider.mergePr.mockImplementationOnce(async (config) => {
      config.onPrepared?.();
      f.merged();
      throw new Error('Merge response lost');
    });
    await f.approve();
    expect(f.current().status).toBe('complete');
    expect(count(f, 'merge_attempts')).toBe(1);
    noExtraDelivery(f, 2, 1);
  });

  it('keeps a truly unknown merge admitted across duplicate approvals until read-only proof exists', async () => {
    const f = fixture();
    await f.process();
    const result = f.current().lastValidationResult;
    f.provider.mergePr.mockImplementationOnce(async (config) => {
      config.onPrepared?.();
      throw new Error('Merge response lost, provider disposition unavailable');
    });
    await expect(f.approve()).rejects.toBeDefined();
    await expect(f.approve()).rejects.toBeDefined();
    expect(f.ctx.podRepo.mergeJournal?.find(f.current())?.state).toBe('admitted');
    expect(f.current().lastValidationResult).toEqual(result);
    expect(f.ctx.containerManager.kill).not.toHaveBeenCalled();
    expect(f.ctx.worktreeManager.cleanup).not.toHaveBeenCalled();
    noExtraDelivery(f, 2, 1);
    f.merged();
    await f.approve();
    expect(f.current().status).toBe('complete');
    expect(count(f, 'merge_attempts')).toBe(1);
    noExtraDelivery(f, 2, 1);
  });
});
