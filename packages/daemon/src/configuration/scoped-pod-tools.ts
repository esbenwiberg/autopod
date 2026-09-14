import type { ScopedPodTools } from '@autopod/escalation-mcp';
import type { EffectiveLaunchConfig, PimSelection, ResolvedGitHubRule } from '@autopod/shared';
import type Database from 'better-sqlite3';
import type { ActionAuditRepository } from '../actions/audit-repository.js';
import type { DeploymentService } from '../actions/deployment-service.js';
import { type ServiceReadTransport, readScopedService } from '../actions/service-read-broker.js';
import type { PimRouteDependencies } from '../api/routes/pim.js';
import { GitHubDiscovery } from '../github/discovery.js';
import {
  type GitHubMutationClient,
  createGitHubMutationBroker,
} from '../github/mutation-broker.js';
import { createGitHubOperationLedger } from '../github/operation-ledger.js';
import { type GitHubDownloadClient, createGitHubReadBroker } from '../github/read-broker.js';
import { pimAssignmentKey } from '../pim/activation-repository.js';
import type { createPimActivationService } from '../pim/activation-service.js';
import type { PimEligibilityService } from '../pim/eligibility-service.js';
import type { PodRepository } from '../pods/pod-repository.js';
import { configurationError } from './configuration-store.js';
import type { LaunchSnapshotRepository } from './launch-snapshot.js';

export interface ScopedToolsDependencies {
  deployments?: DeploymentService;
  db: Database.Database;
  snapshots: LaunchSnapshotRepository;
  pods: Pick<PodRepository, 'getOrThrow'>;
  github: GitHubMutationClient & GitHubDownloadClient;
  audit: ActionAuditRepository;
  serviceReads?: {
    transport: ServiceReadTransport;
    assertAllowed(config: EffectiveLaunchConfig): void;
  };
  /** Operator-owned revocations/ceilings, not the current revision of a reusable preset. */
  githubCeiling(config: EffectiveLaunchConfig): Promise<ResolvedGitHubRule[]>;
  assertPimAllowed(selection: PimSelection): void;
  pim?: {
    eligibility: PimEligibilityService;
    activation: ReturnType<typeof createPimActivationService>;
  };
}
export function createScopedPodTools(deps: ScopedToolsDependencies) {
  function snapshot(podId: string, expected?: string): EffectiveLaunchConfig {
    const pod = deps.pods.getOrThrow(podId);
    if (pod.status !== 'running')
      configurationError('Scoped agent operations require a running pod', 'POD_NOT_RUNNING', 409);
    const config = deps.snapshots.get(podId);
    if (
      !config ||
      pod.launchConfigDigest !== config.digest ||
      (expected && config.digest !== expected)
    )
      configurationError(
        'Frozen pod authority is unavailable or changed',
        'CONFIG_SNAPSHOT_UNAVAILABLE',
        403,
      );
    return config;
  }
  async function context(podId: string) {
    const config = snapshot(podId);
    const ceiling = await deps.githubCeiling(config);
    snapshot(podId, config.digest);
    // Managed work uses a different repository/protocol and cannot enter this regular-pod context.
    return {
      snapshotDigest: config.digest,
      managed: false,
      policy: { snapshot: config.githubAccess, currentCeiling: ceiling },
    };
  }
  const discovery = new GitHubDiscovery(deps.github);
  const ledger = createGitHubOperationLedger(deps.db);
  const mutation = createGitHubMutationBroker({ client: deps.github, discovery, ledger, context });
  const read = createGitHubReadBroker({
    client: deps.github,
    discovery,
    context,
    audit(input) {
      deps.audit.insert({
        podId: input.podId,
        actionName: 'github_read',
        params: {
          resource: input.resource,
          repositoryId: input.repositoryId,
          snapshotDigest: input.snapshotDigest,
        },
        responseSummary: `Returned ${input.bytes} bytes`,
        piiDetected: false,
        quarantineScore: 0,
      });
    },
  });
  function pimScope(podId: string, userId?: string) {
    const config = snapshot(podId);
    if (userId && deps.pods.getOrThrow(podId).userId !== userId)
      configurationError('PIM pod ownership differs from the caller', 'POD_ACCESS_DENIED', 403);
    return {
      selections: config.pim,
      assertAuthorized(selection: PimSelection) {
        const current = snapshot(podId, config.digest);
        if (!current.pim.some((item) => pimAssignmentKey(item) === pimAssignmentKey(selection)))
          configurationError(
            'PIM assignment is not selected for this pod',
            'PIM_NOT_SELECTED',
            403,
          );
        deps.assertPimAllowed(selection);
      },
    };
  }
  const pimRoutes: PimRouteDependencies | undefined = deps.pim
    ? { ...deps.pim, scope: pimScope }
    : undefined;
  return {
    read,
    mutation,
    pimRoutes,
    recoverInterrupted: () => ledger.recoverInterrupted(),
    get(podId: string): ScopedPodTools | undefined {
      const pod = deps.pods.getOrThrow(podId);
      if (!pod.launchConfigDigest) return undefined;
      // Listing tools need not activate the pod or contact GitHub/Azure.
      const config = deps.snapshots.get(podId);
      if (!config)
        configurationError('Frozen pod authority is missing', 'CONFIG_SNAPSHOT_UNAVAILABLE', 503);
      const deployments = deps.deployments;
      const operations = new Set(config.githubAccess.flatMap((item) => item.rule.operations));
      return {
        ...(config.repository?.setup.integrations.deployment?.enabled && deployments
          ? {
              deploymentPrepare: (request: unknown) => {
                snapshot(podId, config.digest);
                return deployments.prepare(podId, request);
              },
              deploymentStatus: async (runId: string) => {
                snapshot(podId, config.digest);
                return deployments.status(podId, runId);
              },
            }
          : {}),
        ...(config.repository?.setup.integrations.serviceAccess.length && deps.serviceReads
          ? {
              serviceRules: async () => {
                const current = snapshot(podId, config.digest);
                deps.serviceReads?.assertAllowed(current);
                return structuredClone(current.repository?.setup.integrations.serviceAccess ?? []);
              },
              serviceRead: async (request) => {
                const service = deps.serviceReads;
                if (!service)
                  configurationError(
                    'Scoped service reads are unavailable',
                    'SERVICE_READ_UNAVAILABLE',
                    503,
                  );
                const assertAuthorized = () =>
                  service.assertAllowed(snapshot(podId, config.digest));
                const result = await readScopedService({
                  raw: request,
                  rules: config.repository?.setup.integrations.serviceAccess ?? [],
                  transport: service.transport,
                  assertAuthorized,
                });
                deps.audit.insert({
                  podId,
                  actionName: 'service_read',
                  params: {
                    service: request.service,
                    ruleId: request.ruleId,
                    snapshotDigest: config.digest,
                  },
                  responseSummary: 'Scoped service read completed',
                  piiDetected: false,
                  quarantineScore: 0,
                });
                return result;
              },
            }
          : {}),
        ...([...operations].some((item) => item.endsWith('.read'))
          ? { githubRead: (request) => read.read(podId, request) }
          : {}),
        ...([...operations].some((item) => !item.endsWith('.read'))
          ? { githubMutate: (request) => mutation.execute(podId, request) }
          : {}),
        ...(config.pim.length
          ? {
              pimSelections: async () => structuredClone(snapshot(podId).pim),
              pimActivate: async (type, eligibilityId, requestId) => {
                const scope = pimScope(podId);
                const matches = scope.selections.filter(
                  (item) => item.type === type && item.eligibilityId === eligibilityId,
                );
                const selected = matches[0];
                if (!selected || matches.length !== 1)
                  configurationError(
                    'Exact PIM assignment is not selected',
                    'PIM_NOT_SELECTED',
                    403,
                  );
                if (!deps.pim)
                  configurationError(
                    'PIM user account is not configured',
                    'PIM_ACCOUNT_UNAVAILABLE',
                    503,
                  );
                return deps.pim.activation.request(podId, requestId, selected, () =>
                  scope.assertAuthorized(selected),
                );
              },
            }
          : {}),
      };
    },
  };
}
