import { createHash } from 'node:crypto';
import type { ExecutionProvenanceInput } from '@autopod/shared';
import type { ValidationEngineConfig } from '../interfaces/validation-engine.js';
import { daemonRelease } from '../release.js';

export function reviewerApiProvenance(
  config: ValidationEngineConfig,
  dispatchModel: string,
): ExecutionProvenanceInput {
  return {
    version: 2,
    surface: 'provider-api',
    purpose: 'review',
    subject: 'reviewer',
    status: 'checked',
    runtime: null,
    model: config.reviewerModel ?? 'auto',
    dispatchModel,
    providerId: config.reviewerProvider ?? 'anthropic',
    providerAccountId: config.reviewerProviderAccountId ?? null,
    release: daemonRelease,
    cliPath: null,
    cliVersion: null,
    imageDigest: null,
    contractHash: createHash('sha256')
      .update(JSON.stringify(config.contract ?? null))
      .digest('hex'),
    validationImplementationHash: daemonRelease.validationImplementationHash ?? null,
    capabilities: {
      streamingExec: 'unverified',
      memoryLimitBytes: null,
      cpuLimit: null,
      networkMode: null,
    },
    commands: {
      requirements: [],
      unresolvedSources: [],
      deferredArtifacts: [],
      explicitDependencies: false,
    },
    diagnostics: [
      {
        code: 'REVIEWER_API_DISPATCH_PREFLIGHT',
        detail:
          'Selected profile API client prepared for dispatch. This local receipt does not prove a provider response, billed execution or completion. CLI and container image are not applicable; API client version and remote capabilities are unverified.',
      },
    ],
  };
}

/** The legacy SDK may inherit an endpoint from the environment; no profile identity is asserted. */
export function legacyReviewerApiProvenance(
  config: ValidationEngineConfig,
  dispatchModel: string,
): ExecutionProvenanceInput {
  return {
    ...reviewerApiProvenance(config, dispatchModel),
    providerId: null,
    providerAccountId: null,
    diagnostics: [
      {
        code: 'REVIEWER_LEGACY_API_DISPATCH_PREFLIGHT',
        detail:
          'Legacy daemon API-key client prepared for dispatch. Provider, endpoint and account identity are unverified; this receipt does not establish the worker profile binding or prove a provider response, billed execution or completion. CLI and container image are not applicable; API client version and remote capabilities are unverified.',
      },
    ],
  };
}
