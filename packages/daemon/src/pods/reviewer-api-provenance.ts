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

/** Host CLI credentials may come from local state; the worker account is not asserted. */
export function reviewerHostCliProvenance(
  config: ValidationEngineConfig,
  evidence: import('../runtimes/host-cli-provenance.js').HostCliDispatchEvidence,
): ExecutionProvenanceInput {
  return {
    ...legacyReviewerApiProvenance(config, evidence.model),
    surface: 'host-cli',
    runtime: 'claude',
    status: evidence.status,
    cliPath: evidence.cliPath,
    cliVersion: evidence.cliVersion,
    diagnostics: [
      {
        code:
          evidence.status === 'checked'
            ? 'REVIEWER_HOST_CLI_DISPATCH_PREFLIGHT'
            : 'PREFLIGHT_HOST_CLI_UNAVAILABLE',
        detail:
          evidence.status === 'checked'
            ? 'Host reviewer CLI version observed at the selected executable path before dispatch. Provider/account identity, resolved model, binary hash and transitive dependencies are unverified. Container image is not applicable. This receipt does not prove a provider response, billing or review completion.'
            : 'Host reviewer CLI identity could not be verified; review dispatch is blocked. Reconcile the installed CLI. Provider/account identity remains unverified; container image is not applicable.',
      },
    ],
  };
}
