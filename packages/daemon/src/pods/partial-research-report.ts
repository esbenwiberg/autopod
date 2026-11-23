import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { AutopodError, type PartialResearchReport, type Pod } from '@autopod/shared';

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
      const content = buffer.subarray(0, offset);
      if (!Buffer.from(content.toString('utf8'), 'utf8').equals(content))
        return { unavailableReason: `${REPORT_PATH} is not valid UTF-8.` };
      return { content, sha256: sha256(content) };
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
