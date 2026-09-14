import { type EnvironmentPreset, environmentPresetSchema } from '@autopod/shared';
import { configurationDigest } from '../configuration/configuration-digest.js';

export interface EnvironmentBuildInputs {
  environment: EnvironmentPreset;
  pinnedBase: string;
  platform: 'linux/amd64' | 'linux/arm64';
  agentToolingDigest: string;
  toolInstallCommands: string[];
}
export function environmentImageKey(input: EnvironmentBuildInputs): string {
  const environment = environmentPresetSchema.parse(input.environment);
  if (!/^(?:[a-zA-Z0-9][a-zA-Z0-9._:/-]*@)?sha256:[a-f0-9]{64}$/.test(input.pinnedBase)) {
    throw new Error('Environment base must be resolved to an immutable image digest');
  }
  if (!/^[a-f0-9]{64}$/.test(input.agentToolingDigest))
    throw new Error('Agent tooling digest is required');
  return configurationDigest({
    generatorVersion: 1,
    pinnedBase: input.pinnedBase,
    platform: input.platform,
    agentToolingDigest: input.agentToolingDigest,
    template: environment.template,
    tools: environment.tools,
    prepareCommands: environment.prepareCommands,
    capabilities: [...environment.capabilities].sort(),
    toolInstallCommands: input.toolInstallCommands,
  });
}
