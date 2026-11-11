import { createHash } from 'node:crypto';
import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Pod } from '@autopod/shared';
import {
  parseRecoveryContent,
  parseRecoveryListing,
  recoveryReaderArgs,
  runHostRecoveryReader,
} from '../containers/recovery-file-reader.js';
import {
  RECOVERY_FILE_EXCLUDES,
  RECOVERY_FILE_LIMITS,
  type RecoveryFileContent,
  type RecoveryFileSelection,
  type RecoveryFileSource,
  type RecoveryFilesSnapshot,
  recoveryFileError,
  safeRecoveryPath,
} from '../interfaces/recovery-files.js';
import { readArtifactSnapshotFile, verifyArtifactSnapshot } from './artifact-snapshot-receipt.js';

export const fileRecoveryHash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const podBinding = (p: Pod) =>
  fileRecoveryHash([
    p.id,
    p.lifecycleGeneration,
    p.status,
    p.worktreePath,
    p.artifactsPath,
    p.containerId,
    p.executionTarget,
    p.researchFindings,
  ]);

export function createFileRecovery(deps: {
  getPod(id: string): Pod;
  original(
    id: string,
    selection?: RecoveryFileSelection,
    includeFiles?: boolean,
  ): Promise<{ source: RecoveryFileSource; content?: RecoveryFileContent }>;
}) {
  function current(id: string, binding: string) {
    if (podBinding(deps.getPod(id)) !== binding) recoveryFileError();
  }
  function assertFindings(pod: Pod) {
    if (
      pod.completionPolicy === 'accept-findings' &&
      (pod.status === 'research_ready' ||
        pod.status === 'complete' ||
        pod.finalization?.agentSettledAt) &&
      !pod.researchFindings
    ) {
      recoveryFileError(
        'Settled research requires its retained findings receipt before files can be read.',
      );
    }
  }
  function roots(pod: Pod) {
    const findings = pod.researchFindings;
    // Never label a mutable host worktree as the settled research snapshot.
    return [
      {
        id: 'saved-artifacts',
        label: 'Saved reports and artifacts',
        root: findings?.artifactsPath ?? pod.artifactsPath,
        findings,
      },
      ...(!findings
        ? [
            {
              id: 'saved-workspace',
              label: 'Saved host workspace',
              root: pod.worktreePath,
              findings: undefined,
            },
          ]
        : []),
    ].filter((x) => x.root);
  }
  async function saved(pod: Pod, id: string) {
    const source = roots(pod).find((x) => x.id === id);
    if (!source?.root) recoveryFileError();
    const before = await lstat(source.root, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) recoveryFileError();
    const root = await realpath(source.root);
    const metadata = await stat(root, { bigint: true });
    if (!metadata.isDirectory() || metadata.dev !== before.dev || metadata.ino !== before.ino)
      recoveryFileError();
    const rootIdentity = `${metadata.dev}:${metadata.ino}`;
    const binding = fileRecoveryHash([podBinding(pod), source.id, root, rootIdentity]);
    if (source.findings)
      await verifyArtifactSnapshot(
        root,
        path.join(
          process.env.DATA_DIR ?? path.join(process.cwd(), '.autopod-data'),
          'artifacts',
          pod.id,
        ),
        source.findings.generation,
        source.findings.cycle,
        source.findings.snapshotHash,
      );
    return { ...source, root, binding, rootIdentity };
  }
  async function inspect(id: string, includeOriginal = false): Promise<RecoveryFilesSnapshot> {
    const pod = deps.getPod(id);
    assertFindings(pod);
    const originalBinding = podBinding(pod);
    const sources: RecoveryFileSource[] = [];
    for (const candidate of roots(pod)) {
      try {
        const selected = await saved(pod, candidate.id);
        const files = parseRecoveryListing(
          await runHostRecoveryReader(
            recoveryReaderArgs('list', selected.root, '', '', selected.rootIdentity),
          ),
        );
        current(id, originalBinding);
        const after = await saved(deps.getPod(id), candidate.id);
        if (after.binding !== selected.binding) recoveryFileError();
        sources.push({
          ...files,
          id: candidate.id,
          kind: 'saved',
          label: candidate.label,
          binding: selected.binding,
          status: 'available',
          detail:
            'Already on the daemon host. This copy may be older than the original environment; it is not proof that all files were saved.',
        });
      } catch {
        sources.push({
          id: candidate.id,
          kind: 'saved',
          label: candidate.label,
          binding: '',
          status: 'unavailable',
          detail:
            'This saved location could not be inspected. No original environment was started and no other location was substituted.',
          files: [],
          truncated: false,
          skippedEntries: 0,
        });
      }
    }
    const original = await deps.original(id, undefined, includeOriginal);
    current(id, originalBinding);
    if (original.source.sandboxId) sources.push(original.source);
    return {
      version: 1,
      podId: id,
      generation: pod.lifecycleGeneration,
      sources,
      limits: RECOVERY_FILE_LIMITS,
      excludes: RECOVERY_FILE_EXCLUDES,
    };
  }
  async function read(id: string, selection: RecoveryFileSelection): Promise<RecoveryFileContent> {
    const pod = deps.getPod(id);
    assertFindings(pod);
    const originalBinding = podBinding(pod);
    if (pod.lifecycleGeneration !== selection.generation || !safeRecoveryPath(selection.path))
      recoveryFileError();
    if (selection.sourceId === 'original') {
      const result = await deps.original(id, selection);
      current(id, originalBinding);
      return result.content ?? recoveryFileError();
    }
    const source = await saved(pod, selection.sourceId);
    if (source.binding !== selection.binding) recoveryFileError();
    const result = parseRecoveryContent(
      await runHostRecoveryReader(
        recoveryReaderArgs(
          'read',
          source.root,
          selection.path,
          selection.version,
          source.rootIdentity,
        ),
      ),
      selection.path,
    );
    current(id, originalBinding);
    const after = await saved(deps.getPod(id), selection.sourceId);
    if (after.binding !== source.binding) recoveryFileError();
    if (source.findings) {
      const bytes = await readArtifactSnapshotFile(
        source.root,
        path.join(
          process.env.DATA_DIR ?? path.join(process.cwd(), '.autopod-data'),
          'artifacts',
          pod.id,
        ),
        source.findings.generation,
        source.findings.cycle,
        selection.path,
        source.findings.snapshotHash,
      );
      if (createHash('sha256').update(bytes).digest('hex') !== result.sha256) recoveryFileError();
      current(id, originalBinding);
    }
    // saved() itself awaits filesystem inspection. Its captured pod can become
    // stale during that final await even when the root identity stays unchanged.
    current(id, originalBinding);
    return result;
  }
  return { inspect, read };
}
