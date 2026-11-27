import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  GitWorktreeIdentity,
  PhysicalIdentity,
} from '../pods/retained-allocation-inventory.js';

const exec = promisify(execFile);
const unavailable = () => new Error('Exact filesystem/Git allocation identity unavailable');

export async function physicalIdentity(
  location: string,
  type: 'directory' | 'file',
): Promise<PhysicalIdentity> {
  const entry = await lstat(location, { bigint: true });
  if (
    entry.birthtimeNs <= 0n ||
    entry.ino <= 0n ||
    (type === 'directory' ? !entry.isDirectory() : !entry.isFile() || entry.nlink !== 1n)
  )
    throw unavailable();
  const canonical = await realpath(location);
  if (canonical !== path.join(await realpath(path.dirname(location)), path.basename(location)))
    throw unavailable();
  return {
    path: location,
    realpath: canonical,
    device: String(entry.dev),
    inode: String(entry.ino),
    birthtimeNs: String(entry.birthtimeNs),
  };
}

export async function pathVacant(location: string): Promise<boolean> {
  try {
    await lstat(location);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

async function pointer(file: string): Promise<string> {
  const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = await fd.stat();
    if (!st.isFile() || st.size > 4096 || st.size < 1) throw unavailable();
    const bytes = Buffer.alloc(4097);
    const { bytesRead } = await fd.read(bytes);
    if (bytesRead !== st.size) throw unavailable();
    const value = bytes.subarray(0, bytesRead).toString('utf8').trimEnd();
    if (!value || /[\0\r\n]/.test(value)) throw unavailable();
    return value;
  } finally {
    await fd.close();
  }
}

export const samePhysical = (a: PhysicalIdentity, b: PhysicalIdentity) =>
  a.realpath === b.realpath &&
  a.device === b.device &&
  a.inode === b.inode &&
  a.birthtimeNs === b.birthtimeNs;

/** Observe a linked checkout and its reciprocal Git registration. No repair, prune, or fetch. */
export async function gitWorktreeIdentity(
  location: string,
  ownership: GitWorktreeIdentity['commonStoreOwnership'],
  expectedCommon?: string,
  expectedBranch?: string,
): Promise<GitWorktreeIdentity> {
  const worktree = await physicalIdentity(location, 'directory');
  const gitlink = await physicalIdentity(path.join(location, '.git'), 'file');
  const link = await pointer(gitlink.path);
  if (!link.startsWith('gitdir: ')) throw unavailable();
  const registrationPath = path.resolve(location, link.slice('gitdir: '.length));
  const registration = await physicalIdentity(registrationPath, 'directory');
  const commonPath = expectedCommon ?? path.dirname(path.dirname(registrationPath));
  const commonStore = await physicalIdentity(commonPath, 'directory');
  const worktreeRegistry = await physicalIdentity(path.join(commonPath, 'worktrees'), 'directory');
  if (
    path.dirname(registration.realpath) !== worktreeRegistry.realpath ||
    (await realpath(
      path.resolve(registrationPath, await pointer(path.join(registrationPath, 'commondir'))),
    )) !== commonStore.realpath ||
    (await realpath(
      path.resolve(registrationPath, await pointer(path.join(registrationPath, 'gitdir'))),
    )) !== gitlink.realpath
  )
    throw unavailable();
  const { stdout } = await exec(
    'git',
    ['--git-dir', commonStore.realpath, 'worktree', 'list', '--porcelain', '-z'],
    {
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
        ),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_OPTIONAL_LOCKS: '0',
      },
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  const entries = stdout.split('\0\0').map((entry) => entry.split('\0'));
  if (
    entries.filter(
      ([entry, ...fields]) =>
        entry?.startsWith('worktree ') &&
        [location, worktree.realpath].includes(entry.slice(9)) &&
        !fields.some((field) => field === 'bare' || field.startsWith('prunable')),
    ).length !== 1 ||
    !samePhysical(worktree, await physicalIdentity(location, 'directory')) ||
    !samePhysical(gitlink, await physicalIdentity(gitlink.path, 'file')) ||
    !samePhysical(registration, await physicalIdentity(registration.path, 'directory')) ||
    !samePhysical(commonStore, await physicalIdentity(commonStore.path, 'directory'))
  )
    throw unavailable();
  if (
    expectedBranch &&
    !entries.some(
      ([entry, ...fields]) =>
        entry === `worktree ${location}` && fields.includes(`branch refs/heads/${expectedBranch}`),
    )
  )
    throw unavailable();
  return { worktree, gitlink, registration, commonStore, commonStoreOwnership: ownership };
}
