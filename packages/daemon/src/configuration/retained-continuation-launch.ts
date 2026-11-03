import type { EffectiveLaunchConfig } from '@autopod/shared';
import { environmentImageKey } from '../images/environment-image-key.js';
import { configurationDigest } from './configuration-digest.js';
import { configurationError } from './configuration-store.js';

/** Server-resolved software/resources only. No repository, credential, network or workflow override. */
export interface RetainedExecutionSelection {
  profileId: string;
  parentDigest: string;
  environment: EffectiveLaunchConfig['environment'];
  resolvedEnvironment: EffectiveLaunchConfig['resolvedEnvironment'];
  target: EffectiveLaunchConfig['execution']['target'];
  main: EffectiveLaunchConfig['execution']['main'];
  resolvedExecution: EffectiveLaunchConfig['resolvedExecution'];
  digest: string;
  configurationHash?: string;
}
export function retainedContinuationLaunch(
  parent: EffectiveLaunchConfig,
  podId: string,
  selection: RetainedExecutionSelection,
): EffectiveLaunchConfig {
  if (
    parent.digest !== selection.parentDigest ||
    parent.intent !== 'task' ||
    parent.workflow.agentMode !== 'auto' ||
    parent.requiredSidecarIds.length ||
    Object.keys(selection.resolvedExecution.sidecars).length ||
    selection.resolvedExecution.target !== selection.target ||
    configurationDigest(selection.resolvedExecution.main) !== configurationDigest(selection.main)
  )
    configurationError(
      'Continuation execution must preserve the original ordinary task authority',
      'CONTINUATION_EXECUTION_INVALID',
      409,
    );
  if (
    environmentImageKey({
      environment: selection.environment,
      ...selection.resolvedEnvironment,
    }) !== selection.resolvedEnvironment.imageKey
  )
    configurationError(
      'Continuation image identity is inconsistent',
      'CONTINUATION_EXECUTION_INVALID',
      409,
    );
  for (const pack of parent.toolPacks)
    for (const capability of pack.requiredCapabilities) {
      if (!selection.environment.capabilities.includes(capability))
        configurationError(
          'Replacement environment lacks an original required capability',
          'CONTINUATION_EXECUTION_INVALID',
          409,
        );
    }
  const { digest: _digest, ...body } = structuredClone(parent);
  const next = {
    ...body,
    environment: structuredClone(selection.environment),
    resolvedEnvironment: structuredClone(selection.resolvedEnvironment),
    execution: {
      ...body.execution,
      target: selection.target,
      main: structuredClone(selection.main),
    },
    resolvedExecution: structuredClone(selection.resolvedExecution),
    derivation: { podId, digest: parent.digest, kind: 'follow-up' as const },
    provenance: {
      ...body.provenance,
      environment: { source: 'override' as const },
      execution: { source: 'override' as const },
    },
  };
  const config = { ...next, digest: configurationDigest(next) };
  if (selection.digest && config.digest !== selection.digest)
    configurationError(
      'Replacement execution preview changed',
      'CONTINUATION_EXECUTION_INVALID',
      409,
    );
  return config;
}
