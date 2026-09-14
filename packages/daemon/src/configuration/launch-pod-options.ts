import type { EffectiveLaunchConfig, PodOptions } from '@autopod/shared';

/** Complete execution options; no inheritance or defaults are resolved after admission. */
export function launchPodOptions(config: EffectiveLaunchConfig): PodOptions {
  const flow = config.workflow;
  return {
    agentMode: flow.agentMode,
    output: flow.output,
    validate: flow.validationPhases.length > 0,
    validationSuite: flow.validationPhases.length > 0 ? 'custom' : 'off',
    advisoryBrowserQaEnabled: flow.advisoryBrowserQaEnabled,
    promotable: flow.promotable,
  };
}
