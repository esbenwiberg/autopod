import { createHash } from 'node:crypto';
import type { Pod } from '@autopod/shared';
import type { ContainerManager } from '../interfaces/container-manager.js';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import type { ReviewerLaunchIdentity } from '../interfaces/reviewer-launch.js';
import type { ValidationEngine } from '../interfaces/validation-engine.js';
import { resolveAnthropicModelId } from '../providers/llm-client.js';
import { resolveContainerReviewer } from '../validation/container-reviewer-runner.js';
import { resolveToolReviewModelId } from '../validation/review-tool-runner.js';
import { inspectExecutionPreflight } from './execution-preflight.js';
import type { PodRepository } from './pod-repository.js';
import {
  legacyReviewerApiProvenance,
  reviewerApiProvenance,
  reviewerHostCliProvenance,
} from './reviewer-api-provenance.js';
import { TaskRetryBlockedError } from './task-retry-ledger.js';
import type { captureValidationOwnership } from './validation-ownership.js';

interface ValidationProvenanceDependencies {
  podRepo: Pick<PodRepository, 'getOrThrow' | 'executionProvenance'>;
  containerManagerFactory: { get(target: Pod['executionTarget']): ContainerManager };
  resolveEffectiveBoundProfile(pod: Pod): PodExecutionSettings;
}

export function createValidationProvenance(deps: ValidationProvenanceDependencies): {
  recordValidationProvenance(
    config: Parameters<ValidationEngine['validate']>[0],
    purpose?: 'validation' | 'review',
    assertCurrent?: () => Pod,
    reviewerLaunch?: ReviewerLaunchIdentity,
  ): Promise<void>;
  withReviewerLaunchPreflight(
    config: Parameters<ValidationEngine['validate']>[0],
    ownership: ReturnType<typeof captureValidationOwnership>,
  ): Parameters<ValidationEngine['validate']>[0];
} {
  const { podRepo, containerManagerFactory, resolveEffectiveBoundProfile } = deps;

  async function recordValidationProvenance(
    config: Parameters<ValidationEngine['validate']>[0],
    purpose: 'validation' | 'review' = 'validation',
    assertCurrent?: () => Pod,
    reviewerLaunch?: ReviewerLaunchIdentity,
  ): Promise<void> {
    if (!podRepo.executionProvenance) return;
    const pod = assertCurrent?.() ?? podRepo.getOrThrow(config.podId);
    const profile = resolveEffectiveBoundProfile(pod);
    const skips = new Set(config.skipPhases ?? []);
    // Prepared independent councils use their fixed runner resolver. Actual CLI
    // launches supply identity from the dispatch path after prompt preparation.
    const reviewerRuntime =
      purpose === 'review'
        ? (reviewerLaunch?.runtime ??
          resolveContainerReviewer({
            modelProvider: config.reviewerProvider ?? 'anthropic',
            providerCredentials: config.reviewerProviderCredentials ?? null,
          }))
        : null;
    if (
      purpose === 'review' &&
      ((!config.councilOnly && !reviewerLaunch) || typeof reviewerRuntime !== 'string')
    )
      throw new TaskRetryBlockedError(
        'Independent council reviewer runtime is unsupported or unverified; reconcile its selected provider before review.',
      );
    const executionPod =
      reviewerRuntime && typeof reviewerRuntime === 'string'
        ? {
            ...pod,
            runtime: reviewerRuntime,
            model: config.reviewerModel ?? 'auto',
            providerIdSnapshot: config.reviewerProvider ?? 'anthropic',
            providerAccountIdSnapshot: config.reviewerProviderAccountId ?? null,
          }
        : pod;
    const provenance = await inspectExecutionPreflight(
      containerManagerFactory.get(pod.executionTarget),
      config.containerId,
      {
        ...executionPod,
        skipValidation: false,
        options: { ...pod.options, validate: true },
        contract:
          skips.has('facts') && config.contract
            ? { ...config.contract, requiredFacts: [] }
            : config.contract,
      },
      {
        ...profile,
        buildCommand: skips.has('build') ? '' : config.buildCommand,
        startCommand: skips.has('health') && skips.has('pages') ? '' : config.startCommand,
        testCommand: skips.has('test') ? undefined : config.testCommand,
        lintCommand: skips.has('lint') ? undefined : config.lintCommand,
        sastCommand: skips.has('sast') ? undefined : config.sastCommand,
        validationSetupCommand: skips.has('setup') ? undefined : config.validationSetupCommand,
        buildWorkDir: config.buildWorkDir ?? null,
        buildEnv: config.extraExecEnv ?? null,
      },
      purpose,
      purpose === 'review' ? 'reviewer' : 'worker',
    );
    if (assertCurrent) resolveEffectiveBoundProfile(assertCurrent());
    provenance.contractHash = createHash('sha256')
      .update(JSON.stringify(config.contract ?? null))
      .digest('hex');
    if (reviewerLaunch)
      provenance.diagnostics.push({
        code: 'REVIEWER_LAUNCH_PREFLIGHT',
        detail:
          'Selected container reviewer checked at its CLI launch boundary; this preflight does not prove execution completion.',
      });
    podRepo.executionProvenance.record(pod.id, pod.lifecycleGeneration, provenance);
    if (provenance.status === 'blocked')
      throw new TaskRetryBlockedError(
        provenance.diagnostics.find((item) => item.code.startsWith('PREFLIGHT_'))?.detail ??
          'Validation environment requires reconciliation',
      );
  }

  function withReviewerLaunchPreflight(
    config: Parameters<ValidationEngine['validate']>[0],
    ownership: ReturnType<typeof captureValidationOwnership>,
  ): Parameters<ValidationEngine['validate']>[0] {
    function recordApiDispatch(
      provenance: typeof reviewerApiProvenance,
      resolveModel: (model: string) => string,
    ) {
      return (dispatchModel: string) => {
        const pod = ownership.assertCurrent();
        resolveEffectiveBoundProfile(pod);
        if (dispatchModel !== resolveModel(config.reviewerModel ?? 'auto'))
          throw new TaskRetryBlockedError(
            'Reviewer API dispatch identity differs from the frozen validation configuration.',
          );
        if (!podRepo.executionProvenance)
          throw new TaskRetryBlockedError(
            'Reviewer API provenance is unavailable; reconcile the execution ledger.',
          );
        podRepo.executionProvenance.record(
          pod.id,
          pod.lifecycleGeneration,
          provenance(config, dispatchModel),
        );
      };
    }
    return {
      ...config,
      assertReviewerCurrent: () => {
        resolveEffectiveBoundProfile(ownership.assertCurrent());
      },
      recordReviewerApiDispatch: recordApiDispatch(reviewerApiProvenance, resolveAnthropicModelId),
      recordLegacyReviewerApiDispatch: recordApiDispatch(
        legacyReviewerApiProvenance,
        resolveToolReviewModelId,
      ),
      recordHostReviewerDispatch: (evidence) => {
        const pod = ownership.assertCurrent();
        resolveEffectiveBoundProfile(pod);
        if (evidence.model !== (config.reviewerModel ?? 'auto'))
          throw new TaskRetryBlockedError(
            'Host reviewer model differs from the frozen validation configuration.',
          );
        if (!podRepo.executionProvenance)
          throw new TaskRetryBlockedError(
            'Host reviewer provenance ledger is unavailable; reconcile before dispatch.',
          );
        podRepo.executionProvenance.record(
          pod.id,
          pod.lifecycleGeneration,
          reviewerHostCliProvenance(config, evidence),
        );
      },
      beforeReviewerLaunch: async (identity) => {
        resolveEffectiveBoundProfile(ownership.assertCurrent());
        const selectedRuntime = resolveContainerReviewer({
          modelProvider: config.reviewerProvider ?? 'anthropic',
          providerCredentials: config.reviewerProviderCredentials ?? null,
        });
        if (
          identity.podId !== config.podId ||
          identity.containerId !== config.containerId ||
          identity.model !== (config.reviewerModel ?? 'auto') ||
          identity.runtime !== selectedRuntime
        )
          throw new TaskRetryBlockedError(
            'Reviewer launch identity differs from the frozen validation configuration.',
          );
        await recordValidationProvenance(config, 'review', ownership.assertCurrent, identity);
        return () => {
          resolveEffectiveBoundProfile(ownership.assertCurrent());
        };
      },
    };
  }

  return { recordValidationProvenance, withReviewerLaunchPreflight };
}
