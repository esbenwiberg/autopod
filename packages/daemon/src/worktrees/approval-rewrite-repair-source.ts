import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { verifyArtifactSnapshot } from '../pods/artifact-snapshot-receipt.js';
import {
  checkpointError,
  type PreparedCheckpoint,
} from '../pods/retained-checkpoint-repository.js';
import { safeAdoptionGit } from './source-adoption-git.js';

const exec = promisify(execFile);
/** Repair may edit/commit files, never substitute its daemon-created Git store.
 * Check around observations and checks; no caller path or host execution API. */
export async function assertApprovalRepairStorage(
  prepared: PreparedCheckpoint,
  repository: string,
  assertCurrent: () => void,
  preservation: { generation: number; cycle: number },
) {
  const root = path.dirname(prepared.worktree);
  if (
    prepared.worktree !== path.join(root, 'worktree') ||
    prepared.bare !== path.join(root, 'repository.git')
  )
    checkpointError('Repair storage namespace changed');
  for (const folder of [
    root,
    prepared.worktree,
    prepared.bare,
    path.join(prepared.bare, 'objects'),
    path.join(prepared.bare, 'info'),
    path.join(prepared.bare, 'objects', 'info'),
    path.join(prepared.bare, 'worktrees'),
    path.join(prepared.bare, 'worktrees', 'worktree'),
  ]) {
    assertCurrent();
    if ((await lstat(folder)).isSymbolicLink() || (await realpath(folder)) !== path.resolve(folder))
      checkpointError('Repair storage alias is not authorized');
  }
  for (const name of [
    'objects/info/alternates',
    'objects/info/http-alternates',
    'info/grafts',
    'shallow',
    'refs/replace',
  ]) {
    try {
      await lstat(path.join(prepared.bare, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    checkpointError(
      'Repair Git grafts, replacements, shallow or shared storage are not authorized',
    );
  }
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
  const git = safeAdoptionGit(async (args) => {
    assertCurrent();
    const result = await exec('git', args, {
      cwd: prepared.worktree,
      env: {
        ...env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0',
        GIT_NO_LAZY_FETCH: '1',
      },
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });
    assertCurrent();
    return result;
  });
  const config = (await git(['config', '--null', '--list'])).stdout.split('\0');
  if (
    config.some((entry) =>
      /^extensions\.partialclone\n|^remote\..*\.promisor\n|^core\.alternaterefscommand\n/i.test(
        entry,
      ),
    )
  )
    checkpointError('Repair partial/shared Git imports are not authorized');
  if (!(await lstat(path.join(prepared.worktree, '.git'))).isFile())
    checkpointError('Repair worktree Git pointer must remain a regular file');
  const metadata = (await git(['rev-parse', '--absolute-git-dir'])).stdout.trim();
  if (
    (await realpath(metadata)) !== path.join(prepared.bare, 'worktrees', 'worktree') ||
    (await git(['rev-parse', '--show-toplevel'])).stdout.trim() !== prepared.worktree
  )
    checkpointError('Repair worktree metadata changed');
  const common = path.resolve(
    prepared.worktree,
    (await git(['rev-parse', '--git-common-dir'])).stdout.trim(),
  );
  if (
    (await realpath(common)) !== prepared.bare ||
    (await git(['config', '--get', 'remote.origin.url'])).stdout.trim() !== repository ||
    (await git(['for-each-ref', '--format=%(refname)', 'refs/replace/'])).stdout.trim()
  )
    checkpointError('Repair Git storage/repository identity changed');
  await verifyArtifactSnapshot(
    prepared.snapshot,
    path.join(root, 'host'),
    preservation.generation,
    preservation.cycle,
    prepared.hostInventoryHash,
  );
  assertCurrent();
  if (
    prepared.bundle !== path.join(root, 'source.bundle') ||
    !(await lstat(prepared.bundle)).isFile()
  )
    checkpointError('Repair preservation bundle identity changed');
  if ((await lstat(prepared.bundle)).size > 1_073_741_824)
    checkpointError('Repair preservation bundle exceeds capture bounds');
  const digest = createHash('sha256');
  let total = 0;
  for await (const bytes of createReadStream(prepared.bundle)) {
    total += bytes.length;
    if (total > 1_073_741_824) checkpointError('Repair preservation bundle exceeds capture bounds');
    digest.update(bytes);
    assertCurrent();
  }
  if (digest.digest('hex') !== prepared.bundleHash)
    checkpointError('Repair preservation bundle changed');
  assertCurrent();
}
