import type { EffectiveLaunchConfig } from '@autopod/shared';
import { environmentImageKey } from '../images/environment-image-key.js';
import { shellQuote } from '../util/shell-quote.js';
import { configurationDigest } from './configuration-digest.js';
import { configurationError } from './configuration-store.js';
import { assertLaunchRequirements } from './launch-requirement-preflight.js';

/** Server-resolved software/resources, plus an explicit public build-environment scope; no credential/network/workflow override. */
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
  /** Explicit human selection: retain these public frozen values in the build phase only. */
  buildOnlyEnvironmentKeys?: string[];
}

function scopeBuildEnvironment(
  repository: EffectiveLaunchConfig['repository'],
  keys: string[] | undefined,
): EffectiveLaunchConfig['repository'] {
  if (keys === undefined) return repository;
  if (
    !Array.isArray(keys) ||
    !keys.length ||
    keys.length > 16 ||
    new Set(keys).size !== keys.length ||
    keys.some((key) => typeof key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)) ||
    !repository?.setup.buildCommand?.trim()
  )
    configurationError(
      'Explicit build-only environment keys and an existing build command are required',
      'CONTINUATION_EXECUTION_INVALID',
      409,
    );
  const setup = repository.setup;
  const assignments = [...keys].sort().map((key) => {
    const binding = Object.hasOwn(setup.buildEnv, key) ? setup.buildEnv[key] : undefined;
    if (
      !binding ||
      !('value' in binding) ||
      typeof binding.value !== 'string' ||
      Object.keys(binding).length !== 1 ||
      binding.value.includes('\0')
    )
      configurationError(
        'Build-only selection requires an existing public literal value; secret references cannot be scoped',
        'CONTINUATION_EXECUTION_INVALID',
        409,
      );
    delete setup.buildEnv[key];
    return shellQuote(`${key}=${binding.value}`);
  });
  const command = `env ${assignments.join(' ')} /bin/sh -c ${shellQuote(setup.buildCommand!)}`;
  if (command.length > 50_000 || command.includes('\0'))
    configurationError(
      'Scoped build command exceeds the supported command bound',
      'CONTINUATION_EXECUTION_INVALID',
      409,
    );
  setup.buildCommand = command;
  return repository;
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
    repository: scopeBuildEnvironment(body.repository, selection.buildOnlyEnvironmentKeys),
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
  assertLaunchRequirements(config);
  if (selection.digest && config.digest !== selection.digest)
    configurationError(
      'Replacement execution preview changed',
      'CONTINUATION_EXECUTION_INVALID',
      409,
    );
  return config;
}
