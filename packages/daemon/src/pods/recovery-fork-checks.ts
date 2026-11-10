import type { Pod, ValidationResult } from '@autopod/shared';
import { configurationDigest } from '../configuration/configuration-digest.js';
import type { ContainerManager } from '../interfaces/container-manager.js';
import { QUALIFICATION_SOURCE_PROBE } from './environment-qualification.js';
import { recoveryForkError } from './recovery-fork-rejection.js';

/** Advisory completion and collected screenshot references do not change blocking checks. */
export function recoveryCheckHash(result: ValidationResult | null) {
  if (!result) return configurationDigest(null);
  const value = structuredClone(result);
  delete value.advisoryBrowserQa;
  for (const page of value.smoke.pages) delete page.screenshot;
  for (const fact of value.factValidation?.results ?? [])
    for (const attachment of fact.attachments ?? []) delete attachment.screenshot;
  return configurationDigest(value);
}
export interface RecoveryCheckedSource {
  head: string;
  tree: string;
  generation: number;
  containerId: string;
  worktreePath: string;
  launchDigest: string;
}
export async function observeRecoveryCheckSource(
  cm: ContainerManager,
  pod: Pod,
  prepared?: { files: Array<{ path: string; sha256: string; size: number }>; packetHash: string },
) {
  if (!pod.containerId || !pod.worktreePath || !pod.startCommitSha || !pod.launchConfigDigest)
    recoveryForkError('Recovery checks require exact candidate source and launch');
  const result = await cm.execInContainer(
    pod.containerId!,
    [
      '/usr/local/bin/node',
      '-e',
      QUALIFICATION_SOURCE_PROBE,
      pod.startCommitSha!,
      ...(prepared
        ? [
            JSON.stringify({
              files: prepared.files,
              packetHash: prepared.packetHash,
              allowCommittedSupplementChanges: true,
            }),
          ]
        : []),
    ],
    { cwd: '/workspace', timeout: 10_000, maxOutputBytes: 65536, user: 'autopod' },
  );
  const source = result.exitCode === 0 ? JSON.parse(result.stdout) : null;
  if (
    source?.clean !== true ||
    source.baseAncestor !== true ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(source.head ?? '') ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(source.tree ?? '')
  )
    recoveryForkError('Recovery checks require verified clean actual source');
  return {
    head: source.head,
    tree: source.tree,
    generation: pod.lifecycleGeneration,
    containerId: pod.containerId!,
    worktreePath: pod.worktreePath!,
    launchDigest: pod.launchConfigDigest!,
  } as RecoveryCheckedSource;
}
