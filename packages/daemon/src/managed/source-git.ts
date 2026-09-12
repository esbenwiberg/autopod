import { execFile } from 'node:child_process';
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { FinalizeSourceDeliveryRequest, SourceCandidateReceipt } from '@autopod/shared';

const exec = promisify(execFile);
export const ZERO_COMMIT = '0'.repeat(40);
export const MAX_CANDIDATE_BYTES = 64 * 1024 * 1024;
const MANAGED_RECOVERY_COMMIT_MESSAGE = 'chore: capture managed worker changes';
const MANAGED_RECOVERY_COMMIT_IDENTITY = {
  name: 'Autopod',
  email: 'autopod@autopod.local',
} as const;
export type ManagedGitCredentialMode = 'bearer' | 'github-basic';
export interface ManagedGitCredential {
  url: string;
  token: string;
  mode?: ManagedGitCredentialMode;
}
export interface SourceEnrollment {
  repository: string;
  remote: string;
  remoteUrl: string;
  base: string;
  baseCommit: string;
  branchNamespace: string;
  /** Explicit transport mode. Omission preserves the existing bearer behavior. */
  credentialMode?: ManagedGitCredentialMode;
  /** Trusted isolated Git repository per pod; never the user's ordinary checkout. */
  workspace(podId: string): string;
}
function managedGitSafeDirectories(
  cwd: string,
  trustedDirectories: readonly string[] = [],
): string[] {
  const directories = [path.resolve(cwd), ...trustedDirectories];
  for (const directory of directories)
    if (!path.isAbsolute(directory) || /[\0\r\n*]/.test(directory))
      throw new Error('managed-git-safe-directory-invalid');
  return [...new Set(directories.map((item) => path.resolve(item)))];
}
export function managedGitConfigContents(
  cwd: string,
  trustedDirectories: readonly string[] = [],
): string {
  return `[safe]\n${managedGitSafeDirectories(cwd, trustedDirectories)
    .map((directory) => `\tdirectory = ${JSON.stringify(directory)}\n`)
    .join('')}`;
}
export function managedGitArguments(
  cwd: string,
  trustedDirectories: readonly string[] = [],
): string[] {
  const safeDirectories = managedGitSafeDirectories(cwd, trustedDirectories);
  return [
    '--no-pager',
    ...[...new Set(safeDirectories)].flatMap((directory) => ['-c', `safe.directory=${directory}`]),
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'credential.helper=',
    '-c',
    'protocol.ext.allow=never',
    '-c',
    'http.followRedirects=false',
  ];
}
export function managedGitAuthorizationHeader(credential: ManagedGitCredential): string {
  if (!credential.token || /[\0\r\n]/.test(credential.token))
    throw new Error('managed-git-credential-invalid');
  if ((credential.mode ?? 'bearer') === 'bearer')
    return `Authorization: Bearer ${credential.token}`;
  const url = new URL(credential.url);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port)
    throw new Error('managed-git-credential-mode-mismatch');
  return `Authorization: Basic ${Buffer.from(`x-access-token:${credential.token}`).toString('base64')}`;
}
export async function managedGit(
  cwd: string,
  args: string[],
  credential?: ManagedGitCredential,
  trustedDirectories: readonly string[] = [],
): Promise<string> {
  const configRoot = await mkdtemp(path.join(tmpdir(), 'autopod-managed-git-config-'));
  const configPath = path.join(configRoot, 'config');
  try {
    await writeFile(configPath, managedGitConfigContents(cwd, trustedDirectories), {
      mode: 0o600,
      flag: 'wx',
    });
    const result = await exec('git', [...managedGitArguments(cwd, trustedDirectories), ...args], {
      cwd,
      maxBuffer: MAX_CANDIDATE_BYTES,
      timeout: 60000,
      env: {
        PATH: process.env.PATH,
        HOME: '/nonexistent',
        GIT_CONFIG_NOSYSTEM: '1',
        // Local clone's upload-pack child ignores command-line safe.directory entries but
        // inherits this exact, non-secret per-call config.
        GIT_CONFIG_GLOBAL: configPath,
        GIT_TERMINAL_PROMPT: '0',
        GIT_NO_REPLACE_OBJECTS: '1',
        ...(credential
          ? {
              GIT_CONFIG_COUNT: '1',
              GIT_CONFIG_KEY_0: `http.${credential.url}.extraHeader`,
              GIT_CONFIG_VALUE_0: managedGitAuthorizationHeader(credential),
            }
          : {}),
      },
    });
    return result.stdout.trim();
  } catch {
    throw new Error('managed-git-operation-failed');
  } finally {
    await rm(configRoot, { recursive: true, force: true });
  }
}

/** Git effects use an enrolled URL, never a worker-editable remote configuration. */
export class ManagedGitBroker {
  constructor(
    readonly enrollments: readonly SourceEnrollment[],
    readonly credential?: (
      binding: SourceEnrollment,
    ) => Promise<{ token: string; expiresAt: number }>,
  ) {}
  private async network(
    binding: SourceEnrollment,
    cwd: string,
    args: string[],
    authorize?: () => void,
  ): Promise<string> {
    const credential = path.isAbsolute(binding.remoteUrl)
      ? undefined
      : await this.credential?.(binding);
    const now = Math.floor(Date.now() / 1000);
    if (
      credential &&
      (credential.expiresAt <= now ||
        credential.expiresAt > now + 600 ||
        /[\r\n]/.test(credential.token))
    )
      throw new Error('source-credential-not-short-lived');
    authorize?.();
    return managedGit(
      cwd,
      args,
      credential
        ? { url: binding.remoteUrl, token: credential.token, mode: binding.credentialMode }
        : undefined,
    );
  }
  binding(source: {
    repository: string;
    remote: string;
    head: string;
    base: string;
  }): SourceEnrollment {
    const matches = this.enrollments.filter(
      (item) => item.repository === source.repository && item.remote === source.remote,
    );
    const binding = matches[0];
    if (
      matches.length !== 1 ||
      !binding ||
      source.base !== binding.base ||
      !source.head.startsWith(binding.branchNamespace) ||
      source.head === binding.base ||
      source.head.includes('..') ||
      source.head.includes('//') ||
      source.head.endsWith('/') ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(source.head)
    )
      throw new Error('source-enrollment-mismatch');
    // Reusable credentials embedded in URLs are never accepted or persisted.
    if (!path.isAbsolute(binding.remoteUrl)) {
      const url = new URL(binding.remoteUrl);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
        throw new Error('source-remote-invalid');
      if (binding.credentialMode === 'github-basic' && (url.hostname !== 'github.com' || url.port))
        throw new Error('source-credential-mode-mismatch');
    }
    return binding;
  }
  async remoteHead(binding: SourceEnrollment, head: string): Promise<string> {
    const text = await this.network(binding, tmpdir(), [
      'ls-remote',
      '--refs',
      binding.remoteUrl,
      `refs/heads/${head}`,
    ]);
    if (!text) return ZERO_COMMIT;
    const lines = text.split('\n');
    if (
      lines.length !== 1 ||
      !/^[a-f0-9]{40}\s/.test(text) ||
      text.split(/\s+/)[1] !== `refs/heads/${head}`
    )
      throw new Error('source-remote-ambiguous');
    return text.split(/\s+/)[0]!;
  }
  async freeze(
    podId: string,
    source: { repository: string; remote: string; head: string; base: string },
  ): Promise<{ newCommit: string; expectedOldCommit: string; bundle: Buffer }> {
    const binding = this.binding(source);
    const cwd = binding.workspace(podId);
    // Managed workspaces are independent repositories, never linked worktrees sharing host Git metadata.
    const metadata = path.join(cwd, '.git');
    const walk = async (directory: string): Promise<void> => {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error('source-git-metadata-unisolated');
      for (const name of await readdir(directory)) {
        const file = path.join(directory, name);
        const stat = await lstat(file);
        if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)))
          throw new Error('source-git-metadata-unisolated');
        if (stat.isDirectory()) await walk(file);
      }
    };
    await walk(metadata);
    try {
      await lstat(path.join(metadata, 'objects/info/alternates'));
      throw new Error('source-git-alternates-forbidden');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const config = await readFile(path.join(metadata, 'config'), 'utf8');
    if (
      /^\s*\[\s*(include|filter|diff|credential|url|http|protocol)/im.test(config) ||
      /^\s*(worktree|fsmonitor|sshCommand|gitProxy)\s*=/im.test(config)
    )
      throw new Error('source-git-config-untrusted');
    // The worker is asked to commit its own changes, but a successful agent process can
    // omit that final mechanical step. Capture the isolated workspace deterministically
    // before freezing so validated work is not discarded merely because `git commit`
    // was skipped. Hooks, ambient config/credentials and commit signing stay disabled.
    if (await managedGit(cwd, ['status', '--porcelain', '--untracked-files=all'])) {
      await managedGit(cwd, ['add', '--all', '--', '.']);
      await managedGit(cwd, [
        '-c',
        `user.name=${MANAGED_RECOVERY_COMMIT_IDENTITY.name}`,
        '-c',
        `user.email=${MANAGED_RECOVERY_COMMIT_IDENTITY.email}`,
        '-c',
        'commit.gpgSign=false',
        'commit',
        '--no-verify',
        '-m',
        MANAGED_RECOVERY_COMMIT_MESSAGE,
      ]);
      if (await managedGit(cwd, ['status', '--porcelain', '--untracked-files=all']))
        throw new Error('source-candidate-dirty');
    }
    const newCommit = await managedGit(cwd, ['rev-parse', '--verify', 'HEAD^{commit}']);
    await managedGit(cwd, ['merge-base', '--is-ancestor', binding.baseCommit, newCommit]);
    if ((await this.remoteHead(binding, binding.base)) !== binding.baseCommit)
      throw new Error('source-base-moved');
    const expectedOldCommit = await this.remoteHead(binding, source.head);
    if (expectedOldCommit !== ZERO_COMMIT)
      await managedGit(cwd, ['merge-base', '--is-ancestor', expectedOldCommit, newCommit]);
    const directory = await mkdtemp(path.join(tmpdir(), 'managed-candidate-'));
    try {
      const bundlePath = path.join(directory, 'candidate.bundle');
      await managedGit(cwd, ['bundle', 'create', bundlePath, 'HEAD']);
      const bundle = await readFile(bundlePath);
      if (bundle.length > MAX_CANDIDATE_BYTES) throw new Error('source-candidate-too-large');
      return { newCommit, expectedOldCommit, bundle };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  async unchanged(
    podId: string,
    source: { repository: string; remote: string; head: string; base: string },
  ): Promise<boolean> {
    const binding = this.binding(source);
    const cwd = binding.workspace(podId);
    if (await managedGit(cwd, ['status', '--porcelain', '--untracked-files=all'])) return false;
    return (
      (await managedGit(cwd, ['rev-parse', '--verify', 'HEAD^{commit}'])) === binding.baseCommit
    );
  }
  async branchMatches(candidate: SourceCandidateReceipt): Promise<boolean> {
    return (await this.remoteHead(this.binding(candidate), candidate.head)) === candidate.newCommit;
  }
  async push(
    candidate: SourceCandidateReceipt,
    authorize: () => void,
    bundle: Buffer,
  ): Promise<void> {
    const binding = this.binding(candidate);
    if ((await this.remoteHead(binding, binding.base)) !== binding.baseCommit)
      throw new Error('source-base-moved');
    const old = await this.remoteHead(binding, candidate.head);
    if (old !== candidate.expectedOldCommit) throw new Error('source-head-moved');
    const cwd = await mkdtemp(path.join(tmpdir(), 'managed-broker-'));
    try {
      // Worker Git config (including URL rewrites/proxies) never enters the credentialed effect process.
      const bundlePath = path.join(cwd, 'candidate.bundle');
      await writeFile(bundlePath, bundle, { flag: 'wx', mode: 0o400 });
      await managedGit(cwd, ['init', '--bare', '.']);
      await managedGit(cwd, ['fetch', '--no-tags', bundlePath, 'HEAD']);
      if (old !== ZERO_COMMIT)
        await managedGit(cwd, ['merge-base', '--is-ancestor', old, candidate.newCommit]);
      await managedGit(cwd, [
        'merge-base',
        '--is-ancestor',
        binding.baseCommit,
        candidate.newCommit,
      ]);
      // Lease is a CAS, with an independent ancestry check: never overwrite divergent work.
      await this.network(
        binding,
        cwd,
        [
          'push',
          `--force-with-lease=refs/heads/${candidate.head}:${old === ZERO_COMMIT ? '' : old}`,
          binding.remoteUrl,
          `${candidate.newCommit}:refs/heads/${candidate.head}`,
        ],
        authorize,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
}

export interface DraftRecord {
  id: number;
  repository: string;
  head: string;
  base: string;
  commit: string;
  draft: boolean;
  bodyDigest: string;
}
export interface DraftBroker {
  inspect(request: FinalizeSourceDeliveryRequest): Promise<DraftRecord | null>;
  create(request: FinalizeSourceDeliveryRequest): Promise<DraftRecord>;
  update(request: FinalizeSourceDeliveryRequest, existing: DraftRecord): Promise<DraftRecord>;
}
