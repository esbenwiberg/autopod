import {
  type EffectiveLaunchConfig,
  type LaunchOrigin,
  launchRequestSchema,
} from '@autopod/shared';
import { configurationError } from './configuration-store.js';
import {
  configurationDigest,
  type LaunchResolutionServices,
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
  /** Optional trusted route authorization; returned DB-only binding runs in the snapshot transaction. */
  authorize?: (
    requestId: string | undefined,
  ) => ((podId: string, config: EffectiveLaunchConfig) => void) | undefined;
  /** Optional read-only async preflight; its returned insertion rechecks observations synchronously. */
  preparePod?: (config: EffectiveLaunchConfig) => Promise<() => string>;
}): Promise<{ podId: string; created: boolean; config: EffectiveLaunchConfig }> {
  const request = launchRequestSchema.parse(input.request);
  const bind = input.authorize?.(request.requestId);
  if (request.requireParentEnrollment && !bind) {
    configurationError(
      'No signed parent enrollment matches this launch request',
      'PARENT_ENROLLMENT_REQUIRED',
      409,
    );
  }
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
  let config = await resolveLaunch(request, input.services, input.actorId);
  if (input.origin) {
    const { digest: _, ...resolved } = config;
    const frozen = { ...resolved, origin: input.origin };
    config = { ...frozen, digest: configurationDigest(frozen) };
  }
  const createPod = input.preparePod
    ? await input.preparePod(config)
    : () => input.createPod(config);
  const result = input.snapshots.admit({
    config,
    requestId: request.requestId,
    requestDigest,
    createPod: () => {
      const podId = createPod();
      bind?.(podId, config);
      return podId;
    },
  });
  // Another request may have won while discovery was in flight.
  const admitted = input.snapshots.get(result.podId);
  if (!admitted) configurationError('Admitted launch snapshot is missing', 'SNAPSHOT_CORRUPT', 500);
  return { ...result, config: admitted };
}
