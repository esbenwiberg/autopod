import { type EffectiveLaunchConfig, type Pod, outputModeFromPodOptions } from '@autopod/shared';
import { afterEach, vi } from 'vitest';
import { configurationDigest } from '../configuration/configuration-digest.js';
import { deriveLaunch } from '../configuration/derive-launch.js';
import { admitLaunch } from '../configuration/launch-admission.js';
import { launchPodOptions } from '../configuration/launch-pod-options.js';
import { createLaunchSnapshotRepository } from '../configuration/launch-snapshot.js';
import { createWorkspaceArtifactObservation } from '../pods/workspace-artifact-observation.js';
import { createWorkspaceBranchSource } from '../pods/workspace-branch-source.js';
import { createWorkspaceBranchSync } from '../pods/workspace-branch-sync.js';
import { createWorkspaceCompletion } from '../pods/workspace-completion.js';
import type {
  WorkspaceCompletionCalls,
  WorkspaceCompletionCaptured,
  WorkspaceCompletionLiveDependencies,
  WorkspaceInfrastructureCaptured,
  WorkspaceInfrastructureLiveDependencies,
  WorkspaceManualFixCalls,
  WorkspaceManualFixLiveDependencies,
  WorkspaceObservationLiveDependencies,
  WorkspacePromotionLiveDependencies,
  WorkspaceRecoveryCommandsCaptured,
  WorkspaceWatchdogCalls,
  WorkspaceWatchdogLiveDependencies,
} from '../pods/workspace-contracts.js';
import { createWorkspaceDeletion } from '../pods/workspace-deletion.js';
import { createWorkspaceEscapeControls } from '../pods/workspace-escape-controls.js';
import { createWorkspaceFences } from '../pods/workspace-fences.js';
import { createWorkspaceHostFetchRetry } from '../pods/workspace-host-fetch-retry.js';
import { createWorkspaceInfrastructureRecovery } from '../pods/workspace-infrastructure-recovery.js';
import { createWorkspaceManualFix } from '../pods/workspace-manual-fix.js';
import { createWorkspacePreservationRecovery } from '../pods/workspace-preservation-recovery.js';
import { createWorkspacePromotion } from '../pods/workspace-promotion.js';
import { createWorkspaceRecoveryCommands } from '../pods/workspace-recovery-commands.js';
import {
  createWorkspaceLeaseState,
  createWorkspaceRecoveryState,
} from '../pods/workspace-recovery-state.js';
import { createWorkspaceWatchdog } from '../pods/workspace-watchdog.js';
import { createTestConfiguration } from './configuration-helpers.js';
import { insertTestProfile } from './mock-helpers.js';
import { createResourceFixture, deferred, result } from './resource-helpers.js';
export { deferred, result };
const closes: Array<() => void> = [];
afterEach(() => {
  for (const close of closes.splice(0).reverse()) close();
});
export function createWorkspaceFixture(disk = false) {
  const f = createResourceFixture(disk);
  const state = createWorkspaceRecoveryState();
  const lease = createWorkspaceLeaseState();
  const enqueueSession = vi.fn<(id: string) => void>();
  const live: WorkspaceInfrastructureLiveDependencies &
    WorkspacePromotionLiveDependencies &
    WorkspaceCompletionLiveDependencies &
    WorkspaceManualFixLiveDependencies &
    WorkspaceObservationLiveDependencies &
    WorkspaceWatchdogLiveDependencies = {
    enqueueSession,
    getSecret: vi.fn(() => undefined),
    eventRepo: f.deps.eventRepo,
    providerAttemptRepo: f.repo,
  };
  const calls = {
    promoteToAuto: vi.fn<WorkspaceCompletionCalls['promoteToAuto']>(async () => {}),
    revalidateSession: vi.fn<WorkspaceCompletionCalls['revalidateSession']>(async () => ({
      newCommits: false,
      result: 'pass',
    })),
    createResolvedSession: vi.fn<NonNullable<WorkspaceManualFixCalls['createResolvedSession']>>(
      () => f.pod(),
    ),
    createSession: vi.fn<WorkspaceManualFixCalls['createSession']>(() => f.pod()),
    killSession: vi.fn<WorkspaceWatchdogCalls['killSession']>(async () => {}),
    cleanupPodResourcesForRecovery: vi.fn<WorkspaceWatchdogCalls['cleanupPodResourcesForRecovery']>(
      async () => {},
    ),
  };
  const fences = createWorkspaceFences({ ...f.core, nudgeRepo: f.deps.nudgeRepo });
  const common = {
    ...f.core,
    ...fences,
    ...state,
    ...lease,
    enqueueSession,
    profileStore: f.profiles,
    preservePodWorkspace: vi.fn<WorkspaceRecoveryCommandsCaptured['preservePodWorkspace']>(
      async () => {},
    ),
    checkpointSandboxWorkspaceForPod: vi.fn<
      WorkspaceRecoveryCommandsCaptured['checkpointSandboxWorkspaceForPod']
    >(async () => ({
      sequence: 1,
      sourceHead: 'head',
      sourceTree: 'tree',
      snapshotCommit: 'commit',
      snapshotTree: 'tree',
      transferVerified: true,
      bundleVerified: true,
      hostImported: true,
      lineageVerified: true,
      promoted: true,
      materialized: true,
      quarantineRef: 'refs/synthetic',
    })),
    recoverWorktreeFromContainer: vi.fn<
      WorkspaceRecoveryCommandsCaptured['recoverWorktreeFromContainer']
    >(async () => false),
    syncWorkspaceBack: vi.fn<WorkspaceCompletionCaptured['syncWorkspaceBack']>(async () => ({
      pushed: true,
    })),
    cleanupContainer: vi.fn(f.cleanup.cleanupContainer),
    preserveArtifacts: vi.fn<WorkspaceCompletionCaptured['preserveArtifacts']>(
      async () => `${f.directory}/artifact`,
    ),
    runPushCheckpointScan: vi.fn<WorkspaceCompletionCaptured['runPushCheckpointScan']>(
      async () => {},
    ),
    killSidecarsForPod: vi.fn(f.auxiliary().killSidecarsForPod),
    destroyPodNetwork: vi.fn(f.networkOwner().destroyPodNetwork),
    clearPreviewTimer: vi.fn(f.timers.clearPreviewTimer),
    stopSandboxPreviewProxy: f.cleanupCaptured.stopSandboxPreviewProxy,
    cleanupTestRunBranches: vi.fn(f.auxiliary().cleanupTestRunBranches),
    pendingUpdateFromBaseIntents: new Set<string>(),
    validationAbortControllers: new Map<string, AbortController>(),
    clearStuckQueueEntry: vi.fn(() => true),
    closeProviderAttempt: vi.fn<WorkspaceInfrastructureCaptured['closeProviderAttempt']>(
      (id, outcome) => f.nativeAttempts.closeProviderAttempt(id, outcome),
    ),
    validationRepo: f.deps.validationRepo,
  };
  const watchdog = createWorkspaceWatchdog(live, common);
  closes.push(() => watchdog.stopStuckPodWatchdog());
  function interactive(output: Pod['options']['output'] = 'branch') {
    f.podRepo.update('prepare', {
      options: { agentMode: 'interactive', output, validate: false, promotable: true },
      status: 'running',
      prUrl: null,
    });
    return f.pod();
  }

  async function nativeLaunch(workspace = false) {
    insertTestProfile(f.db, { name: 'profile' });
    f.profiles.update('profile', { repoUrl: 'https://github.com/org/repo-a' });
    const { store, services } = createTestConfiguration(f.db);
    if (workspace) {
      const flow = store.get('workflow', 'flow');
      store.write({
        kind: 'workflow',
        id: flow.id,
        name: flow.name,
        expectedRevision: flow.revision,
        payload: {
          ...flow.payload,
          agentMode: 'interactive',
          promotable: true,
          output: 'branch',
          validationPhases: ['build'],
        },
      });
    }
    const snapshots = createLaunchSnapshotRepository(f.db, store);
    services.readLaunch = snapshots.get;
    function insert(config: EffectiveLaunchConfig, id: string, userId = 'operator') {
      f.podRepo.insert({
        id,
        profileName: config.profileId,
        task: config.task,
        status: 'queued',
        runtime: config.ai.main.runtime,
        model: config.ai.main.model,
        executionTarget: 'local',
        dispatchRepository: config.repository?.config.remote ?? null,
        branch: config.work.branch ?? 'native/parent',
        baseBranch: config.work.baseBranch ?? 'main',
        userId,
        maxValidationAttempts: 3,
        skipValidation: false,
        options: launchPodOptions(config),
        outputMode: outputModeFromPodOptions(launchPodOptions(config)),
        providerAccountIdSnapshot: 'account',
        providerIdSnapshot: 'anthropic',
        linkedPodId: config.work.linkedPodId ?? null,
      });
      return f.podRepo.getOrThrow(id);
    }
    const admitted = await admitLaunch({
      request: {
        repositoryId: 'repo-a',
        task: 'Frozen parent',
        work: { branch: 'native/parent', baseBranch: 'main' },
      },
      actorId: 'operator',
      services,
      snapshots,
      createPod: (config) => insert(config, 'frozen-parent').id,
    });
    f.podRepo.update(admitted.podId, {
      status: 'running',
      containerId: 'native-container',
      worktreePath: f.directory,
    });
    live.launchConfiguration = {
      prepareWorker: async (input, apply) => {
        const source = snapshots.get(input.source.podId);
        if (!source) throw new Error('Missing frozen source');
        const config = deriveLaunch(source, input);
        if (!f.podRepo.atomically) throw new Error('Missing native unit of work');
        f.podRepo.atomically(() =>
          snapshots.prepareWorker({
            config,
            expectedGeneration: f.podRepo.getOrThrow(input.source.podId).lifecycleGeneration,
            apply: () => apply(config),
          }),
        );
      },
      admitDerived: async (input, create) => {
        const source = snapshots.get(input.source.podId);
        if (!source) throw new Error('Missing frozen source');
        const config = deriveLaunch(source, input);
        return snapshots.admit({
          config,
          requestDigest: configurationDigest(input),
          createPod: () => create(config),
        }).podId;
      },
    };
    calls.createResolvedSession.mockImplementation((config, userId) =>
      insert(config, 'frozen-manual', userId),
    );
    return { admitted, store, snapshots };
  }
  return {
    ...f,
    get db() {
      return f.db;
    },
    state,
    lease,
    live,
    calls,
    common,
    fences,
    interactive,
    nativeLaunch,
    watchdog,
    hostRetry: () => createWorkspaceHostFetchRetry(common),
    infrastructure: () => createWorkspaceInfrastructureRecovery(live, common),
    branchSource: () => createWorkspaceBranchSource(common),
    preservation: () => createWorkspacePreservationRecovery(common),
    promotion: () => createWorkspacePromotion(live, common),
    completion: () => createWorkspaceCompletion(live, common),
    branchSync: () => createWorkspaceBranchSync(common),
    recovery: () => createWorkspaceRecoveryCommands(common),
    manualFix: () => createWorkspaceManualFix(live, common),
    deletion: () => createWorkspaceDeletion(common),
    escape: () => createWorkspaceEscapeControls(common),
    observation: () => createWorkspaceArtifactObservation(live, common),
  };
}
