import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { link, rm, stat } from 'node:fs/promises';
import { AutopodError } from '@autopod/shared';
import type { PrepareSourceAdoption } from '../interfaces/worktree-manager.js';

function sourceAdoptionError(message: string, code = 'SOURCE_ADOPTION_BLOCKED'): never {
  throw new AutopodError(message, code, 409);
}

export type AdoptionGit = (args: string[]) => Promise<{ stdout: string; stderr: string }>;
export function safeAdoptionGit(run: AdoptionGit): AdoptionGit {
  return (args) =>
    run([
      '--no-replace-objects',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ]);
}
export async function inspectAdoptionGit(run: AdoptionGit, branch: string) {
  const git = safeAdoptionGit(run);
  const config = (await git(['config', '--null', '--list'])).stdout.split('\0');
  if (
    config.some((value) => /^filter\./i.test(value) || /^core\.sparsecheckout\ntrue$/i.test(value))
  )
    sourceAdoptionError('Executable filters/sparse source need explicit materialization policy');
  const name = (await git(['symbolic-ref', '--short', 'HEAD'])).stdout.trim();
  const head = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  const tree = (await git(['rev-parse', 'HEAD^{tree}'])).stdout.trim();
  if (
    /^160000 /m.test((await git(['ls-tree', '-r', 'HEAD'])).stdout) ||
    /^160000 /m.test((await git(['ls-files', '--stage'])).stdout)
  )
    sourceAdoptionError('Submodules need recursive source custody');
  const dirty = (
    await git([
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=normal',
      '--ignore-submodules=none',
    ])
  ).stdout;
  const entries = (await git(['ls-files', '-v', '-z'])).stdout.split('\0');
  if (entries.some((entry) => /^[a-zS] /.test(entry)))
    sourceAdoptionError(
      'Sparse/assume-unchanged source cannot establish a complete clean identity',
    );
  if (/^160000 /m.test((await git(['ls-tree', '-r', 'HEAD'])).stdout))
    sourceAdoptionError(
      'Submodule source needs explicit recursive dependency custody before adoption',
    );
  if (
    name !== branch ||
    dirty ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head) ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(tree)
  )
    sourceAdoptionError(
      'Source branch/cleanliness unavailable; preserve and reconcile it before adoption.',
    );
  const after = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  const branchAfter = (await git(['symbolic-ref', '--short', 'HEAD'])).stdout.trim();
  if (after !== head || branchAfter !== name)
    sourceAdoptionError('Source identity changed during observation');
  return { head, tree };
}
export async function preparePinnedAdoption(
  config: PrepareSourceAdoption,
  run: AdoptionGit,
  fetch: (targetRef: string) => Promise<void>,
): Promise<{ bundle: string; bundleHash: string; tree: string }> {
  const git = safeAdoptionGit(run);
  config.assertCurrent();
  if (
    !/^[a-zA-Z0-9-]+$/.test(config.id) ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(config.oldHead) ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(config.targetHead)
  )
    sourceAdoptionError('Source adoption identity is invalid');
  await git(['check-ref-format', `refs/heads/${config.branch}`]);
  const old = await inspectAdoptionGit(git, config.branch);
  config.assertCurrent();
  if (old.head !== config.oldHead) sourceAdoptionError('Old source changed before preservation');
  const prefix = `refs/autopod/source-adoption/${config.id}`;
  await git(['update-ref', `${prefix}/old`, config.oldHead, '0'.repeat(config.oldHead.length)]);
  await fetch(`${prefix}/target`);
  config.assertCurrent();
  const target = (await git(['rev-parse', `${prefix}/target`])).stdout.trim();
  if (target !== config.targetHead)
    sourceAdoptionError(
      'Remote branch advanced; refresh the exact requested source.',
      'SOURCE_REMOTE_CHANGED',
    );
  await git(['merge-base', '--is-ancestor', config.oldHead, target]);
  const tree = (await git(['rev-parse', `${target}^{tree}`])).stdout.trim();
  if (/^160000 /m.test((await git(['ls-tree', '-r', target])).stdout))
    sourceAdoptionError(
      'Target submodules need explicit recursive dependency custody before adoption',
    );
  const staging = `${config.bundle}.collect-${randomUUID()}`;
  try {
    await git(['bundle', 'create', staging, `${prefix}/old`, `${prefix}/target`]);
    await git(['bundle', 'verify', staging]);
    config.assertCurrent();
    const after = await inspectAdoptionGit(git, config.branch);
    if (after.head !== old.head || after.tree !== old.tree)
      sourceAdoptionError('Source changed during preservation');
    if ((await stat(staging)).size > 1_073_741_824)
      sourceAdoptionError('Git custody bundle exceeds safe size');
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(staging)) digest.update(chunk);
    config.assertCurrent();
    // Atomic no-replace publication: never clobber another/older custody bundle.
    await link(staging, config.bundle);
    config.assertCurrent();
    return { bundle: config.bundle, bundleHash: digest.digest('hex'), tree };
  } finally {
    await rm(staging, { force: true });
  }
}
export async function applyPinnedAdoption(
  config: PrepareSourceAdoption,
  run: AdoptionGit,
): Promise<void> {
  const git = safeAdoptionGit(run);
  config.assertCurrent();
  const old = await inspectAdoptionGit(git, config.branch);
  if (old.head !== config.oldHead) sourceAdoptionError('Source changed before fast-forward');
  const prefix = `refs/autopod/source-adoption/${config.id}`;
  const pinnedOld = (await git(['rev-parse', `${prefix}/old`])).stdout.trim();
  const pinnedTarget = (await git(['rev-parse', `${prefix}/target`])).stdout.trim();
  if (pinnedOld !== config.oldHead || pinnedTarget !== config.targetHead)
    sourceAdoptionError('Source adoption has no matching preserved Git identity');
  await git(['bundle', 'verify', config.bundle]);
  await git(['merge-base', '--is-ancestor', config.oldHead, config.targetHead]);
  config.assertCurrent();
  // A local FF only: never a merge commit or provider PR merge. Unlike reset
  // --keep, --no-overwrite-ignore also refuses collisions with ignored reports.
  await git([
    '-c',
    'core.hooksPath=/dev/null',
    'merge',
    '--ff-only',
    '--no-edit',
    '--no-stat',
    '--no-autostash',
    '--no-overwrite-ignore',
    config.targetHead,
  ]);
  config.assertCurrent();
  if ((await inspectAdoptionGit(git, config.branch)).head !== config.targetHead)
    sourceAdoptionError('Adopted host source could not be verified');
}
