import { execFile } from 'node:child_process';
import { constants, lstatSync, realpathSync } from 'node:fs';
import { lstat, open, opendir, readdir, readFile, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { PhysicalIdentity } from '../pods/retained-allocation-inventory.js';
import { block } from '../pods/retained-cleanup-proof.js';
import { overlaps, type Target } from '../pods/retained-cleanup-repository.js';
import { gitWorktreeIdentity, pathVacant, samePhysical } from './allocation-identity.js';

const exec = promisify(execFile);
type HostTarget = Extract<Target, { kind: 'host_worktree' | 'host_prepared_root' }>;
const hostTarget = (t: Target): t is HostTarget =>
  t.kind === 'host_worktree' || t.kind === 'host_prepared_root';
const changed = (id: string) =>
  block('HOST_PROOF_UNAVAILABLE', 'Exact host path, mount or Git registration proof failed.', id);
const git = async (store: string, ...args: string[]) =>
  (
    await exec('git', ['--git-dir', store, '-c', 'core.hooksPath=/dev/null', ...args], {
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_OPTIONAL_LOCKS: '0',
      },
    })
  ).stdout;

async function linuxMounts() {
  // Include bind mounts (including same-device binds); st_dev alone cannot detect them.
  const rows = (await readFile('/proc/self/mountinfo', 'utf8')).trimEnd().split('\n');
  const decodeMountPath = (p?: string) =>
    p?.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
  const mounts = rows.map((row) => {
    const left = row.split(' - ')[0]?.split(' ');
    return {
      point: decodeMountPath(left?.[4]),
      root: decodeMountPath(left?.[3]),
      device: left?.[2],
    };
  });
  if (
    mounts.some((m) => !m.point || !path.isAbsolute(m.point) || !m.root || !m.device) ||
    !mounts.some((m) => m.point === '/')
  )
    block('HOST_PROOF_UNAVAILABLE', 'A complete local mount table is required.');
  return mounts as Mount[];
}

type Mount = { point: string; root: string; device: string };
const openDir = (location: string) =>
  open(location, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
const fdPath = (fd: number) => '/proc/self/fd/' + fd;
const trustworthy = (uid: number, mode: number) =>
  (uid === process.getuid?.() || uid === 0) && (mode & 0o022) === 0;

async function proveTree(
  location: string,
  device: string,
  guard: () => void,
  allowGitLink = false,
) {
  let seen = 0;
  const visit = async (p: string, depth: number) => {
    if (depth > 128) changed(location);
    const d = await opendir(p);
    for await (const e of d) {
      if (++seen > 200_000)
        block('HOST_PROOF_UNAVAILABLE', 'Host source exceeds the bounded closure scan.', location);
      if (seen % 256 === 0) guard();
      const child = path.join(p, e.name);
      const st = await lstat(child, { bigint: true });
      if (
        String(st.dev) !== device ||
        (e.name === '.git' && !(allowGitLink && depth === 0 && st.isFile())) ||
        !(st.isDirectory() || st.isFile() || st.isSymbolicLink())
      )
        changed(location);
      if (st.isDirectory()) {
        if (!trustworthy(Number(st.uid), Number(st.mode))) changed(location);
        await visit(child, depth + 1);
      }
    }
  };
  await visit(location, 0);
  guard();
}

/** Unlink private-root entries relative to no-follow directory descriptors.
 * Even an embedded snapshot Git link is just an unlink, never a repo locator.
 */
async function unlinkPrivateRoot(entry: PhysicalIdentity, guard: () => void) {
  const parent = await openDir(path.dirname(entry.path));
  const identity = (a: Awaited<ReturnType<typeof lstat>>, b: Awaited<ReturnType<typeof lstat>>) =>
    a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs;
  let count = 0;
  async function remove(location: string, expected?: PhysicalIdentity) {
    guard();
    const before = await lstat(location, { bigint: true });
    if (String(before.dev) !== entry.device || ++count > 200_001) changed(entry.path);
    if (
      expected &&
      (!before.isDirectory() ||
        String(before.ino) !== expected.inode ||
        String(before.birthtimeNs) !== expected.birthtimeNs)
    )
      changed(entry.path);
    if (!before.isDirectory()) {
      if (!(before.isFile() || before.isSymbolicLink())) changed(entry.path);
      guard();
      await unlink(location);
      return;
    }
    const child = await openDir(location);
    try {
      const inside = await child.stat({ bigint: true });
      if (
        inside.dev !== before.dev ||
        inside.ino !== before.ino ||
        inside.birthtimeNs !== before.birthtimeNs ||
        !trustworthy(Number(inside.uid), Number(inside.mode))
      )
        changed(entry.path);
      const anchor = process.platform === 'linux' ? fdPath(child.fd) : location;
      // Production requires the Linux mount table; the portable path supports disposable Git tests.
      const dir = await opendir(anchor);
      for await (const next of dir) await remove(path.join(anchor, next.name));
      const after = await lstat(location, { bigint: true });
      if (
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.birthtimeNs !== before.birthtimeNs
      )
        changed(entry.path);
      guard();
      await rmdir(location);
    } finally {
      await child.close();
    }
  }
  try {
    const current = await lstat(path.dirname(entry.path));
    if (!identity(current, await parent.stat()) || !current.isDirectory()) changed(entry.path);
    await remove(
      process.platform === 'linux'
        ? path.join(fdPath(parent.fd), path.basename(entry.path))
        : entry.path,
      entry,
    );
  } finally {
    await parent.close();
  }
}

function trusted(location: string) {
  if (location !== path.resolve(location) || location === '/' || !process.getuid) changed(location);
  const uid = process.getuid!();
  for (let current = location; ; current = path.dirname(current)) {
    const st = lstatSync(current);
    if (
      !st.isDirectory() ||
      (st.uid !== uid && st.uid !== 0) ||
      (st.mode & 0o022 && !(st.uid === 0 && st.mode & 0o1000))
    )
      changed(location);
    if (current === '/') break;
  }
  if (realpathSync(location) !== location) changed(location);
}
function pinned(entry: PhysicalIdentity, type: 'directory' | 'file') {
  if (entry.path !== entry.realpath) changed(entry.path);
  trusted(path.dirname(entry.path));
  const st = lstatSync(entry.path, { bigint: true });
  if (
    (type === 'directory' ? !st.isDirectory() : !st.isFile() || st.nlink !== 1n) ||
    st.dev.toString() !== entry.device ||
    st.ino.toString() !== entry.inode ||
    st.birthtimeNs.toString() !== entry.birthtimeNs
  )
    changed(entry.path);
  if (type === 'directory') trusted(entry.path);
}

const parseList = (output: string) =>
  output
    .split('\0\0')
    .filter(Boolean)
    .map((block) => {
      const [location, ...fields] = block.split('\0');
      if (!location?.startsWith('worktree ') || !path.isAbsolute(location.slice(9)))
        changed('git worktree list');
      return { location: location!.slice(9), fields };
    });
const sameEntries = (a: string[], b: string[]) =>
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

export function createRetainedCleanupHost(readMounts: () => Promise<Mount[]> = linuxMounts) {
  async function checkMounts(t: HostTarget, guard: () => void) {
    const locations = t.kind === 'host_prepared_root' ? [t.id] : [t.id, t.git.registration.path];
    const mounts = await readMounts();
    guard();
    for (const p of locations) {
      const includes = (ancestor: string, child: string) =>
        ancestor === '/' || child === ancestor || child.startsWith(ancestor + path.sep);
      if (mounts.some((m) => includes(p, m.point)))
        block('HOST_PROOF_UNAVAILABLE', 'A selected resource contains or is a mount point.', t.id);
      const enclosing = mounts
        .filter((m) => includes(m.point, p))
        .sort((a, b) => b.point.length - a.point.length)[0];
      if (
        !enclosing ||
        enclosing.root !== '/' ||
        mounts.some(
          (m) =>
            m !== enclosing &&
            m.device === enclosing.device &&
            (m.point !== enclosing.point || m.root !== enclosing.root),
        )
      )
        block(
          'HOST_PROOF_UNAVAILABLE',
          'A selected resource is on an aliased or unsupported host mount.',
          t.id,
        );
    }
  }
  function pinGit(t: HostTarget) {
    const g = t.git;
    pinned(g.commonStore, 'directory');
    pinned(g.registration, 'directory');
    pinned(g.worktree, 'directory');
    pinned(g.gitlink, 'file');
  }
  async function checkout(
    t: Extract<HostTarget, { kind: 'host_worktree' }>,
    targets: Target[],
    guard: () => void,
  ) {
    const g = t.git;
    const enclosing = targets.find(
      (p) => p.kind === 'host_prepared_root' && p.git.worktree.path === t.id,
    );
    if (enclosing && (await pathVacant(enclosing.id))) {
      guard();
      trusted(path.dirname(enclosing.id));
      return true; // Exact independent store and its sole registration are both inside this root.
    }
    pinned(g.commonStore, 'directory');
    trusted(path.dirname(t.id));
    const list = parseList(await git(g.commonStore.path, 'worktree', 'list', '--porcelain', '-z'));
    guard();
    const matches = list.filter((v) => v.location === t.id);
    if (
      list.some(
        (v) =>
          v.location !== t.id &&
          !(enclosing && v.location === g.commonStore.path && v.fields.includes('bare')) &&
          (overlaps(v.location, t.id) || overlaps(realpathSync(v.location), t.id)),
      )
    )
      changed(t.id);
    if (await pathVacant(t.id)) {
      const vacant = !matches.length && (await pathVacant(g.registration.path));
      guard();
      if (!vacant) changed(t.id);
      pinned(g.commonStore, 'directory');
      return true;
    }
    if (
      matches.length !== 1 ||
      matches[0]!.fields.some((f) => /^(locked|prunable|bare)( |$)/.test(f))
    )
      changed(t.id);
    const live = await gitWorktreeIdentity(t.id, g.commonStoreOwnership, g.commonStore.path);
    guard();
    if (
      !(['worktree', 'gitlink', 'registration', 'commonStore'] as const).every((key) =>
        samePhysical(live[key], g[key]),
      )
    )
      changed(t.id);
    pinGit(t);
    return false;
  }
  async function prepared(
    t: Extract<HostTarget, { kind: 'host_prepared_root' }>,
    guard: () => void,
  ) {
    trusted(path.dirname(t.id));
    if (await pathVacant(t.id)) {
      guard();
      return true;
    }
    const g = t.git;
    for (const item of [t.root, t.snapshotRoot, t.snapshot, g.commonStore])
      pinned(item, 'directory');
    for (const item of [t.receipt, t.bundle]) pinned(item, 'file');
    const list = parseList(await git(g.commonStore.path, 'worktree', 'list', '--porcelain', '-z'));
    guard();
    const hasCheckout = !(await pathVacant(g.worktree.path));
    const registry = path.join(g.commonStore.path, 'worktrees');
    const registrations = (await pathVacant(registry)) ? [] : await readdir(registry);
    const rootContents = await readdir(t.id);
    const snapshots = await readdir(t.snapshotRoot.path);
    if (
      !sameEntries(rootContents, [
        'host',
        'repository.git',
        'source.bundle',
        ...(hasCheckout ? ['worktree'] : []),
      ]) ||
      !sameEntries(snapshots, [path.basename(t.snapshot.path), path.basename(t.receipt.path)]) ||
      !sameEntries(registrations, hasCheckout ? [path.basename(g.registration.path)] : []) ||
      list.length !== (hasCheckout ? 2 : 1) ||
      !list.some((v) => v.location === g.commonStore.path && v.fields.includes('bare')) ||
      (hasCheckout && !list.some((v) => v.location === g.worktree.path)) ||
      !(await pathVacant(path.join(g.commonStore.path, 'objects', 'info', 'alternates')))
    )
      changed(t.id);
    guard();
    pinned(t.root, 'directory');
    return false;
  }
  async function scan(t: HostTarget, guard: () => void) {
    if (t.kind === 'host_worktree') {
      await proveTree(t.id, t.git.worktree.device, guard, true);
      await proveTree(t.git.registration.path, t.git.registration.device, guard);
    } else {
      await proveTree(t.snapshot.path, t.snapshot.device, guard, true);
      await proveTree(t.git.commonStore.path, t.git.commonStore.device, guard);
    }
  }
  async function proof(targets: Target[], guard: () => void, full = false): Promise<Set<string>> {
    const absent = new Set<string>();
    for (const t of targets.filter(hostTarget)) {
      try {
        await checkMounts(t, guard);
        if (await (t.kind === 'host_worktree' ? checkout(t, targets, guard) : prepared(t, guard)))
          absent.add(t.id);
        else if (full) await scan(t, guard);
        guard();
      } catch (e) {
        // Preserve policy/ownership failures, but never pass native stderr or OS paths through.
        guard();
        if (e instanceof Error && 'blocker' in e) throw e;
        changed(t.id);
      }
    }
    return absent;
  }
  async function remove(
    t: HostTarget,
    targets: Target[],
    guard: () => void,
    dispatch: () => boolean,
    inFlight: () => void,
  ) {
    // Recheck the exact paths immediately before committing dispatch. No model or caller paths.
    const absent = await (t.kind === 'host_worktree'
      ? checkout(t, targets, guard)
      : prepared(t, guard));
    guard();
    if (absent) return;
    await scan(t, guard);
    await checkMounts(t, guard);
    if (await (t.kind === 'host_worktree' ? checkout(t, targets, guard) : prepared(t, guard)))
      return;
    guard();
    if (t.kind === 'host_worktree') {
      pinGit(t);
      if (dispatch())
        await git(t.git.commonStore.path, 'worktree', 'remove', '--force', '--', t.id);
    } else {
      pinned(t.root, 'directory');
      if (dispatch()) await unlinkPrivateRoot(t.root, inFlight);
    }
  }
  return { proof, remove };
}
export type RetainedCleanupHost = ReturnType<typeof createRetainedCleanupHost>;
