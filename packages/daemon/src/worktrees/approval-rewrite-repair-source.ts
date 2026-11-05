import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  type PreparedCheckpoint,
  checkpointError,
} from '../pods/retained-checkpoint-repository.js';
import { safeAdoptionGit } from './source-adoption-git.js';

const exec = promisify(execFile);
/** Repair may edit/commit files, never substitute its daemon-created Git store.
 * Check around observations and checks; no caller path or host execution API. */
export async function assertApprovalRepairStorage(
  prepared: PreparedCheckpoint,
  repository: string,
  assertCurrent: () => void,
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
      },
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });
    assertCurrent();
    return result;
  });
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
  assertCurrent();
}
