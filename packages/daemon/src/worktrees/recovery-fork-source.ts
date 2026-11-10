import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { RecoveryForkInput } from '@autopod/shared';
import {
  parseRecoveryContent,
  parseRecoveryListing,
  recoveryReaderArgs,
  runHostRecoveryReader,
} from '../containers/recovery-file-reader.js';
import {
  RECOVERY_FILE_EXCLUDES,
  RECOVERY_FILE_LIMITS,
  safeRecoveryPath,
} from '../interfaces/recovery-files.js';
import { recoveryForkError } from '../pods/recovery-fork-repository.js';
import { prepareRetainedCheckpointWorkspace } from './retained-checkpoint-workspace.js';
import { safeAdoptionGit } from './source-adoption-git.js';

const exec = promisify(execFile);
export const recoveryBytesHash = (bytes: string | Buffer) =>
  createHash('sha256').update(bytes).digest('hex');
export function recoveryGit(cwd: string, assertCurrent = () => {}) {
  return safeAdoptionGit(async (args) => {
    assertCurrent();
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
    );
    const result = await exec('git', args, {
      cwd,
      env: {
        ...env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_NO_LAZY_FETCH: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    assertCurrent();
    return result;
  });
}
/** Stricter than the convenience file browser; runtime databases/config never become supplements. */
export function safeForkFile(value: string) {
  return (
    safeRecoveryPath(value) &&
    !value
      .split('/')
      .some((part) =>
        RECOVERY_FILE_EXCLUDES.some((exclude) =>
          exclude.endsWith('*')
            ? part.toLowerCase().startsWith(exclude.slice(0, -1))
            : part.toLowerCase() === exclude,
        ),
      ) &&
    !value
      .split('/')
      .some((part) =>
        /(?:\.(?:sqlite|sqlite3|db|pem|key|p12|pfx)(?:-wal|-shm)?$|^(?:\.docker|\.kube|\.gnupg|\.gcloud|\.npm|\.copilot|\.pi|\.credentials|\.bash_history|\.zsh_history|credentials|auth\.json|tokens?\.json|NuGet\.config)$)/i.test(
          part,
        ),
      )
  );
}
export function recoveryFileExclusions(files: ReadonlyArray<{ path: string }>) {
  // Anchored literal paths. Escape whitespace (including trailing spaces), wildcard
  // syntax and leading comment/negation characters; never import source config.
  return (
    '/.autopod/evidence/\n/.autopod/screenshots/\n' +
    files
      .map(({ path }) => {
        if (!safeForkFile(path) || /[\r\n\0]/.test(path))
          recoveryForkError('Unsafe supplemental path');
        return `/${path.replace(/[\\*?[\]#!\s]/g, '\\$&')}`;
      })
      .join('\n') +
    '\n'
  );
}
export async function inspectRecoveryForkFiles(source: string) {
  const git = recoveryGit(source);
  if ((await git(['for-each-ref', '--format=%(refname)', 'refs/replace/'])).stdout.trim())
    recoveryForkError(
      'Replacement refs are unsupported; original Git graph and metadata are retained',
    );
  const flags = (await git(['ls-files', '-v', '-z'])).stdout.split('\0');
  const config = (await git(['config', '--null', '--list'])).stdout.split('\0');
  if (
    flags.some((entry) => /^[a-zS] /.test(entry)) ||
    config.some((entry) =>
      /^(?:core\.sparsecheckout|index\.sparse)\n(?:true|1|yes|on)$/i.test(entry),
    )
  )
    recoveryForkError(
      'Sparse/assume-unchanged/skip-worktree source cannot establish clean tracked bytes',
    );
  const entries = (await git(['ls-tree', '-r', '-z', 'HEAD'])).stdout.split('\0').filter(Boolean);
  if (entries.length > 30000)
    recoveryForkError('Tracked source inventory exceeds supported bounds');
  const tracked = new Set<string>();
  for (const entry of entries) {
    const tab = entry.indexOf('\t');
    const [mode, type] = entry.slice(0, tab).split(' ');
    const file = entry.slice(tab + 1);
    if (
      tab < 0 ||
      type !== 'blob' ||
      !['100644', '100755'].includes(mode ?? '') ||
      !safeForkFile(file)
    )
      recoveryForkError(
        'Tracked credential/control/special source paths are unsupported; exact HEAD cannot be imported safely',
      );
    tracked.add(file);
  }
  const listing = parseRecoveryListing(
    await runHostRecoveryReader(recoveryReaderArgs('list', source)),
  );
  // Ignored files stay in original/private custody. Use read-only Git classification, no fetch.
  const allowed = new Set(
    (await git(['ls-files', '--others', '--exclude-standard', '-z'])).stdout
      .split('\0')
      .filter(Boolean),
  );
  const possible = listing.files.filter((f) => !tracked.has(f.path) && safeForkFile(f.path));
  const files = possible.filter((f) => allowed.has(f.path));
  return {
    files: files.map(({ path, size, version }) => ({ path, size, version })),
    truncated: listing.truncated,
    skippedEntries:
      listing.skippedEntries +
      listing.files.length -
      files.length -
      listing.files.filter((f) => tracked.has(f.path)).length,
  };
}

/** Read back exact selected context without following source links. */
export async function verifyRecoveryForkFiles(
  source: string,
  files: ReadonlyArray<{ path: string; sha256: string; size: number }>,
) {
  const listing = parseRecoveryListing(
    await runHostRecoveryReader(recoveryReaderArgs('list', source)),
  );
  for (const file of files) {
    const current = listing.files.find((entry) => entry.path === file.path);
    if (!current || current.size !== file.size)
      recoveryForkError('Selected recovery context is missing or changed');
    const content = parseRecoveryContent(
      await runHostRecoveryReader(recoveryReaderArgs('read', source, file.path, current.version)),
      file.path,
    );
    if (content.sha256 !== file.sha256 || content.size !== file.size)
      recoveryForkError('Selected recovery context bytes changed');
  }
}

/** Private host archive is retained separately; ONLY clone + explicitly chosen files enter child. */
export async function prepareRecoveryForkSource(
  options: Parameters<typeof prepareRetainedCheckpointWorkspace>[0] & {
    childBranch: string;
    input: RecoveryForkInput;
    packet: string;
  },
) {
  const catalog = await inspectRecoveryForkFiles(options.source);
  options.assertCurrent();
  const chosen = options.input.files.map((f) => {
    const current = catalog.files.find((c) => c.path === f.path && c.version === f.version);
    if (!current) recoveryForkError('Supplemental file changed or is unavailable');
    return current;
  });
  if (chosen.reduce((sum, file) => sum + file.size, 0) > RECOVERY_FILE_LIMITS.maxSelectionBytes)
    recoveryForkError('Selected supplemental files exceed 50 MiB');
  const prepared = await prepareRetainedCheckpointWorkspace({
    ...options,
    allowSupplementalFiles: true,
  });
  options.assertCurrent();
  await recoveryGit(
    prepared.worktree,
    options.assertCurrent,
  )(['checkout', '-b', options.childBranch, options.head]);
  const files = [];
  for (const file of chosen) {
    options.assertCurrent();
    const content = parseRecoveryContent(
      await runHostRecoveryReader(
        recoveryReaderArgs('read', options.source, file.path, file.version),
      ),
      file.path,
    );
    options.assertCurrent();
    const destination = path.join(prepared.worktree, file.path);
    // Tracked symlinks were rejected; the brand-new checkout has no untrusted parent links.
    await mkdir(path.dirname(destination), { recursive: true });
    if ((await lstat(path.dirname(destination))).isSymbolicLink())
      recoveryForkError('Unsafe destination');
    await writeFile(destination, Buffer.from(content.content, 'base64'), {
      flag: 'wx',
      mode: 0o644,
    });
    if (recoveryBytesHash(await readFile(destination)) !== content.sha256)
      recoveryForkError('Supplemental copy verification failed');
    files.push({ path: file.path, sha256: content.sha256, size: content.size });
    // The selected untracked supplement is independently hashed, never misrepresented as Git code.
    await appendFile(
      path.join(prepared.bare, 'info', 'exclude'),
      `\n${recoveryFileExclusions([file])}`,
    );
  }
  const packet = path.join(options.root, 'handoff.json');
  // The enclosing archive is private (0700); the single file is mounted read-only
  // so the non-root worker can read it across differing host/container UIDs.
  await writeFile(packet, options.packet, { flag: 'wx', mode: 0o444 });
  const packetHash = recoveryBytesHash(await readFile(packet));
  if (packetHash !== recoveryBytesHash(options.packet)) recoveryForkError('Handoff packet changed');
  options.assertCurrent();
  return { ...prepared, files, packet, packetHash, branch: options.childBranch };
}
