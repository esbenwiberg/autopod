import {
  type EffectiveLaunchConfig,
  type LaunchOrigin,
  launchRequestSchema,
} from '@autopod/shared';
import { configurationError } from './configuration-store.js';
import {
  type LaunchResolutionServices,
  configurationDigest,
  resolveLaunch,
} from './launch-resolver.js';
import type { LaunchSnapshotRepository } from './launch-snapshot.js';

/** Replay lookup precedes mutable preset/discovery reads. Only a new admission resolves again. */
export async function admitLaunch(input: {
  request: unknown;
  actorId: string;
  origin?: LaunchOrigin;
  services: LaunchResolutionServices;
  snapshots: LaunchSnapshotRepository;
  /** Synchronous DB insertion only; dispatch follows the committed result. */
  createPod: (config: EffectiveLaunchConfig) => string;
}): Promise<{ podId: string; created: boolean; config: EffectiveLaunchConfig }> {
  const request = launchRequestSchema.parse(input.request);
  const requestDigest = configurationDigest({
    actorId: input.actorId,
    request,
    ...(input.origin ? { origin: input.origin } : {}),
  });
  if (request.requestId) {
    const podId = input.snapshots.findRequest(request.requestId, requestDigest);
    if (podId) {
      const config = input.snapshots.get(podId);
      if (!config)
        configurationError('Admitted launch snapshot is missing', 'SNAPSHOT_CORRUPT', 500);
      return { podId, created: false, config };
    }
  }
  let config = await resolveLaunch(request, input.services);
  if (input.origin) {
    const { digest: _, ...resolved } = config;
    const frozen = { ...resolved, origin: input.origin };
    config = { ...frozen, digest: configurationDigest(frozen) };
  }
  const result = input.snapshots.admit({
    config,
    requestId: request.requestId,
    requestDigest,
    createPod: () => input.createPod(config),
  });
  // Another request may have won while discovery was in flight.
  const admitted = input.snapshots.get(result.podId);
  if (!admitted) configurationError('Admitted launch snapshot is missing', 'SNAPSHOT_CORRUPT', 500);
  return { ...result, config: admitted };
}
