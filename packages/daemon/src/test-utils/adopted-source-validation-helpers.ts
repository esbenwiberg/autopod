import type { Profile } from '@autopod/shared';
import { vi } from 'vitest';
import { sourcePodFingerprint } from '../pods/source-adoption-repository.js';
import { captureValidationOwnership } from '../pods/validation-ownership.js';
import { createValidationProgress } from '../pods/validation-progress.js';
import { createValidationPublication } from '../pods/validation-publication.js';
import { createValidationRepository } from '../pods/validation-repository.js';
import { createValidationRevalidationWorkflow } from '../pods/validation-revalidation-workflow.js';
import type {
  ValidationRevalidationCaptured,
  ValidationWorkflowLiveDependencies,
} from '../pods/validation-workflow-ports.js';
import { createPassingValidationResult } from './mock-helpers.js';
import { createOperatorFixture } from './operator-helpers.js';

export function createAdoptedSourceValidationFixture(
  disk = false,
  options: {
    setup?: string | null;
    disabled?: boolean;
    waived?: boolean;
  } = {},
) {
  const f = createOperatorFixture(disk);
  const id = f.pod().id;
  const profile = {
    ...f.ctx.profileStore.get(f.pod().profileName),
    repoUrl: 'https://github.com/org/repo',
    validationSetupCommand: options.setup === undefined ? 'npm ci' : options.setup,
    skipValidationPhases: [],
  };
  f.podRepo.update(id, {
    profileSnapshot: profile,
    lastValidationResult: null,
    validationAttempts: 3,
    skipValidation: options.waived ?? false,
    options: { ...f.pod().options, validationSuite: 'full', validate: !options.disabled },
  });
  f.events.transition(f.pod(), 'failed');
  const pod = f.pod();
  const journal = f.podRepo.sourceAdoptions;
  if (!journal || !pod.containerId || !pod.worktreePath) throw new Error('Missing source fixture');
  journal.claim(
    'source-checks',
    id,
    {
      generation: pod.lifecycleGeneration,
      fingerprint: sourcePodFingerprint(pod),
      repository: profile.repoUrl,
      branch: pod.branch,
      baseBranch: pod.baseBranch ?? profile.defaultBranch ?? 'main',
      containerId: pod.containerId,
      resourceKey: `local:test:${pod.containerId}`,
      worktreePath: pod.worktreePath,
      oldHead: 'a'.repeat(40),
      targetHead: 'b'.repeat(40),
      dependencySetupCommand: profile.validationSetupCommand ?? undefined,
    },
    { type: 'human', userId: 'fixture-owner' },
    'Validate exact repaired source',
    () => {},
  );
  journal.advance('source-checks', 'claimed', 'preserved', {
    preservation: {
      host: '/private/host',
      container: '/private/container',
      bundle: '/private/source.bundle',
      bundleHash: 'f'.repeat(64),
      tree: 'c'.repeat(40),
    },
  });
  const generation = journal.owned('source-checks', () =>
    f.podRepo.incrementLifecycleGeneration(id),
  );
  journal.advance('source-checks', 'preserved', 'applying', { generation });
  journal.advance('source-checks', 'applying', 'adopted');
  journal.advance('source-checks', 'adopted', 'checking');
  const harness = createSourceRevalidationHarness(f, profile);
  const run = () =>
    journal.owned('source-checks', () =>
      harness.workflow().revalidateAdoptedSource(id, {
        operationId: 'source-checks',
        verifySource: harness.verifySource,
      }),
    );
  return { f, id, journal, ...harness, run };
}
export function createSourceRevalidationHarness(
  f: ReturnType<typeof createOperatorFixture>,
  profile: Profile,
) {
  const id = f.pod().id;
  const result = {
    ...createPassingValidationResult(id, 4),
    setup: { status: 'pass' as const, output: 'Fixture dependency preparation', duration: 1 },
  };
  vi.mocked(f.ctx.validationEngine.validate).mockResolvedValue(result);
  const validationRepo = createValidationRepository(f.db);
  const oldReview = vi.spyOn(validationRepo, 'getLatestReviewBatch').mockImplementation(() => {
    throw new Error('Historical review was consulted');
  });
  const publication = createValidationPublication({
    podRepo: f.podRepo,
    validationRepo,
    eventBus: f.deps.eventBus,
  });
  const captured = {
    CONTAINER_APP_PORT: 3000,
    podRepo: f.podRepo,
    eventBus: f.deps.eventBus,
    containerManagerFactory: f.deps.containerManagerFactory,
    worktreeManager: f.worktreeManager,
    validationEngine: f.ctx.validationEngine,
    enqueueSession: vi.fn(),
    logger: f.deps.logger,
    validationRepo,
    executionForPod: f.captured.resolveEffectiveBoundProfile,
    validationEnvironmentForPod: vi.fn(async () => ({})),
    ...f.guards,
    resolveGitCredential: vi.fn(async () => undefined),
    runPushCheckpointScan: vi.fn(async () => {}),
    validationAbortControllers: new Map<string, AbortController>(),
    buildReviewerExecEnv: vi.fn(async () => undefined),
    getEffectiveReviewerConfig: () => ({ profile, credentials: null }),
    getReviewerExecutor: () => undefined,
    prepareWorkspaceForValidation: vi.fn(async () => {}),
    buildPhaseEventCallbacks: createValidationProgress({ eventBus: f.deps.eventBus })
      .buildPhaseEventCallbacks,
    validateWithInfrastructureRetries: vi.fn<
      ValidationRevalidationCaptured['validateWithInfrastructureRetries']
    >(async (config, controller, callbacks) =>
      f.ctx.validationEngine.validate(config, controller.signal, undefined, callbacks),
    ),
    publishValidationResult: vi.fn(publication.publishValidationResult),
    parkOnRetryAdmission: vi.fn(async () => {}),
    parkOnValidationInfrastructureFailure: vi.fn(async () => {}),
    parkOnReviewInfrastructureFailure: vi.fn(async () => {}),
    emitActivityStatus: vi.fn(),
    emitActivityError: vi.fn(),
    sanitizeFailureReason: (_error: unknown, prefix: string) => prefix,
    tryRecoverAfterWorkspaceSyncFailure: vi.fn(async () => false),
    parkOnWorktreeSyncFailure: vi.fn(),
    transition: f.events.transition,
    applySkipValidationDecision: vi.fn(() => null),
    claimValidation: vi.fn<ValidationRevalidationCaptured['claimValidation']>((expected) =>
      captureValidationOwnership(expected, {
        readCurrent: f.pod,
        isCurrentInvocation: () => true,
        hasPendingDecision: () => false,
      }),
    ),
    maybeTriggerDependents: vi.fn(),
    completeRevalidationPass: vi.fn<ValidationRevalidationCaptured['completeRevalidationPass']>(
      async (context) => {
        if (!context.checksOnly) throw new Error('Source checks attempted delivery');
        f.events.transition(f.pod(), 'validated');
        return { newCommits: true, result: 'pass' };
      },
    ),
  } satisfies ValidationRevalidationCaptured;
  const verifySource = vi.fn(async () => {});
  const live: ValidationWorkflowLiveDependencies = {};
  const workflow = () => createValidationRevalidationWorkflow(live, captured);
  return {
    captured,
    verifySource,
    live,
    workflow,
    result,
    validationRepo,
    oldReview,
  };
}
