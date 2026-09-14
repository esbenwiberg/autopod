import {
  type CreatePodRequest,
  type EffectiveLaunchConfig,
  type IssueWatcherBinding,
  type Pod,
  launchWorkSchema,
} from '@autopod/shared';
import type {
  IssueWatcherLaunches,
  IssueWatcherSource,
} from '../issue-watcher/issue-watcher-service.js';
import type { WatcherBindingRepository } from '../issue-watcher/watcher-binding-repository.js';
import type { PodRepository } from '../pods/pod-repository.js';
import { configurationDigest } from './configuration-digest.js';
import { type ConfigurationStore, configurationError } from './configuration-store.js';
import { deriveLaunch } from './derive-launch.js';
import { type LaunchResolutionServices, resolveLaunch } from './launch-resolver.js';
import type { LaunchSnapshotRepository } from './launch-snapshot.js';

function work(request: CreatePodRequest) {
  return launchWorkSchema.parse({
    branch: request.branch,
    startBranch: request.startBranch,
    baseBranch: request.baseBranch,
    contract: request.contract,
    seriesId: request.seriesId,
    seriesName: request.seriesName,
    seriesDescription: request.seriesDescription,
    seriesDesign: request.seriesDesign,
    briefTitle: request.briefTitle,
    touches: request.touches,
    doesNotTouch: request.doesNotTouch,
    prMode: request.prMode,
  });
}
function seal(config: Omit<EffectiveLaunchConfig, 'digest'>): EffectiveLaunchConfig {
  return { ...config, digest: configurationDigest(config) };
}
export function createWatcherLaunches(options: {
  bindings: WatcherBindingRepository;
  store: ConfigurationStore;
  snapshots: LaunchSnapshotRepository;
  pods: PodRepository;
  resolution: LaunchResolutionServices;
  ready(): boolean;
  create(config: EffectiveLaunchConfig, ownerUserId: string): Pod;
}): IssueWatcherLaunches {
  function assertReady() {
    if (!options.ready())
      configurationError('Configuration cutover is incomplete', 'CONFIG_CUTOVER_REQUIRED', 409);
  }
  function source(binding: IssueWatcherBinding): IssueWatcherSource {
    const repository = options.store.get('repository', binding.payload.launch.repositoryId);
    if (!['github', 'ado'].includes(repository.payload.provider))
      configurationError(
        'Issue watching is unavailable for this repository provider',
        'WATCHER_PROVIDER_UNAVAILABLE',
        409,
      );
    return {
      name: binding.id,
      repoUrl: repository.payload.remote,
      prProvider: repository.payload.provider === 'github' ? 'github' : 'ado',
      issueWatcherEnabled: binding.payload.enabled,
      issueWatcherLabelPrefix: binding.payload.labelPrefix,
    };
  }
  function selection(binding: IssueWatcherBinding, label: string) {
    const prefix = binding.payload.labelPrefix;
    if (label === prefix || label === `${prefix}:artifact`) return binding.payload.launch;
    if (!label.startsWith(`${prefix}:`)) return null;
    const suffix = label.slice(prefix.length + 1);
    return Object.hasOwn(binding.payload.targets, suffix)
      ? (binding.payload.targets[suffix] ?? null)
      : null;
  }
  return {
    list() {
      if (!options.ready()) return [];
      return options.bindings
        .list()
        .filter((item) => item.payload.enabled)
        .map(source);
    },
    target(current, label) {
      const binding = options.bindings.get(current.name);
      if (!binding.payload.enabled || !selection(binding, label)) return null;
      return {
        profileName: `${binding.id}/${label}`,
        output: label === `${binding.payload.labelPrefix}:artifact` ? 'artifact' : 'planner',
      };
    },
    readSource(podId) {
      const config = options.snapshots.get(podId);
      if (config?.origin?.kind !== 'issue-watcher' || !config.repository)
        configurationError(
          'Frozen watcher source is unavailable',
          'WATCHER_SOURCE_UNAVAILABLE',
          409,
        );
      return {
        name: config.origin.watcherId,
        repoUrl: config.repository.config.remote,
        prProvider: config.repository.config.provider === 'github' ? 'github' : 'ado',
        issueWatcherEnabled: true,
        issueWatcherLabelPrefix: config.origin.labelPrefix,
      };
    },
    async create(request, current, candidate) {
      assertReady();
      const binding = options.bindings.get(current.name);
      const launch = selection(binding, candidate.triggerLabel);
      if (!binding.payload.enabled || !launch || source(binding).repoUrl !== current.repoUrl)
        configurationError('Watcher selection changed before admission', 'WATCHER_CHANGED', 409);
      const requestId = `watcher-${configurationDigest([binding.id, candidate.id, candidate.triggerLabel])}`;
      const requestDigest = configurationDigest({
        requestId,
        owner: binding.ownerUserId,
        task: request.task,
        work: work(request),
      });
      const replay = options.snapshots.findRequest(requestId, requestDigest);
      if (replay) return options.pods.getOrThrow(replay);
      const resolved = await resolveLaunch(
        { ...launch, task: request.task, work: work(request) },
        options.resolution,
      );
      if (resolved.workflow.agentMode !== 'auto' || resolved.intent !== 'task')
        configurationError(
          'Issue planning requires an automatic Task workflow',
          'WATCHER_WORKFLOW_UNAVAILABLE',
          409,
        );
      const { digest: _, ...body } = resolved;
      const origin = {
        kind: 'issue-watcher' as const,
        watcherId: binding.id,
        issueId: candidate.id,
        triggerLabel: candidate.triggerLabel,
        labelPrefix: binding.payload.labelPrefix,
      };
      const worker = seal({ ...body, origin });
      const artifact = candidate.triggerLabel === `${binding.payload.labelPrefix}:artifact`;
      const config = seal({
        ...body,
        origin,
        worker: artifact ? null : worker,
        workflow: {
          ...body.workflow,
          output: artifact ? 'artifact' : 'branch',
          validationPhases: [],
          completion: 'deliver',
          promotable: false,
        },
      });
      await options.resolution.assertCapabilities(config);
      assertReady();
      if (options.bindings.get(binding.id).revision !== binding.revision)
        configurationError('Watcher changed during launch resolution', 'WATCHER_CHANGED', 409);
      const admitted = options.snapshots.admit({
        config,
        requestId,
        requestDigest,
        createPod: () => options.create(config, binding.ownerUserId).id,
      });
      return options.pods.getOrThrow(admitted.podId);
    },
    async createWorker(request, parent) {
      assertReady();
      const frozen = options.snapshots.get(parent.id);
      const current = options.pods.getOrThrow(parent.id);
      if (
        !frozen?.worker ||
        frozen.origin?.kind !== 'issue-watcher' ||
        current.status !== 'complete'
      )
        configurationError(
          'Watcher planner has not completed with a frozen worker template',
          'WATCHER_SOURCE_UNAVAILABLE',
          409,
        );
      const requestId = `watcher-worker-${configurationDigest([parent.id, frozen.digest])}`;
      const requestDigest = configurationDigest({
        parent: parent.id,
        task: request.task,
        work: work(request),
        requiredSidecars: request.requireSidecars ?? [],
      });
      const replay = options.snapshots.findRequest(requestId, requestDigest);
      if (replay) return options.pods.getOrThrow(replay);
      const config = deriveLaunch(frozen, {
        source: { kind: 'watcher-worker', podId: parent.id, digest: frozen.digest },
        task: request.task,
        work: work(request),
      });
      if (
        request.requireSidecars?.some((id) => !Object.hasOwn(config.resolvedExecution.sidecars, id))
      )
        configurationError(
          'The watcher worker requires sidecars that were not selected in its launch; configure them before a new issue attempt',
          'WATCHER_SIDECAR_NOT_SELECTED',
          409,
        );
      await options.resolution.assertCapabilities(config);
      const after = options.pods.getOrThrow(parent.id);
      if (
        after.status !== 'complete' ||
        after.lifecycleGeneration !== current.lifecycleGeneration ||
        options.snapshots.get(parent.id)?.digest !== frozen.digest
      )
        configurationError(
          'Watcher planner changed during worker preflight',
          'WATCHER_CHANGED',
          409,
        );
      assertReady();
      const admitted = options.snapshots.admit({
        config,
        requestId,
        requestDigest,
        createPod: () => options.create(config, parent.userId).id,
      });
      return options.pods.getOrThrow(admitted.podId);
    },
  };
}
