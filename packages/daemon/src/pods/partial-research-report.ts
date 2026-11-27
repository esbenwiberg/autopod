import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { AutopodError, type PartialResearchReport, type Pod } from '@autopod/shared';
import type { WorkspaceCheckpointResult } from '../worktrees/sandbox-workspace-checkpoint.js';
import { readArtifactSnapshotFile } from './artifact-snapshot-receipt.js';

const execFileAsync = promisify(execFile);
const GIT_OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

const REPORT_PATH = 'research-output.md';
const MAX_BYTES = 5 * 1024 * 1024;

export type PartialResearchCapture =
  | { content: Buffer; sha256: string; unavailableReason?: never }
  | { content?: never; sha256?: never; unavailableReason: string };

export type PartialResearchRecord = {
  capturedAt: string;
  content: Buffer | null;
  sha256: string | null;
  unavailableReason: string | null;
};

export function isPartialResearchPod(pod: Pod): boolean {
  return pod.completionPolicy === 'accept-findings' && pod.options.output === 'artifact';
}

/** Only copy the conventional report, from the just-preserved host workspace.
 * Never resolve arbitrary paths, look in the container, or follow file links. */
export async function capturePartialResearchReport(
  worktree: string,
): Promise<PartialResearchCapture> {
  try {
    const root = await lstat(worktree);
    if (!root.isDirectory())
      return { unavailableReason: 'The preserved workspace root is not a regular directory.' };

    const report = path.join(worktree, REPORT_PATH);
    const handle = await open(
      report,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1)
        return { unavailableReason: `${REPORT_PATH} must be a regular file without links.` };
      if (before.size > MAX_BYTES)
        return { unavailableReason: `${REPORT_PATH} exceeds the 5 MiB capture limit.` };

      const buffer = Buffer.alloc(before.size + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      const after = await handle.stat();
      const currentFile = await lstat(report);
      const currentRoot = await lstat(worktree);
      if (
        offset !== before.size ||
        currentFile.ino !== before.ino ||
        currentFile.dev !== before.dev ||
        currentFile.ctimeMs !== before.ctimeMs ||
        after.size !== before.size ||
        after.ctimeMs !== before.ctimeMs ||
        after.mtimeMs !== before.mtimeMs ||
        currentRoot.dev !== root.dev ||
        currentRoot.ino !== root.ino
      )
        return { unavailableReason: `${REPORT_PATH} or its workspace changed during capture.` };
      return sealReport(buffer.subarray(0, offset));
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      unavailableReason:
        code === 'ENOENT'
          ? `${REPORT_PATH} was not found in the preserved workspace.`
          : code === 'ELOOP'
            ? `${REPORT_PATH} must not be a symbolic link.`
            : `${REPORT_PATH} could not be read from the preserved workspace.`,
    };
  }
}

/** Capture only bytes that participated in verifying the exact artifact receipt. */
export async function captureArtifactPartialResearchReport(
  artifactRoot: string,
  snapshot: string,
  generation: number,
  cycle: number,
): Promise<PartialResearchCapture> {
  try {
    return sealReport(
      await readArtifactSnapshotFile(snapshot, artifactRoot, generation, cycle, REPORT_PATH),
    );
  } catch {
    return {
      unavailableReason: `${REPORT_PATH} was absent or could not be verified against the preserved artifact receipt.`,
    };
  }
}

/** A sandbox checkout may contain ignored host files that were never checkpointed,
 * or checkout filters may change materialized content. Only the proven tree is evidence. */
export async function captureSandboxPartialResearchReport(
  checkpoint: WorkspaceCheckpointResult | undefined,
): Promise<PartialResearchCapture> {
  if (
    !checkpoint?.objectStore ||
    !checkpoint.transferVerified ||
    !checkpoint.bundleVerified ||
    !checkpoint.hostImported ||
    !checkpoint.lineageVerified ||
    !checkpoint.promoted ||
    !checkpoint.materialized ||
    !GIT_OID.test(checkpoint.snapshotTree)
  )
    return {
      unavailableReason: 'No verified sandbox checkpoint tree is available for this report.',
    };

  const { objectStore, snapshotTree } = checkpoint;
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
  async function git(...args: string[]): Promise<Buffer> {
    return (
      await execFileAsync(
        'git',
        ['--no-replace-objects', '--literal-pathspecs', '--git-dir', objectStore, ...args],
        {
          env: {
            ...env,
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_NO_LAZY_FETCH: '1',
            GIT_TERMINAL_PROMPT: '0',
          },
          encoding: 'buffer',
          maxBuffer: MAX_BYTES,
          timeout: 5_000,
        },
      )
    ).stdout;
  }

  try {
    const entry = (await git('ls-tree', '-z', snapshotTree, '--', REPORT_PATH)).toString('utf8');
    if (!entry)
      return { unavailableReason: `${REPORT_PATH} is not in the verified sandbox checkpoint.` };
    const [metadata, name] = entry.split('\t');
    const [mode, type, oid] = metadata?.split(' ') ?? [];
    if (
      name !== `${REPORT_PATH}\0` ||
      (mode !== '100644' && mode !== '100755') ||
      type !== 'blob' ||
      !oid ||
      !GIT_OID.test(oid)
    )
      return {
        unavailableReason: `${REPORT_PATH} must be a regular file in the sandbox checkpoint.`,
      };
    const size = Number((await git('cat-file', '-s', oid)).toString('utf8').trim());
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid checkpoint blob size');
    if (size > MAX_BYTES)
      return { unavailableReason: `${REPORT_PATH} exceeds the 5 MiB capture limit.` };
    const bytes = await git('cat-file', 'blob', oid);
    const actualOid = createHash(oid.length === 40 ? 'sha1' : 'sha256')
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest('hex');
    if (bytes.length !== size || actualOid !== oid) throw new Error('Invalid checkpoint blob');
    return sealReport(bytes);
  } catch {
    return { unavailableReason: `${REPORT_PATH} could not be verified in the sandbox checkpoint.` };
  }
}

function sealReport(content: Buffer): PartialResearchCapture {
  if (!Buffer.from(content.toString('utf8'), 'utf8').equals(content))
    return { unavailableReason: `${REPORT_PATH} is not valid UTF-8.` };
  return { content, sha256: sha256(content) };
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

export function readPartialResearchReport(
  pod: Pod,
  lookup: (podId: string, generation: number, cycle: number) => PartialResearchRecord | null,
): PartialResearchReport {
  const unavailable = (message: string) =>
    new AutopodError(message, 'PARTIAL_RESEARCH_UNAVAILABLE', 409);
  const finalization = pod.finalization;
  if (!isPartialResearchPod(pod) || pod.status !== 'failed' || pod.researchFindings)
    throw unavailable('A failed artifact research pod without a findings receipt is required.');
  if (!finalization?.agentSettledAt || finalization.generation !== pod.lifecycleGeneration)
    throw unavailable('No settled worker is recorded for this lifecycle.');
  if (!finalization.sourcePreservedAt)
    throw unavailable('No successful workspace preservation is recorded for this worker.');
  const { generation, cycle, agentSettledAt } = finalization;
  const capture = lookup(pod.id, generation, cycle);
  if (!capture)
    throw unavailable(
      'No partial report was captured for this settled worker. A workspace preservation timestamp alone cannot verify the report.',
    );
  if (capture.unavailableReason) throw unavailable(capture.unavailableReason);
  const { content, sha256: expected, capturedAt } = capture;
  if (!content || content.length > MAX_BYTES || !expected || sha256(content) !== expected)
    throw unavailable('The retained partial report failed its integrity check.');
  return {
    path: REPORT_PATH,
    content: content.toString('utf8'),
    size: content.length,
    status: 'incomplete_unreviewed',
    provenance: { podId: pod.id, generation, cycle, agentSettledAt, capturedAt, sha256: expected },
  };
}
