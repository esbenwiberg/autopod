import { execFile } from 'node:child_process';
import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { vi } from 'vitest';
import { rewriteConfiguration } from '../pods/approval-source-rewrite.js';
import { checkpointHash } from '../pods/retained-checkpoint-repository.js';
import { LocalWorktreeManager } from '../worktrees/local-worktree-manager.js';
import {
  materializeCheckpointFixture,
  retainedCheckpointFixture,
} from './retained-checkpoint-helpers.js';

const exec = promisify(execFile);
export const repairGit = async (cwd: string, ...args: string[]) =>
  (
    await exec('git', args, {
      cwd,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    })
  ).stdout.trim();

/** Persist an activated rewrite and a genuine started, settled, published failed
 * checks dispatch. No fabricated settlement receipt or production incident IDs. */
export async function rewriteRepairFixture(
  target: 'sandbox' | 'local' = 'sandbox',
  published = true,
  bound = true,
) {
  const f = await retainedCheckpointFixture();
  const containerId = target === 'local' ? 'd'.repeat(64) : f.containerId;
  if (target === 'local') {
    f.ctx.podRepo.update(f.podId, { containerId: null });
    f.ctx.podRepo.update(f.podId, { executionTarget: 'local' });
  }
  f.ctx.podRepo.update(f.podId, { containerId });
  const rewriteId = 'fixture-rewrite';
  const root = path.join(f.root, rewriteId);
  await mkdir(root);
  f.ctx.podRepo.update(f.podId, {
    worktreePath: path.join(root, 'worktree'),
    prUrl: 'https://github.com/org/repo/pull/7',
    baseBranch: 'main',
  });
  await materializeCheckpointFixture(f);
  if (target === 'local') {
    f.cm.getResourceKey = vi.fn(async (id) => JSON.stringify(['docker', 'fixture-engine', id]));
    vi.mocked(f.cm.getStatus).mockImplementation(async (id) =>
      id === containerId ? 'stopped' : 'running',
    );
    vi.mocked(f.cm.spawn).mockResolvedValue('e'.repeat(64));
  }
  const real = new LocalWorktreeManager({
    cacheDir: path.join(f.root, 'cache'),
    worktreeDir: path.join(f.root, 'unused'),
    logger: f.ctx.deps.logger,
  });
  f.worktrees.inspectSourceAdoption.mockImplementation(real.inspectSourceAdoption.bind(real));
  f.worktrees.assertSourceDescendsFrom = real.assertSourceDescendsFrom.bind(real);
  const source = await f.worktrees.inspectSourceAdoption(f.pod().worktreePath!, f.pod().branch);
  const original = path.join(f.root, 'predecessor');
  await cp(f.pod().worktreePath!, original, { recursive: true });
  const configurationHash = rewriteConfiguration(f.pod(), f.deps.executionForPod(f.pod()));
  const binding = {
    predecessor: {
      repository: f.deps.executionForPod(f.pod()).repoUrl!,
      branch: f.pod().branch,
      commitSha: source.commitSha,
      treeSha: source.treeSha,
      remoteRef: `refs/heads/${f.pod().branch}`,
      observedRemoteCommitSha: source.commitSha,
      worktreeClean: true,
      observedAt: new Date().toISOString(),
    },
    publicationId: 'fixture-original-publication',
    baseBranch: 'main',
    baseCommitSha: source.commitSha,
    prUrl: f.pod().prUrl!,
    worktreePath: original,
    containerId: 'original-pre-rebase-resource',
    configurationHash,
    validationHash: checkpointHash(null),
    root,
  };
  f.ctx.db
    .prepare('INSERT INTO approval_source_rewrites VALUES(?,?,?,?,?)')
    .run(
      rewriteId,
      f.podId,
      f.pod().lifecycleGeneration,
      JSON.stringify(binding),
      new Date().toISOString(),
    );
  const rewrites = f.ctx.podRepo.approvalRewrites!;
  rewrites.append(rewriteId, 'prepared', {
    worktreePath: f.pod().worktreePath,
    head: source.commitSha,
    tree: source.treeSha,
  });
  f.ctx.podRepo.atomically!(() => {
    const generation = f.ctx.podRepo.incrementLifecycleGeneration(f.podId);
    f.ctx.podRepo.update(f.podId, { containerId: null, skipAgent: true });
    rewrites.append(rewriteId, 'activated', { generation });
  });
  f.ctx.podRepo.update(f.podId, { containerId, lastValidationResult: null });
  const retries = f.ctx.podRepo.taskRetries!;
  retries.authorize(
    f.podId,
    'fixture-failed-rewrite',
    'Fixture authorization for the failed rewrite checks',
    f.actor,
  );
  const previous = f.ctx.db
    .prepare(
      'SELECT binding_hash FROM task_retry_attempts WHERE pod_id=? ORDER BY rowid DESC LIMIT 1',
    )
    .get(f.podId) as { binding_hash: string };
  const admission = retries.admit(
    f.podId,
    f.pod().lifecycleGeneration,
    { source: null, contract: null, commands: null, environment: null, implementation: null },
    previous.binding_hash,
    [],
  );
  retries.start(admission.id);
  const scope =
    target === 'local' ? await f.cm.getResourceKey!(containerId) : f.cm.executionResourceScope;
  const ledger = f.ctx.podRepo.validationExecutions!;
  const dispatchId = bound ? ledger.dispatch(f.pod(), admission.id, f.result.attempt, scope) : null;
  if (bound && !dispatchId) throw new Error('Missing maintained fixture dispatch');
  const result = {
    ...f.result,
    infrastructureFailure: undefined,
    ...(dispatchId ? { executionDispatchId: dispatchId } : {}),
  };
  ledger.recordResult(result);
  if (published) ledger.claimLogicalPublication(result);
  retries.finish(admission.id, 'nonretryable', 10);
  f.ctx.podRepo.update(f.podId, { lastValidationResult: result, skipAgent: false });
  f.input.expectedGeneration = f.pod().lifecycleGeneration;
  f.input.expectedResultHash = checkpointHash(result);
  const request = { ...f.input, rewriteId, failedDispatchId: dispatchId ?? 'unbound-dispatch' };
  return {
    ...f,
    containerId,
    request,
    rewriteId,
    dispatchId: request.failedDispatchId,
    original,
    source,
    result,
  };
}
