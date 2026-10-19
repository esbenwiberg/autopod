import type {
  Pod,
  PodOptions,
  ProviderCredentials,
  ValidationOverride,
  ValidationPhase,
} from '@autopod/shared';
import type { Logger } from 'pino';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import type { ReviewerExecutor } from '../interfaces/reviewer-executor.js';
import type { ValidationEngineConfig } from '../interfaces/validation-engine.js';
import type { WorktreeManager } from '../interfaces/worktree-manager.js';
import { parseDiffFilePaths } from '../validation/review-context-builder.js';
import { buildValidationContextEnv } from '../validation/validation-context-env.js';
import type { PendingOverrideRepository } from './pending-override-repository.js';
import type { PodRepository } from './pod-repository.js';
import { resolveReviewerModel, resolveReviewerProvider } from './runtime-resolver.js';
import type { StoredValidation, ValidationRepository } from './validation-repository.js';

// Matches the manager's existing default app-server port.
const CONTAINER_APP_PORT = 3000;

interface ValidationInputsDependencies {
  logger: Logger;
  worktreeManager: Pick<WorktreeManager, 'getDiff' | 'getCommitLog' | 'getChangedPathsAgainstBase'>;
  podRepo: Pick<PodRepository, 'update'>;
  validationRepo?: Pick<ValidationRepository, 'getLatest' | 'getLatestReviewBatch'>;
  overrideSource: { pendingOverrideRepo?: Pick<PendingOverrideRepository, 'flush'> };
  validationEnvironmentForPod(
    pod: Pod,
    profile: PodExecutionSettings,
  ): Promise<Record<string, string> | undefined>;
  assertProtectedOperationalPathsInScope(pod: Pod, paths: string[]): void;
  loadCodeReviewSkill(worktreePath: string, log?: Logger): Promise<string | undefined>;
  getEffectiveReviewerConfig(pod: Pod): {
    profile: PodExecutionSettings;
    credentials: ProviderCredentials | null;
  };
  buildReviewerExecEnv(pod: Pod): Promise<Record<string, string> | undefined>;
  mergeOverrides(
    existing: ValidationOverride[],
    incoming: ValidationOverride[],
  ): ValidationOverride[];
  getReviewerExecutor(pod: Pod): ReviewerExecutor | undefined;
  getPodValidationSkipPhases(profile: PodExecutionSettings, pod: Pod): ValidationPhase[];
  emitActivityStatus(podId: string, message: string): void;
}

interface PreparedValidationInputs {
  validationConfig: ValidationEngineConfig;
  previousValidation: StoredValidation | null;
}

/** Assemble ordinary validation inputs with the existing effects and read order. */
export function createValidationInputs(deps: ValidationInputsDependencies): {
  prepareValidationInputs(
    pod: Pod,
    profile: PodExecutionSettings,
    s1: Pod,
    attempt: number,
    validationSuite: NonNullable<PodOptions['validationSuite']>,
  ): Promise<PreparedValidationInputs>;
} {
  const {
    logger,
    worktreeManager,
    podRepo,
    validationRepo,
    overrideSource,
    validationEnvironmentForPod,
    assertProtectedOperationalPathsInScope,
    loadCodeReviewSkill,
    getEffectiveReviewerConfig,
    buildReviewerExecEnv,
    mergeOverrides,
    getReviewerExecutor,
    getPodValidationSkipPhases,
    emitActivityStatus,
  } = deps;

  async function prepareValidationInputs(
    pod: Pod,
    profile: PodExecutionSettings,
    s1: Pod,
    attempt: number,
    validationSuite: NonNullable<PodOptions['validationSuite']>,
  ): Promise<PreparedValidationInputs> {
    const podId = pod.id;
    // Get the actual diff and commit log for AI task review.
    // Always scope to the agent's own commits via startCommitSha. The reviewer
    // should only evaluate what this agent changed — pre-existing code on a
    // parent branch is not the agent's responsibility. Stats/file counts still
    // use the full branch diff (computed earlier) for accurate PR sizing.
    emitActivityStatus(podId, 'Computing diff…');
    const diffSinceCommit = pod.startCommitSha ?? undefined;
    const validationDefaultBranch = pod.baseBranch ?? profile.defaultBranch ?? 'main';
    const validationExecEnv = {
      ...((await validationEnvironmentForPod(pod, profile)) ?? {}),
      ...buildValidationContextEnv({
        podId,
        headBranch: pod.branch,
        baseBranch: validationDefaultBranch,
        startCommitSha: pod.startCommitSha,
      }),
    };
    const [diff, commitLog] = pod.worktreePath
      ? await Promise.all([
          worktreeManager.getDiff(
            pod.worktreePath,
            validationDefaultBranch,
            undefined,
            diffSinceCommit,
          ),
          worktreeManager.getCommitLog(
            pod.worktreePath,
            validationDefaultBranch,
            undefined,
            diffSinceCommit,
          ),
        ])
      : ['', ''];
    const changedPathsAgainstBase =
      pod.worktreePath && worktreeManager.getChangedPathsAgainstBase
        ? await worktreeManager.getChangedPathsAgainstBase(
            pod.worktreePath,
            validationDefaultBranch,
          )
        : parseDiffFilePaths(diff);
    assertProtectedOperationalPathsInScope(pod, changedPathsAgainstBase);

    // Try to load a repo-specific code-review skill from the worktree
    const codeReviewSkill = pod.worktreePath
      ? await loadCodeReviewSkill(pod.worktreePath, logger)
      : undefined;

    const { profile: reviewerProfile, credentials: reviewerProviderCredentials } =
      getEffectiveReviewerConfig(pod);
    const reviewerExecEnv = await buildReviewerExecEnv(pod);

    // Attempt is a resettable per-cycle budget. Capture chronological history
    // before this run so rework attempt 1 still closes the prior council ledger.
    const previousValidation = validationRepo?.getLatest(podId) ?? null;
    const priorReviewBatch = validationRepo?.getLatestReviewBatch(podId);

    // Flush any pending overrides enqueued via API and merge into pod overrides
    const pendingOverrides = overrideSource.pendingOverrideRepo?.flush(podId) ?? [];
    let currentOverrides = pod.validationOverrides ?? [];
    if (pendingOverrides.length > 0) {
      currentOverrides = mergeOverrides(currentOverrides, pendingOverrides);
      podRepo.update(podId, { validationOverrides: currentOverrides });
    }

    const validationConfig = {
      podId,
      containerId: pod.containerId,
      executionTarget: pod.executionTarget,
      previewUrl: pod.previewUrl ?? `http://127.0.0.1:${CONTAINER_APP_PORT}`,
      containerBaseUrl: `http://127.0.0.1:${CONTAINER_APP_PORT}`,
      webProbeMode: pod.executionTarget === 'sandbox' ? ('container' as const) : ('host' as const),
      validationSetupCommand: profile.validationSetupCommand ?? undefined,
      buildCommand: profile.buildCommand ?? '',
      startCommand: profile.startCommand ?? '',
      buildWorkDir: profile.buildWorkDir ?? undefined,
      healthPath: profile.healthPath ?? '/',
      healthTimeout: profile.healthTimeout ?? 120,
      smokePages: profile.smokePages,
      attempt,
      validationSuite,
      task: pod.task,
      diff,
      testCommand: profile.testCommand,
      buildTimeout: (profile.buildTimeout ?? 300) * 1_000,
      testTimeout: (profile.testTimeout ?? 600) * 1_000,
      lintCommand: profile.lintCommand ?? undefined,
      lintTimeout: (profile.lintTimeout ?? 120) * 1_000,
      sastCommand: profile.sastCommand ?? undefined,
      sastTimeout: (profile.sastTimeout ?? 300) * 1_000,
      reviewerModel: resolveReviewerModel(reviewerProfile, logger),
      reviewerProvider: resolveReviewerProvider(reviewerProfile),
      reviewerProviderAccountId: reviewerProfile.providerAccountId ?? null,
      reviewerProviderCredentials,
      ...(reviewerExecEnv ? { reviewerExecEnv } : {}),
      reviewerExecutor: getReviewerExecutor(pod),
      contract: pod.contract ?? undefined,
      codeReviewSkill,
      commitLog: commitLog || undefined,
      plan: pod.plan ?? undefined,
      taskSummary: pod.taskSummary ?? undefined,
      briefTouches: pod.touches ?? undefined,
      briefDoesNotTouch: pod.doesNotTouch ?? undefined,
      worktreePath: pod.worktreePath ?? undefined,
      startCommitSha: pod.startCommitSha ?? undefined,
      overrides: currentOverrides.length > 0 ? currentOverrides : undefined,
      hasWebUi: profile.hasWebUi ?? true,
      advisoryBrowserQaEnabled: pod.options.advisoryBrowserQaEnabled ?? false,
      reviewerApiKey: pod.launchConfigDigest ? undefined : process.env.ANTHROPIC_API_KEY,
      extraExecEnv: validationExecEnv,
      preSubmitReview: pod.preSubmitReview ?? undefined,
      skipPhases: getPodValidationSkipPhases(profile, s1),
      priorReviewBatch,
    };

    // The caller's existing container guard precedes this preparation sequence.
    return { validationConfig: validationConfig as ValidationEngineConfig, previousValidation };
  }

  return { prepareValidationInputs };
}
