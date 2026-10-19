import type { EffectiveLaunchConfig, InjectedMcpServer, Pod } from '@autopod/shared';
import { AutopodError } from '@autopod/shared';
import type {
  AdmissionMcpCalls,
  AdmissionQueriesCaptured,
  AdmissionQueriesLiveDependencies,
  AdmissionSessionFilters,
} from './admission-contracts.js';
import { mergeMcpServers } from './injection-merger.js';
export function createAdmissionQueries(
  deps: AdmissionQueriesLiveDependencies,
  captured: AdmissionQueriesCaptured,
) {
  const { podRepo, executionCredentialsFor, executionForPod, injectionsForPod, validationRepo } =
    captured;
  function getLaunchConfiguration(podId: string): EffectiveLaunchConfig | null {
    return deps.launchConfiguration?.read(podId) ?? null;
  }

  function getSession(podId: string): Pod {
    return podRepo.getOrThrow(podId);
  }

  async function getDeploymentConfiguration(podId: string) {
    const pod = podRepo.getOrThrow(podId);
    const launch = deps.launchConfiguration?.read(podId);
    if (launch) {
      await deps.launchConfiguration?.assertCurrentCapabilities(launch);
      const deployment =
        (await executionCredentialsFor(launch)?.deployment(launch)) ??
        executionForPod(pod).deployment;
      await deps.launchConfiguration?.assertCurrentCapabilities(launch);
      return deployment;
    }
    return executionForPod(pod).deployment;
  }

  async function getInjectedMcpServer(this: AdmissionMcpCalls, podId: string, name: string) {
    const pod = podRepo.getOrThrow(podId);
    const launch = deps.launchConfiguration?.read(podId);
    if (launch) {
      if (pod.status !== 'running')
        throw new AutopodError('Pod is not running', 'POD_NOT_RUNNING', 409);
      await deps.launchConfiguration?.assertCurrentCapabilities(launch);
      const credentials = executionCredentialsFor(launch);
      if (credentials) {
        const server = await credentials.httpServer(launch, name);
        await deps.launchConfiguration?.assertCurrentCapabilities(launch);
        return server;
      }
    }
    return this.getInjectedMcpServers(podId).find((server) => server.name === name);
  }

  function getInjectedMcpServers(podId: string): InjectedMcpServer[] {
    const pod = podRepo.getOrThrow(podId);
    const profile = executionForPod(pod);
    return mergeMcpServers(injectionsForPod(pod).mcpServers, profile.mcpServers);
  }

  function listSessions(filters?: AdmissionSessionFilters) {
    return podRepo.list(filters);
  }

  function getSessionStats(filters?: { profileName?: string }) {
    return podRepo.getStats(filters);
  }

  function getSeriesPods(seriesId: string): Pod[] {
    return podRepo.getPodsBySeries(seriesId);
  }

  function getValidationHistory(podId: string) {
    // Verify pod exists
    podRepo.getOrThrow(podId);
    return validationRepo?.getForSession(podId) ?? [];
  }
  return {
    getLaunchConfiguration,
    getSession,
    getDeploymentConfiguration,
    getInjectedMcpServer,
    getInjectedMcpServers,
    listSessions,
    getSessionStats,
    getSeriesPods,
    getValidationHistory,
  };
}
