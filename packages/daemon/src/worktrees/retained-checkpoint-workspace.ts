import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, chmod, cp, lstat, mkdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { AutopodError } from '@autopod/shared';
import {
  fingerprintArtifactSnapshot,
  verifyArtifactSnapshot,
  writeArtifactSnapshotReceipt,
} from '../pods/artifact-snapshot-receipt.js';
import { inspectAdoptionGit, safeAdoptionGit } from './source-adoption-git.js';

const exec = promisify(execFile);
function fail(message: string): never {
  throw new AutopodError(message, 'CHECKPOINT_SOURCE_UNVERIFIED', 409);
}
const contains = (parent: string, child: string) => {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  );
};

export function assertCheckpointRepository(repository: string): void {
  let remote: URL;
  try {
    remote = new URL(repository);
  } catch {
    fail('A credential-free trusted HTTPS repository is required');
  }
  if (
    remote.protocol !== 'https:' ||
    remote.username ||
    remote.password ||
    remote.search ||
    remote.hash
  )
    fail('A credential-free trusted HTTPS repository is required');
}

/** No original-container access, network fetch, shared Git refs, or source rewrite.
 * The snapshot is of HOST bytes only. It does not certify final sandbox reports.
 */
export async function prepareRetainedCheckpointWorkspace(options: {
  source: string;
  root: string;
  branch: string;
  repository: string;
  head: string;
  generation: number;
  cycle: number;
  assertCurrent(): void;
}) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
  const git = (cwd: string) =>
    safeAdoptionGit(async (args) => {
      options.assertCurrent();
      const result = await exec('git', args, {
        cwd,
        env: {
          ...env,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_TERMINAL_PROMPT: '0',
          GIT_OPTIONAL_LOCKS: '0',
        },
        timeout: 120_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      options.assertCurrent();
      return result;
    });
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(options.head))
    fail('Exact checkpoint commit required');
  assertCheckpointRepository(options.repository);
  const source = await realpath(options.source);
  if ((await lstat(options.source)).isSymbolicLink()) fail('Source root must not be a symlink');
  const root = path.resolve(options.root);
  // Resolve the existing parent BEFORE mkdir. Do not follow an archive alias into source.
  const parent = await realpath(path.dirname(root));
  const physicalRoot = path.join(parent, path.basename(root));
  if (contains(source, physicalRoot) || contains(physicalRoot, source))
    fail('Recovery and original source namespaces must be disjoint');
  const original = await inspectAdoptionGit(git(source), options.branch);
  if (original.head !== options.head) fail('Selected checkpoint is not the retained host HEAD');
  options.assertCurrent();
  await mkdir(root, { mode: 0o700 }); // Exclusive; an uncertain prior attempt is not replayed.
  if ((await realpath(root)) !== physicalRoot) fail('Recovery namespace changed');
  await chmod(root, 0o700);
  const hostRoot = path.join(root, 'host');
  await mkdir(hostRoot, { mode: 0o700 });
  const snapshot = path.join(hostRoot, `generation-${options.generation}-${randomUUID()}`);
  const before = await fingerprintArtifactSnapshot(source);
  options.assertCurrent();
  await cp(source, snapshot, { recursive: true, dereference: false, verbatimSymlinks: true });
  await chmod(snapshot, (await lstat(source)).mode & 0o777);
  options.assertCurrent();
  const after = await fingerprintArtifactSnapshot(source);
  const copied = await fingerprintArtifactSnapshot(snapshot);
  if (before.sha256 !== after.sha256 || before.sha256 !== copied.sha256)
    fail('Retained host bytes changed while preserving source and ignored reports');
  await writeArtifactSnapshotReceipt(snapshot, snapshot, options.generation, options.cycle);
  options.assertCurrent();

  // A bundle creates an independent object store; no hardlinks, alternates, source
  // branch updates, inherited executable config, or dependency on the original .git.
  const bundle = path.join(root, 'source.bundle');
  await git(source)(['bundle', 'create', bundle, '--all']);
  if ((await stat(bundle)).size > 1_073_741_824) fail('Checkpoint Git bundle exceeds 1 GiB');
  await git(source)(['bundle', 'verify', bundle]);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(bundle)) hash.update(chunk);
  options.assertCurrent();
  const bare = path.join(root, 'repository.git');
  await git(root)(['clone', '--bare', '--no-local', '--', bundle, bare]);
  // Bare clone imports branch heads, not every remote-tracking base. Preserve
  // those refs locally too (e.g. origin/ewi/azure-pod-desk), without a network
  // fetch or mirror-remote setting that could later publish unrelated branches.
  await git(bare)(['fetch', '--no-write-fetch-head', '--no-tags', '--', bundle, '+refs/*:refs/*']);
  await git(bare)(['remote', 'set-url', 'origin', options.repository]);
  const worktree = path.join(root, 'worktree');
  await git(bare)(['worktree', 'add', '--', worktree, options.branch]);
  // Checks write daemon-owned reports even when the selected repository does not
  // ignore them. Exclude only these untracked outputs in the NEW private clone;
  // tracked changes remain visible and report bytes still require their receipt.
  // Never modify the original repository's excludes or committed .gitignore.
  await mkdir(path.join(bare, 'info'), { recursive: true });
  await appendFile(
    path.join(bare, 'info', 'exclude'),
    '\n/.autopod/evidence/\n/.autopod/screenshots/\n',
  );
  const materialized = await inspectAdoptionGit(git(worktree), options.branch);
  const retained = await inspectAdoptionGit(git(source), options.branch);
  if (
    materialized.head !== original.head ||
    materialized.tree !== original.tree ||
    retained.head !== original.head ||
    retained.tree !== original.tree ||
    (await fingerprintArtifactSnapshot(source)).sha256 !== before.sha256
  )
    fail('Checkpoint source changed during isolated materialization');
  await verifyArtifactSnapshot(snapshot, hostRoot, options.generation, options.cycle);
  options.assertCurrent();
  return {
    worktree,
    bare,
    snapshot,
    bundle,
    bundleHash: hash.digest('hex'),
    head: original.head,
    tree: original.tree,
    hostInventoryHash: before.sha256,
  };
}
