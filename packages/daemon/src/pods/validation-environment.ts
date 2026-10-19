import type { EffectiveLaunchConfig, Pod } from '@autopod/shared';
import type { LaunchExecutionCredentials } from '../configuration/execution-credentials.js';
import type { ContainerManager } from '../interfaces/container-manager.js';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import { buildValidationExecEnv } from './registry-injector.js';

interface ValidationEnvironmentDependencies {
  launchConfiguration?: {
    read(podId: string): EffectiveLaunchConfig | null;
    assertCurrentCapabilities(config: EffectiveLaunchConfig): Promise<void>;
  };
}

interface ValidationEnvironmentCaptured {
  executionCredentialsFor(config: EffectiveLaunchConfig): LaunchExecutionCredentials | undefined;
  containerManagerFactory: { get(target: Pod['executionTarget']): ContainerManager };
}

export function createValidationEnvironment(
  deps: ValidationEnvironmentDependencies,
  captured: ValidationEnvironmentCaptured,
): {
  validationEnvironmentForPod(
    pod: Pod,
    profile: PodExecutionSettings,
  ): Promise<Record<string, string> | undefined>;
} {
  const { executionCredentialsFor, containerManagerFactory } = captured;

  async function validationEnvironmentForPod(
    pod: Pod,
    profile: PodExecutionSettings,
  ): Promise<Record<string, string> | undefined> {
    const launch = deps.launchConfiguration?.read(pod.id);
    if (!launch)
      return buildValidationExecEnv(
        profile.privateRegistries,
        profile.registryPat ?? null,
        profile.buildEnv,
      );
    const credentials = executionCredentialsFor(launch);
    await deps.launchConfiguration?.assertCurrentCapabilities(launch);
    if (!credentials)
      return buildValidationExecEnv(profile.privateRegistries, null, profile.buildEnv);
    const [env, registry] = await Promise.all([
      credentials.buildEnvironment(launch),
      credentials.registries(launch),
    ]);
    // Refresh every registry file before validation or resume, including npm token rotation.
    if (pod.containerId) {
      const cm = containerManagerFactory.get(pod.executionTarget);
      for (const file of [
        ...registry.files,
        ...(registry.nugetSecret ? [registry.nugetSecret] : []),
      ]) {
        await cm.writeFile(pod.containerId, file.path, file.content, { mode: 0o600 });
      }
    }
    await deps.launchConfiguration?.assertCurrentCapabilities(launch);
    return {
      ...buildValidationExecEnv([], null, env),
      ...(registry.nugetSecret
        ? { [registry.nugetSecret.envFileKey]: registry.nugetSecret.path }
        : {}),
    };
  }

  return { validationEnvironmentForPod };
}
