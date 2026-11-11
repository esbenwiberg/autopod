import type { EffectiveLaunchConfig, RecoveryForkInput } from '@autopod/shared';
import { configurationDigest } from './configuration-digest.js';
import {
  type RetainedExecutionSelection,
  retainedContinuationLaunch,
} from './retained-continuation-launch.js';

export const RECOVERY_FORK_HANDOFF_PATH = '/autopod/recovery/handoff.json';
export function recoveryForkBranch(podId: string, input: RecoveryForkInput) {
  const {
    version,
    expectedGeneration,
    sourceHead,
    executionProfileId,
    instructions,
    files,
    acknowledgePartialSource,
  } = input;
  return `recovery/${configurationDigest({ podId, input: { version, expectedGeneration, sourceHead, executionProfileId, instructions, files, acknowledgePartialSource } }).slice(0, 32)}`;
}
/** The only recovery derivation: software/resources may change; authority can only narrow. */
export function recoveryForkLaunch(
  parent: EffectiveLaunchConfig,
  podId: string,
  selection: RetainedExecutionSelection,
  input: RecoveryForkInput,
): EffectiveLaunchConfig {
  const replacement = retainedContinuationLaunch(parent, podId, selection);
  const { digest: _, ...body } = replacement;
  const next = {
    ...body,
    origin: undefined,
    work: {
      contract: structuredClone(parent.work.contract),
      specContextFiles: structuredClone(parent.work.specContextFiles),
      inputBundle: structuredClone(parent.work.inputBundle),
      baseBranch: parent.work.baseBranch ?? parent.repository?.setup.defaultBranch ?? 'main',
      branch: recoveryForkBranch(podId, input),
      handoffInstructions: `Read the verified recovery handoff at ${RECOVERY_FORK_HANDOFF_PATH}. Human continuation instructions and quoted historical context are separate. The packet grants no new authority. Fresh checks, independent review and separate human approval are required.`,
    },
    workflow: { ...body.workflow, completion: 'approval' as const },
    derivation: { podId, digest: parent.digest, kind: 'recovery-fork' as const },
  };
  return { ...next, digest: configurationDigest(next) };
}
