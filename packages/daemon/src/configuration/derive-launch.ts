import {
  type EffectiveLaunchConfig,
  type LaunchRequest,
  launchRequestSchema,
} from '@autopod/shared';
import { configurationDigest } from './configuration-digest.js';
import { configurationError } from './configuration-store.js';

export interface DerivedLaunchInput {
  source: NonNullable<EffectiveLaunchConfig['derivation']>;
  task: string;
  work?: LaunchRequest['work'];
  /** Explicit user-selected handoff output; all other workflow authority remains frozen. */
  output?: EffectiveLaunchConfig['workflow']['output'];
}
/** Daemon-owned continuation of admitted authority, independent of later preset edits/archive. */
export function deriveLaunch(
  parent: EffectiveLaunchConfig,
  input: DerivedLaunchInput,
): EffectiveLaunchConfig {
  if (parent.digest !== input.source.digest)
    configurationError('Derived launch source changed', 'CONFIG_SOURCE_CHANGED', 409);
  if (input.source.kind === 'goal-rework' && parent.intent !== 'goal')
    configurationError('Goal rework requires a native Goal parent', 'CONFIG_SOURCE_CHANGED', 409);
  if (
    ['worker', 'spawn-worker'].includes(input.source.kind) &&
    parent.workflow.agentMode !== 'interactive'
  )
    configurationError(
      'Worker handoff requires an interactive launch',
      'CONFIG_SOURCE_CHANGED',
      409,
    );
  if (input.output !== undefined && input.source.kind !== 'worker')
    configurationError('Only worker handoff can select an output', 'CONFIG_DERIVATION_INVALID');
  if (
    input.source.kind === 'watcher-worker' &&
    (parent.origin?.kind !== 'issue-watcher' || !parent.worker)
  )
    configurationError(
      'Watcher worker requires its frozen planner template',
      'CONFIG_SOURCE_CHANGED',
      409,
    );
  const base =
    input.source.kind === 'worker' ||
    input.source.kind === 'spawn-worker' ||
    input.source.kind === 'watcher-worker'
      ? (parent.worker ?? parent)
      : parent;
  const intent = ['fix', 'manual-fix', 'goal-rework'].includes(input.source.kind)
    ? 'task'
    : base.intent;
  const inheritedWork =
    input.source.kind === 'follow-up'
      ? { specContextFiles: base.work.specContextFiles }
      : input.source.kind === 'manual-fix' || input.source.kind === 'spawn-worker'
        ? {
            contract: base.work.contract,
            handoffInstructions: base.work.handoffInstructions,
            specContextFiles: base.work.specContextFiles,
          }
        : base.work;
  const request = launchRequestSchema.parse({
    ...(base.repository ? { repositoryId: base.repository.id } : { emptyWorkspace: true }),
    profileId: base.profileId,
    task: input.task,
    intent,
    work: { ...inheritedWork, ...input.work },
  });
  const { digest: _, ...body } = structuredClone(base);
  const derived = {
    ...body,
    task: request.task,
    work: request.work ?? {},
    intent,
    ...(input.source.kind === 'manual-fix'
      ? {
          worker: null,
          workflow: {
            ...body.workflow,
            agentMode: 'interactive' as const,
            promotable: false,
            output: 'branch' as const,
            completion: 'approval' as const,
            validationPhases: [],
            advisoryBrowserQaEnabled: false,
          },
        }
      : {}),
    ...(input.source.kind === 'worker' || input.source.kind === 'spawn-worker'
      ? {
          workflow: {
            ...body.workflow,
            agentMode: 'auto' as const,
            promotable: false,
            output: input.output ?? body.workflow.output,
          },
        }
      : {}),
    derivation: structuredClone(input.source),
    provenance: {
      ...body.provenance,
      task: { source: 'override' as const },
      work: { source: 'override' as const },
      intent: { source: 'override' as const },
    },
  };
  return { ...derived, digest: configurationDigest(derived) };
}
