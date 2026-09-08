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
