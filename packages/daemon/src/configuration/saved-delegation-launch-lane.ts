import type { EffectiveLaunchConfig } from '@autopod/shared';
import type Database from 'better-sqlite3';
import { combinedPolicyDigest } from '../orchestration/combined-attestation.js';
import {
  admitSavedDelegationLaunch,
  savedDelegationGatePolicy,
} from '../orchestration/saved-delegation-admission.js';
import { prepareSavedDelegationLaunch } from '../orchestration/saved-delegation-launch.js';
import {
  createSavedDelegationPolicyStore,
  type DelegationPrincipal,
} from '../orchestration/saved-delegation-policy.js';
import { configurationError } from './configuration-store.js';
import { type LaunchResolutionServices, refuseUnboundSavedDelegation } from './launch-resolver.js';

/** Supply only from a daemon composition that owns saved parent checkout, ingress
 * and restart recovery. No route, policy, or caller can turn this on. */
export type SavedDelegationLaunchHost = Pick<
  Parameters<typeof admitSavedDelegationLaunch>[0],
  'scratch' | 'readVerifiedPins' | 'readSeedBundle' | 'verifyPublishedSeed'
> & { available(): boolean };

export function createSavedDelegationLaunchLane(
  db: Database.Database,
  launch: LaunchResolutionServices,
  host: SavedDelegationLaunchHost,
) {
  const policies = createSavedDelegationPolicyStore(db);
  const ready = () => {
    if (!host.available()) refuseUnboundSavedDelegation();
  };
  return {
    available: () => host.available(),
    list(principal: DelegationPrincipal, repositoryId: string) {
      ready();
      return policies.listCurrent(principal, repositoryId);
    },
    async preview(request: unknown, principal: DelegationPrincipal) {
      ready();
      const { config, plan } = await prepareSavedDelegationLaunch({
        request,
        principal,
        policies,
        launch,
        readVerifiedPins: host.readVerifiedPins,
      });
      ready();
      const { commit, tree, ref } = plan.pins.source;
      return {
        ...config,
        // This projection is review evidence, not part of the ordinary config snapshot.
        delegationPreview: {
          digest: plan.digest,
          requestId: plan.requestId,
          runId: plan.runId,
          evaluatorBasePolicyDigest: savedDelegationGatePolicy(plan).basePolicyDigest,
          evaluatorPolicyDigest: combinedPolicyDigest(savedDelegationGatePolicy(plan)),
          policyId: plan.policyId,
          revision: plan.revision,
          name: plan.policy.name,
          source: { commit, tree, ref },
          workers: plan.policy.workers.map(
            ({ role, files, accountId, modelRequests, observedTokenStop, wallSeconds }) => ({
              role,
              files,
              accountId,
              modelRequests,
              observedTokenStop,
              wallSeconds,
            }),
          ),
          maxConcurrentWorkers: plan.policy.maxConcurrentWorkers,
          workerModelRequests: plan.workerModelRequests,
          reviewer: {
            accountId: plan.policy.reviewer.accountId,
            tokenBudget: plan.policy.reviewer.tokenBudget,
          },
        },
      };
    },
    async admit(
      request: unknown,
      principal: DelegationPrincipal | undefined,
      actorId: string,
      insertPod: (config: EffectiveLaunchConfig) => string,
    ) {
      if (!principal || principal.oid !== actorId)
        configurationError(
          'Saved delegation requires the authenticated Task owner',
          'DELEGATION_OWNER_REQUIRED',
          403,
        );
      return admitSavedDelegationLaunch({
        db,
        request,
        principal,
        policies,
        launch,
        scratch: host.scratch,
        // Admission checks retained exact requests before invoking these fresh-launch
        // ports. A dependency outage must not hide an already committed receipt.
        readVerifiedPins: async (...args) => {
          ready();
          const pins = await host.readVerifiedPins(...args);
          ready();
          return pins;
        },
        readSeedBundle: async (plan) => {
          ready();
          const bundle = await host.readSeedBundle(plan);
          ready();
          return bundle;
        },
        verifyPublishedSeed: host.verifyPublishedSeed,
        insertPod: (config) => {
          ready();
          return insertPod(config);
        },
      });
    },
  };
}
