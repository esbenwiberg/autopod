import { type Pod, outputModeFromPodOptions } from '@autopod/shared';
import { vi } from 'vitest';
import { configurationDigest } from '../configuration/configuration-digest.js';
import { deriveLaunch } from '../configuration/derive-launch.js';
import { admitLaunch } from '../configuration/launch-admission.js';
import { launchPodOptions } from '../configuration/launch-pod-options.js';
import { createLaunchSnapshotRepository } from '../configuration/launch-snapshot.js';
import type { PrManager } from '../interfaces/pr-manager.js';
import { createFixAdmission } from '../pods/fix-admission.js';
import type {
  FixAdmissionCaptured,
  FixAdmissionLiveDependencies,
  FixControlsCaptured,
  FixDeliveryCaptured,
  FixFeedbackCaptured,
  FixProviderLiveDependencies,
} from '../pods/fix-contracts.js';
import { createFixControls } from '../pods/fix-controls.js';
import { createFixDelivery } from '../pods/fix-delivery.js';
import { createFixFeedback } from '../pods/fix-feedback.js';
import { createFixParking } from '../pods/fix-parking.js';
import { createFixCyclePolicy } from '../pods/fix-policy.js';
import { createFixProviderBinding } from '../pods/fix-provider-binding.js';
import { createProviderAttemptContext } from '../pods/provider-attempt-context.js';
import { createTestConfiguration } from './configuration-helpers.js';
import { createDeliveryFixture, pendingStatus } from './delivery-helpers.js';
import { createPassingValidationResult, insertTestProfile } from './mock-helpers.js';

export { pendingStatus };
export function createFixCycleFixture(disk = false) {
  const f = createDeliveryFixture(disk);
  f.mergePending();
  const effects: string[] = [];
  const policy = createFixCyclePolicy();
  const providerLive: FixProviderLiveDependencies = {
    providerAttemptRepo: f.deps.providerAttemptRepo,
  };
  const binding = createFixProviderBinding(providerLive);
  const nativeAttempts = createProviderAttemptContext(f.deps, {
    podRepo: f.podRepo,
    providerAccountStore: f.accounts,
    profileStore: f.profiles,
    executionForPod: f.mainCaptured.executionForPod,
    activeAgentRuns: new Map(),
  });
  const parkingCaptured = {
    ...f.mainCaptured,
    parkOnCredentialFailure: vi.fn(f.credentials().parkOnCredentialFailure),
  };
  const parking = createFixParking(parkingCaptured);
  const provider = {
    ...f.provider,
    replyToReviewFeedback: vi.fn<NonNullable<PrManager['replyToReviewFeedback']>>(async () => ({
      posted: 1,
      skipped: 0,
      resolved: 1,
      errors: [],
      resolutionErrors: [],
    })),
  };
  const feedbackCaptured = {
    ...f.mainCaptured,
    prManagerFactory: vi.fn(() => provider),
  } satisfies FixFeedbackCaptured;
  const feedback = createFixFeedback(feedbackCaptured);
  const admissionLive: FixAdmissionLiveDependencies = {};
  const admissionCaptured = {
    ...f.mainCaptured,
    ...policy,
    ...binding,
    podRepo: f.podRepo,
    resolveBranchSource: vi.fn((parent: Pod) => parent),
    stopMergePolling: vi.fn((id: string) => {
      effects.push(`stop:${id}`);
    }),
    cleanupContainer: vi.fn<FixAdmissionCaptured['cleanupContainer']>(async (pod, label) => {
      effects.push(`cleanup:${pod.id}:${label}`);
    }),
    enqueueSession: vi.fn((id: string) => {
      effects.push(`enqueue:${id}`);
    }),
  } satisfies FixAdmissionCaptured;
  const admission = () => createFixAdmission(admissionLive, admissionCaptured);
  const deliveryCaptured = {
    ...f.mainCaptured,
    ...parking,
    ...feedback,
    assertGuidanceCollected: f.guards.assertGuidanceCollected,
    mergeQueue: f.queue.mergeQueue,
    cleanupContainer: admissionCaptured.cleanupContainer,
  } satisfies FixDeliveryCaptured;
  const delivery = () => createFixDelivery(deliveryCaptured);
  const controlsCaptured = {
    ...f.mainCaptured,
    ...policy,
    fixFeedbackRepo: f.deps.fixFeedbackRepo,
    startMergePolling: vi.fn(),
    maybeSpawnFixSession: vi.fn<FixControlsCaptured['maybeSpawnFixSession']>((...args) =>
      admission().maybeSpawnFixSession(...args),
    ),
  } satisfies FixControlsCaptured;
  const controls = () => createFixControls(controlsCaptured);
  function insertFix(status: Pod['status'] = 'validated') {
    const parent = f.pod();
    f.podRepo.insert({
      id: 'fix-child',
      profileName: parent.profileName,
      task: 'Repair original',
      status,
      runtime: parent.runtime,
      model: parent.model,
      executionTarget: 'local',
      branch: parent.branch,
      userId: parent.userId,
      maxValidationAttempts: 3,
      skipValidation: false,
      options: parent.options,
      outputMode: parent.outputMode,
      baseBranch: parent.baseBranch,
      linkedPodId: parent.id,
      prUrl: parent.prUrl,
      providerAccountIdSnapshot: parent.providerAccountIdSnapshot,
      providerIdSnapshot: parent.providerIdSnapshot,
    });
    f.podRepo.update('fix-child', {
      containerId: 'fix-container',
      worktreePath: f.directory,
      lastValidationResult: createPassingValidationResult('fix-child'),
    });
    f.podRepo.update('prepare', { fixPodId: 'fix-child' });
    f.podRepo.completionJournal?.begin(f.podRepo.getOrThrow('fix-child'));
    f.podRepo.completionJournal?.mark(f.podRepo.getOrThrow('fix-child'), 'finalizing');
    return f.podRepo.getOrThrow('fix-child');
  }
  async function nativeParent(withLegacyAlias = true) {
    if (withLegacyAlias) {
      insertTestProfile(f.db, { name: 'profile' });
      f.profiles.update('profile', { repoUrl: 'https://github.com/org/repo-a' });
    }
    const { store, services } = createTestConfiguration(f.db);
    const snapshots = createLaunchSnapshotRepository(f.db, store);
    services.readLaunch = snapshots.get;
    const parent = await admitLaunch({
      request: {
        repositoryId: 'repo-a',
        task: 'Frozen parent',
        work: { branch: 'native/parent', baseBranch: 'main' },
      },
      actorId: 'operator',
      services,
      snapshots,
      createPod: (config) => {
        f.podRepo.insert({
          id: 'native-parent',
          profileName: config.profileId,
          task: config.task,
          status: 'queued',
          runtime: config.ai.main.runtime,
          model: config.ai.main.model,
          executionTarget: 'local',
          dispatchRepository: config.repository?.config.remote ?? null,
          branch: 'native/parent',
          baseBranch: 'main',
          userId: 'operator',
          maxValidationAttempts: 3,
          skipValidation: false,
          options: launchPodOptions(config),
          outputMode: outputModeFromPodOptions(launchPodOptions(config)),
          providerAccountIdSnapshot: 'account',
          providerIdSnapshot: 'anthropic',
        });
        return 'native-parent';
      },
    });
    f.podRepo.update(parent.podId, {
      status: 'merge_pending',
      prUrl: 'https://github.com/org/repo/pull/28',
    });
    // Native snapshot services are real; provider/environment discovery stays controlled.
    admissionLive.launchConfiguration = {
      admitDerived: vi.fn(async (input, insert) => {
        const source = snapshots.get(input.source.podId);
        if (!source) throw new Error('Missing frozen parent');
        const config = deriveLaunch(source, input);
        return snapshots.admit({
          config,
          requestDigest: configurationDigest(input),
          createPod: () => insert(config),
        }).podId;
      }),
    };
    admissionCaptured.executionForPod = () => f.passContext().profile;
    return { parent, store, snapshots };
  }
  return {
    ...f,
    get db() {
      return f.db;
    },
    effects,
    policy,
    providerLive,
    binding,
    nativeAttempts,
    parkingCaptured,
    parking,
    provider,
    feedbackCaptured,
    feedback,
    admissionLive,
    admissionCaptured,
    admission,
    deliveryCaptured,
    delivery,
    controlsCaptured,
    controls,
    insertFix,
    nativeParent,
    fix: () => f.podRepo.getOrThrow('fix-child'),
  };
}
