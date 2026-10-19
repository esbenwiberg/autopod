import type { EffectiveLaunchConfig, Pod } from '@autopod/shared';
import { AutopodError } from '@autopod/shared';
import type { LaunchExecutionCredentials } from '../configuration/execution-credentials.js';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import type {
  AdmissionExecutionCaptured,
  AdmissionExecutionLiveDependencies,
} from './admission-contracts.js';
export function createAdmissionExecutionContext(
  deps: AdmissionExecutionLiveDependencies,
  captured: AdmissionExecutionCaptured,
) {
  const { profileStore, daemonConfig } = captured;
  function executionForPod(pod: Pod): PodExecutionSettings {
    const resolved = deps.launchConfiguration?.read(pod.id);
    if (resolved && deps.launchConfiguration)
      return deps.launchConfiguration.executionSettings(resolved);
    if (pod.launchConfigDigest)
      throw new AutopodError(
        'Immutable launch configuration is unavailable',
        'SNAPSHOT_CORRUPT',
        500,
      );
    return profileStore.get(pod.profileName);
  }

  function executionCredentialsFor(
    config: EffectiveLaunchConfig,
  ): LaunchExecutionCredentials | undefined {
    const credentials = deps.launchConfiguration?.credentials;
    if (!credentials && Object.keys(config.credentialReferences).length)
      throw new AutopodError(
        'Scoped execution credentials are unavailable',
        'SECRET_EXECUTION_ADAPTER_REQUIRED',
        503,
      );
    return credentials;
  }

  function injectionsForPod(pod: Pod): typeof daemonConfig {
    return pod.launchConfigDigest
      ? { mcpServers: [], claudeMdSections: [], skills: [] }
      : daemonConfig;
  }

  async function resolveGitCredential(profile: PodExecutionSettings): Promise<string | undefined> {
    if (profile.prProvider === 'ado') return deps.azureDevOpsAuth?.getToken();
    if (!profile.repoUrl) {
      throw new Error(`GitHub profile "${profile.name}" does not have a repository URL`);
    }
    let hostname: string;
    try {
      hostname = new URL(profile.repoUrl).hostname.toLowerCase();
    } catch {
      throw new Error(`GitHub profile "${profile.name}" has an invalid repository URL`);
    }
    if (hostname !== 'github.com') {
      throw new Error(
        `GitHub profile "${profile.name}" must use an exact github.com repository host`,
      );
    }
    return (await deps.githubAuth?.resolveCredential())?.token;
  }
  return { executionForPod, executionCredentialsFor, injectionsForPod, resolveGitCredential };
}
