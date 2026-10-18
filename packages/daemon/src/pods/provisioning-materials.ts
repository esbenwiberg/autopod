import type { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Pod, SpecFile } from '@autopod/shared';
import { AutopodError } from '@autopod/shared';
import type { Logger } from 'pino';
import type { WorktreeManager } from '../interfaces/index.js';

export const SPEC_CONTEXT_CONTAINER_DIR = '/autopod/spec';

export const POD_ARTIFACTS_CONTAINER_DIR = '/autopod/artifacts';

export function resolveSpecFilePath(worktreePath: string, filePath: string): string {
  const resolved = path.resolve(worktreePath, filePath);
  const root = path.resolve(worktreePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new AutopodError(
      `Spec file path escapes worktree: ${filePath}`,
      'INVALID_SPEC_FILE_PATH',
      400,
    );
  }
  return resolved;
}

export function dataDir(): string {
  return process.env.DATA_DIR ?? path.join(process.cwd(), '.autopod-data');
}

export function safeFsSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_') || 'unknown';
}

export async function materializeSpecContextFiles(
  podId: string,
  specContextFiles: readonly SpecFile[] | null | undefined,
  logger: Logger,
): Promise<string | null> {
  if (!specContextFiles || specContextFiles.length === 0) return null;

  const contextRoot = path.join(dataDir(), 'spec-context', safeFsSegment(podId));
  await rm(contextRoot, { recursive: true, force: true });
  await mkdir(contextRoot, { recursive: true });

  for (const file of specContextFiles) {
    const targetPath = resolveSpecFilePath(contextRoot, file.path);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, file.content, 'utf8');
  }

  logger.info(
    { podId, contextRoot, fileCount: specContextFiles.length },
    'Spec context files materialized',
  );
  return contextRoot;
}

export async function ensureSeriesArtifactsDir(pod: Pod, logger: Logger): Promise<string | null> {
  if (!pod.seriesId) return null;

  const artifactsRoot = path.join(dataDir(), 'pod-artifacts', safeFsSegment(pod.seriesId));
  const handoversRoot = path.join(artifactsRoot, 'handovers');
  await mkdir(handoversRoot, { recursive: true });
  await chmod(artifactsRoot, 0o777).catch(() => {});
  await chmod(handoversRoot, 0o777).catch(() => {});
  logger.debug({ podId: pod.id, seriesId: pod.seriesId, artifactsRoot }, 'Series artifacts ready');
  return artifactsRoot;
}

/** Normalize a JWT preferred_username into something that looks like an email.
 * Dev mode emits `developer` (no `@`); git accepts it but commits look weird.
 * Real Entra tokens already carry a UPN-shaped email here. */
export function normalizeCommitEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const trimmed = email.trim();
  if (!trimmed) return null;
  return trimmed.includes('@') ? trimmed : `${trimmed}@autopod.local`;
}

export function createProvisioningMaterials(execFileAsync: typeof execFile.__promisify__) {
  async function materializeSpecFiles(
    worktreePath: string,
    specFiles: readonly SpecFile[] | null | undefined,
    worktreeManager: WorktreeManager,
    logger: Logger,
  ): Promise<string | null> {
    if (!specFiles || specFiles.length === 0) return null;

    const changedPaths: string[] = [];
    for (const file of specFiles) {
      const targetPath = resolveSpecFilePath(worktreePath, file.path);
      let existing: string | null = null;
      try {
        existing = await readFile(targetPath, 'utf8');
      } catch {
        existing = null;
      }
      if (existing === file.content) continue;
      await mkdir(path.dirname(targetPath), { recursive: true });
      await writeFile(targetPath, file.content, 'utf8');
      changedPaths.push(file.path);
    }

    if (changedPaths.length > 0) {
      await worktreeManager.commitFiles(
        worktreePath,
        changedPaths,
        'docs(spec): add pod spec files',
      );
      logger.info(
        { worktreePath, fileCount: changedPaths.length },
        'Materialized spec files onto pod branch',
      );
    }

    try {
      const { stdout } = await execFileAsync('git', ['-C', worktreePath, 'rev-parse', 'HEAD']);
      return stdout.trim() || null;
    } catch (err) {
      logger.warn({ err, worktreePath }, 'Failed to resolve HEAD after spec materialization');
      return null;
    }
  }

  /**
   * Snapshot SHA-256 hashes of every script in `profile.deployment.allowedScripts`
   * read from the bare repo at the base ref. The deploy handler refuses to run a
   * script whose live container content does not hash to its baseline — without
   * this capture the agent could edit a deploy script and immediately invoke it.
   *
   * Glob patterns in `allowedScripts` (single-segment `*`) are expanded against
   * the file list at the base ref. Returns `null` when no patterns are
   * configured — caller treats that as "no baseline enforcement".
   */
  async function captureDeployBaselineHashes(
    bareRepoPath: string,
    baseRef: string,
    allowedScripts: string[] | undefined,
    log: Logger,
  ): Promise<Record<string, string> | null> {
    if (!allowedScripts || allowedScripts.length === 0) return null;

    let files: string[];
    try {
      const { stdout } = await execFileAsync('git', [
        '--git-dir',
        bareRepoPath,
        'ls-tree',
        '-r',
        '--name-only',
        baseRef,
      ]);
      files = stdout.split('\n').filter((l) => l.length > 0);
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), bareRepoPath, baseRef },
        'deploy baseline: could not list files at base ref',
      );
      return {};
    }

    const matches = new Set<string>();
    for (const pattern of allowedScripts) {
      if (!pattern.includes('*')) {
        if (files.includes(pattern)) matches.add(pattern);
        continue;
      }
      const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`^${escaped.replace(/\*/g, '[^/]*')}$`);
      for (const f of files) {
        if (re.test(f)) matches.add(f);
      }
    }

    const hashes: Record<string, string> = {};
    for (const scriptPath of matches) {
      try {
        const { stdout } = await execFileAsync(
          'git',
          ['--git-dir', bareRepoPath, 'show', `${baseRef}:${scriptPath}`],
          { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
        );
        hashes[scriptPath] = createHash('sha256').update(stdout, 'utf8').digest('hex');
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err), scriptPath, baseRef },
          'deploy baseline: could not read script at base ref',
        );
      }
    }

    return hashes;
  }
  return { materializeSpecFiles, captureDeployBaselineHashes };
}
