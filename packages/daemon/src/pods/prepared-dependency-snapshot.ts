import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ExecutionTarget, PodStatus, RepositoryPreparationEvidence } from '@autopod/shared';
import type { ContainerManager } from '../interfaces/container-manager.js';
import type { PreparationReuseAttempt, PreparationReuseInputs } from './repository-preparation.js';

/**
 * Same-pod prepared-dependency snapshots for provider continuations (#644).
 *
 * At continuation teardown the daemon exports the old container's `node_modules`
 * directories into a daemon-owned host directory (mode 0700, never mounted into any
 * container) with a manifest of the reuse inputs. The next provisioning of that pod
 * consumes it exactly once: it restores only when every input matches and every archive
 * verifies; otherwise it refuses with a reason and the caller prepares in full.
 */

const MANIFEST = 'manifest.json';
const ARCHIVES = 'archives';
const GIB = 1024 * 1024 * 1024;
const MAX_ARCHIVES = 500;
export const SNAPSHOT_CAPTURE_TIMEOUT_MS = 5 * 60 * 1000;
const RESTORE_TIMEOUT_MS = 5 * 60 * 1000;
/** Snapshot of a pod still being captured (no manifest yet) or awaiting its provisioning. */
const SWEEP_CAPTURE_GRACE_MS = 15 * 60 * 1000;
const SWEEP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface Logger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface PreparedDependencyManifest {
  version: 1;
  podId: string;
  executionTarget: 'local';
  sourceContainerId: string;
  previousStatus: RepositoryPreparationEvidence['status'];
  outsideWorkspaceWrites: NonNullable<RepositoryPreparationEvidence['outsideWorkspaceWrites']>;
  commandHash: string;
  configurationHash: string;
  dependencyInputs: string;
  imageDigest: string;
  createdAt: string;
  totalBytes: number;
  archives: Array<{ file: string; containerPath: string; bytes: number; sha256: string }>;
}

function positiveEnvBytes(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function preparedDependenciesRoot(): string {
  return (
    process.env.AUTOPOD_PREPARED_DEPENDENCIES_DIR ??
    path.join(os.homedir(), '.autopod', 'prepared-dependencies')
  );
}

export function preparedDependenciesDirForPod(podId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(podId)) throw new Error('Invalid pod id for snapshot path');
  return path.join(preparedDependenciesRoot(), podId);
}

export function snapshotLimits(): {
  perPodBytes: number;
  totalBytes: number;
  minFreeBytes: number;
} {
  const perPodBytes = positiveEnvBytes('AUTOPOD_PREPARED_DEPENDENCIES_MAX_BYTES', 4 * GIB);
  const totalBytes = positiveEnvBytes('AUTOPOD_PREPARED_DEPENDENCIES_TOTAL_MAX_BYTES', 8 * GIB);
  return { perPodBytes, totalBytes, minFreeBytes: Math.max(2 * GIB, 2 * perPodBytes) };
}

export async function cleanupPreparedDependencies(podId: string): Promise<void> {
  await rm(preparedDependenciesDirForPod(podId), { recursive: true, force: true });
}

async function directoryBytes(dir: string): Promise<number> {
  let total = 0;
  let entries: Array<import('node:fs').Dirent>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(full);
    else if (entry.isFile())
      total += await stat(full).then(
        (s) => s.size,
        () => 0,
      );
  }
  return total;
}

async function readManifest(dir: string): Promise<PreparedDependencyManifest | null> {
  try {
    const parsed = JSON.parse(await readFile(path.join(dir, MANIFEST), 'utf8')) as unknown;
    return isManifest(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isManifest(value: unknown): value is PreparedDependencyManifest {
  const m = value as Partial<PreparedDependencyManifest> | null;
  return (
    !!m &&
    m.version === 1 &&
    typeof m.podId === 'string' &&
    m.executionTarget === 'local' &&
    typeof m.sourceContainerId === 'string' &&
    typeof m.commandHash === 'string' &&
    typeof m.configurationHash === 'string' &&
    typeof m.dependencyInputs === 'string' &&
    typeof m.imageDigest === 'string' &&
    typeof m.totalBytes === 'number' &&
    Array.isArray(m.archives) &&
    m.archives.every(
      (a) =>
        typeof a?.file === 'string' &&
        /^\d{3,}\.tar$/.test(a.file) &&
        typeof a.containerPath === 'string' &&
        isRestorableContainerPath(a.containerPath) &&
        typeof a.bytes === 'number' &&
        typeof a.sha256 === 'string' &&
        /^[a-f0-9]{64}$/.test(a.sha256),
    )
  );
}

/** `/workspace/<relative>/node_modules` without traversal or shell-hostile characters. */
export function isRestorableContainerPath(containerPath: string): boolean {
  if (!/^\/workspace(?:\/[A-Za-z0-9_.@+-]+)*\/node_modules$/.test(containerPath)) return false;
  return !containerPath
    .split('/')
    .slice(1)
    .some((part) => part === '.' || part === '..' || part === '.git');
}

export type CaptureResult =
  | { status: 'captured'; archives: number; bytes: number; durationMs: number }
  | { status: 'skipped'; reason: string };

export interface CaptureInput {
  podId: string;
  executionTarget: ExecutionTarget;
  containerId: string;
  cm: ContainerManager;
  /** Latest preparation evidence and the image digest it was produced in. */
  evidence: RepositoryPreparationEvidence | undefined;
  imageDigest: string | null | undefined;
  timeoutMs?: number;
}

function captureRefusal(input: CaptureInput): string | null {
  const evidence = input.evidence;
  if (input.executionTarget !== 'local') return 'unsupported-target';
  if (!input.cm.exportPathArchive || !input.cm.importPathArchive) return 'unsupported-target';
  if (!evidence || evidence.status === 'not-configured') return 'no-preparation';
  if (evidence.containerId !== input.containerId) return 'preparation-from-another-container';
  if (evidence.status !== 'passed') return 'previous-preparation-not-passed';
  if (evidence.outsideWorkspaceWrites !== 'none')
    return evidence.outsideWorkspaceWrites === 'detected'
      ? 'outside-workspace-writes'
      : 'outside-workspace-writes-unverified';
  if (!evidence.commandHash || !evidence.configurationHash) return 'no-preparation';
  if (!evidence.dependencyInputs) return 'dependency-inputs-unverified';
  if (!input.imageDigest) return 'image-unverified';
  return null;
}

/** Best effort and bounded: never throws; any failure removes the partial snapshot. */
export async function capturePreparedDependencySnapshot(
  input: CaptureInput,
): Promise<CaptureResult> {
  const refusal = captureRefusal(input);
  if (refusal) return { status: 'skipped', reason: refusal };
  const evidence = input.evidence as RepositoryPreparationEvidence;
  const started = Date.now();
  const deadline = started + (input.timeoutMs ?? SNAPSHOT_CAPTURE_TIMEOUT_MS);
  const remaining = () => deadline - Date.now();
  let dir: string;
  try {
    dir = preparedDependenciesDirForPod(input.podId);
  } catch {
    return { status: 'skipped', reason: 'invalid-pod-id' };
  }
  const limits = snapshotLimits();
  try {
    const root = preparedDependenciesRoot();
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    await rm(dir, { recursive: true, force: true });
    const disk = await statfs(root);
    if (disk.bavail * disk.bsize < limits.minFreeBytes)
      return { status: 'skipped', reason: 'low-host-disk' };
    const used = await directoryBytes(root);
    const budget = Math.min(limits.perPodBytes, limits.totalBytes - used);
    if (budget <= 0) return { status: 'skipped', reason: 'global-cap-reached' };

    const listing = await input.cm.execInContainer(
      input.containerId,
      [
        'sh',
        '-c',
        `find /workspace -xdev -path /workspace/.git -prune -o -type d -name node_modules -prune -print 2>/dev/null | head -n ${MAX_ARCHIVES + 1}`,
      ],
      { timeout: Math.max(1000, Math.min(30000, remaining())), maxOutputBytes: 256 * 1024 },
    );
    if (listing.exitCode !== 0) return { status: 'skipped', reason: 'listing-failed' };
    const paths = listing.stdout.split('\n').filter(Boolean).sort();
    if (paths.length === 0) return { status: 'skipped', reason: 'no-node-modules' };
    if (paths.length > MAX_ARCHIVES) return { status: 'skipped', reason: 'too-many-directories' };
    if (!paths.every(isRestorableContainerPath))
      return { status: 'skipped', reason: 'unsupported-directory-name' };

    await mkdir(path.join(dir, ARCHIVES), { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const archives: PreparedDependencyManifest['archives'] = [];
    let totalBytes = 0;
    for (const [i, containerPath] of paths.entries()) {
      if (remaining() <= 0) throw new SnapshotSkip('capture-timed-out');
      const file = `${String(i).padStart(3, '0')}.tar`;
      let exported: { bytes: number; sha256: string };
      try {
        exported = await (
          input.cm.exportPathArchive as NonNullable<ContainerManager['exportPathArchive']>
        )(input.containerId, containerPath, path.join(dir, ARCHIVES, file), {
          maxBytes: budget - totalBytes,
          timeoutMs: remaining(),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (/byte limit/.test(message)) throw new SnapshotSkip('size-limit-exceeded');
        if (/timed out/.test(message)) throw new SnapshotSkip('capture-timed-out');
        throw new SnapshotSkip('export-failed');
      }
      totalBytes += exported.bytes;
      archives.push({ file, containerPath, ...exported });
    }
    const manifest: PreparedDependencyManifest = {
      version: 1,
      podId: input.podId,
      executionTarget: 'local',
      sourceContainerId: input.containerId,
      previousStatus: evidence.status,
      outsideWorkspaceWrites: 'none',
      commandHash: evidence.commandHash as string,
      configurationHash: evidence.configurationHash as string,
      dependencyInputs: evidence.dependencyInputs as string,
      imageDigest: input.imageDigest as string,
      createdAt: new Date().toISOString(),
      totalBytes,
      archives,
    };
    // Written last, atomically: a snapshot without a manifest is never consumed.
    const temp = path.join(dir, `.${MANIFEST}.${randomBytes(6).toString('hex')}`);
    await writeFile(temp, JSON.stringify(manifest), { mode: 0o600 });
    await rename(temp, path.join(dir, MANIFEST));
    return {
      status: 'captured',
      archives: archives.length,
      bytes: totalBytes,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    return {
      status: 'skipped',
      reason: error instanceof SnapshotSkip ? error.reason : 'capture-failed',
    };
  }
}

class SnapshotSkip extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

export interface ReuseCurrent extends PreparationReuseInputs {
  podId: string;
  executionTarget: ExecutionTarget;
  imageDigest: string | null | undefined;
}

/** Pure, fail-closed reuse decision. Every input must match a passed, contained preparation. */
export function decidePreparationReuse(
  manifest: PreparedDependencyManifest | null,
  current: ReuseCurrent,
): { reuse: true } | { reuse: false; reason: string } {
  if (!manifest) return { reuse: false, reason: 'no-snapshot' };
  if (manifest.podId !== current.podId) return { reuse: false, reason: 'snapshot-pod-mismatch' };
  if (current.executionTarget !== 'local' || manifest.executionTarget !== 'local')
    return { reuse: false, reason: 'unsupported-target' };
  if (manifest.previousStatus !== 'passed')
    return { reuse: false, reason: 'previous-preparation-not-passed' };
  if (manifest.outsideWorkspaceWrites !== 'none')
    return { reuse: false, reason: 'outside-workspace-writes' };
  if (manifest.commandHash !== current.commandHash)
    return { reuse: false, reason: 'command-changed' };
  if (manifest.configurationHash !== current.configurationHash)
    return { reuse: false, reason: 'configuration-changed' };
  if (!current.dependencyInputs) return { reuse: false, reason: 'dependency-inputs-unverified' };
  if (manifest.dependencyInputs !== current.dependencyInputs)
    return { reuse: false, reason: 'dependency-inputs-changed' };
  if (!current.imageDigest) return { reuse: false, reason: 'image-unverified' };
  if (manifest.imageDigest !== current.imageDigest)
    return { reuse: false, reason: 'image-changed' };
  if (manifest.archives.length === 0) return { reuse: false, reason: 'no-snapshot' };
  return { reuse: true };
}

async function fileSha256(file: string): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    bytes += (chunk as Buffer).length;
    hash.update(chunk as Buffer);
  }
  return { bytes, sha256: hash.digest('hex') };
}

/**
 * Consume the pod's snapshot exactly once: decide, verify, restore. The snapshot is
 * deleted afterwards whatever the outcome. Refusals never leave partial restores behind.
 */
export async function consumePreparedDependencySnapshot(input: {
  cm: ContainerManager;
  containerId: string;
  current: ReuseCurrent;
}): Promise<PreparationReuseAttempt> {
  let dir: string;
  try {
    dir = preparedDependenciesDirForPod(input.current.podId);
  } catch {
    return { reused: false, reason: 'no-snapshot' };
  }
  const started = Date.now();
  const restored: string[] = [];
  try {
    const manifest = await readManifest(dir);
    const decision = decidePreparationReuse(manifest, input.current);
    if (!decision.reuse) return { reused: false, reason: decision.reason };
    const snapshot = manifest as PreparedDependencyManifest;
    const { cm, containerId } = input;
    if (!cm.importPathArchive) return { reused: false, reason: 'unsupported-target' };
    for (const archive of snapshot.archives) {
      const observed = await fileSha256(path.join(dir, ARCHIVES, archive.file)).catch(() => null);
      if (!observed || observed.bytes !== archive.bytes || observed.sha256 !== archive.sha256)
        return { reused: false, reason: 'snapshot-integrity-failed' };
    }
    // Every parent must exist inside /workspace without symlinks, and no target may exist:
    // a fresh continuation container never has workspace node_modules.
    const parents = snapshot.archives.map((a) => path.posix.dirname(a.containerPath));
    const layout = await cm.execInContainer(
      containerId,
      [
        'sh',
        '-c',
        'for d in "$@"; do [ -d "$d" ] && [ "$(realpath -- "$d")" = "$d" ] && [ ! -e "$d/node_modules" ] && [ ! -L "$d/node_modules" ] || exit 3; done',
        'autopod-restore-layout',
        ...parents,
      ],
      { timeout: 15000, maxOutputBytes: 1024 },
    );
    if (layout.exitCode !== 0) return { reused: false, reason: 'workspace-layout-changed' };
    const deadline = started + RESTORE_TIMEOUT_MS;
    for (const [i, archive] of snapshot.archives.entries()) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new SnapshotSkip('restore-timed-out');
      restored.push(archive.containerPath);
      await cm.importPathArchive(
        containerId,
        path.join(dir, ARCHIVES, archive.file),
        parents[i] as string,
        {
          timeoutMs: remaining,
        },
      );
    }
    return {
      reused: true,
      sourceContainerId: snapshot.sourceContainerId,
      restoredArchives: snapshot.archives.length,
      restoredBytes: snapshot.totalBytes,
      restoreMs: Date.now() - started,
    };
  } catch (error) {
    if (restored.length)
      await input.cm
        .execInContainer(input.containerId, ['rm', '-rf', '--', ...restored], {
          timeout: 120000,
          maxOutputBytes: 1024,
        })
        .catch(() => {});
    return {
      reused: false,
      reason: error instanceof SnapshotSkip ? error.reason : 'restore-failed',
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Delete snapshots that can no longer be consumed: pod missing or settled, older than
 * 24 h, or not awaiting provisioning after a 15-minute capture grace. Returns removed ids.
 */
export async function sweepPreparedDependencySnapshots(
  podStatus: (podId: string) => { status: PodStatus } | null,
  now: number = Date.now(),
): Promise<string[]> {
  const root = preparedDependenciesRoot();
  let entries: Array<import('node:fs').Dirent>;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const entry of entries) {
    const dir = path.join(root, entry.name);
    let remove = !entry.isDirectory();
    if (!remove) {
      const pod = (() => {
        try {
          return podStatus(entry.name);
        } catch {
          return null;
        }
      })();
      const age =
        now -
        (await stat(dir).then(
          (s) => s.mtimeMs,
          () => 0,
        ));
      const awaiting =
        pod?.status === 'queued' || pod?.status === 'provisioning' || pod?.status === 'paused';
      remove =
        !pod ||
        pod.status === 'complete' ||
        pod.status === 'killed' ||
        pod.status === 'killing' ||
        pod.status === 'failed' ||
        age > SWEEP_MAX_AGE_MS ||
        (!awaiting && age > SWEEP_CAPTURE_GRACE_MS);
    }
    if (remove) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      removed.push(entry.name);
    }
  }
  return removed;
}

export function logCaptureResult(logger: Logger, podId: string, result: CaptureResult): string {
  if (result.status === 'captured') {
    logger.info({ podId, ...result }, 'Prepared dependencies saved for continuation');
    return `Prepared dependencies saved for continuation (${result.archives} archive${
      result.archives === 1 ? '' : 's'
    }, ${(result.bytes / (1024 * 1024)).toFixed(1)} MiB in ${(result.durationMs / 1000).toFixed(1)}s)`;
  }
  logger.info({ podId, reason: result.reason }, 'Prepared dependency snapshot skipped');
  return `Prepared dependencies not saved for continuation — ${result.reason}`;
}
