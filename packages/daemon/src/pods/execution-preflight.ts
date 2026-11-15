import { createHash } from 'node:crypto';
import {
  AutopodError,
  DEFAULT_CONTAINER_MEMORY_GB,
  type ExecutionProvenanceInput,
  type Pod,
} from '@autopod/shared';
import type {
  ContainerExecutionMetadata,
  ContainerManager,
} from '../interfaces/container-manager.js';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import { daemonRelease } from '../release.js';
import { describeAgentCliProbeFailure, verifyAgentCli } from '../runtimes/agent-cli-preflight.js';
import { inspectRequiredCommands } from './required-command-preflight.js';

/** Read-only CLI probes retried when no answer was observed (exec timeout/transport). */
export const AGENT_CLI_PROBE_ATTEMPTS = 3;

export interface ExecutionPreflightOptions {
  assertCurrent?: () => void;
  user?: string;
  probeNodePath?: string;
  /** Qualification never dispatches another probe after an uncertain CLI/metadata observation. */
  stopOnProbeError?: boolean;
}

/** Read-only pre-agent evidence. Unknown capabilities are explicit diagnostics. */
export async function inspectExecutionPreflight(
  cm: ContainerManager,
  containerId: string,
  pod: Pod,
  profile: PodExecutionSettings,
  purpose: NonNullable<ExecutionProvenanceInput['purpose']> = 'coding',
  subject: NonNullable<ExecutionProvenanceInput['subject']> = 'worker',
  options: ExecutionPreflightOptions = {},
): Promise<ExecutionProvenanceInput> {
  options.assertCurrent?.();
  const result: ExecutionProvenanceInput = {
    version: 1,
    purpose,
    subject,
    status: 'checked',
    runtime: pod.runtime,
    model: pod.model,
    providerId: pod.providerIdSnapshot ?? null,
    providerAccountId: pod.providerAccountIdSnapshot ?? null,
    release: daemonRelease,
    cliPath: null,
    cliVersion: null,
    imageDigest: null,
    contractHash: createHash('sha256')
      .update(JSON.stringify(pod.contract ?? null))
      .digest('hex'),
    validationImplementationHash: daemonRelease.validationImplementationHash ?? null,
    capabilities: {
      streamingExec:
        cm.supportsStreamingExec === undefined
          ? 'unverified'
          : cm.supportsStreamingExec
            ? 'supported'
            : 'unsupported',
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
    diagnostics: [],
  };
  const requirements = pod.contract?.executionRequirements;
  const workerRequirementsApply =
    subject === 'worker' && (purpose === 'coding' || purpose === 'validation');
  // v1 keeps its historical phase behavior. v2 describes the worker, not an isolated reviewer.
  const declared =
    purpose !== 'completion' && (requirements?.version !== 2 || workerRequirementsApply)
      ? requirements
      : undefined;
  if (declared?.version === 2) {
    if (declared.requiresImageBuild) {
      result.status = 'blocked';
      result.diagnostics.push({
        code: 'PREFLIGHT_IMAGE_BUILD_UNSUPPORTED',
        detail:
          'Worker image-build operations are not qualified. Docker presence/connectivity and capability labels cannot satisfy this requirement.',
      });
    }
    if (
      !pod.launchConfigDigest &&
      (declared.platform || declared.requiredReferenceRepositories?.length)
    ) {
      result.status = 'blocked';
      result.diagnostics.push({
        code: 'PREFLIGHT_FROZEN_REQUIREMENTS_UNVERIFIED',
        detail:
          'Strict platform/reference prerequisites require frozen launch admission. Preview and launch with the exact environment and enrolled reference revisions; legacy worker metadata is not qualification.',
      });
    }
  }
  const requiresCli = purpose === 'coding' || subject === 'reviewer';
  try {
    Object.assign(
      result,
      await verifyAgentCli(cm, containerId, pod.runtime, pod.model, {
        ...(options.assertCurrent ? { assertCurrent: options.assertCurrent } : {}),
        // Qualification never re-dispatches after an uncertain observation.
        ...(options.stopOnProbeError ? {} : { transientAttempts: AGENT_CLI_PROBE_ATTEMPTS }),
        ...(options.user ? { maxOutputBytes: 65536 } : {}),
        ...(options.user
          ? {
              user: options.user,
              cwd: profile.buildWorkDir ? `/workspace/${profile.buildWorkDir}` : '/workspace',
              ...(profile.buildEnv ? { env: profile.buildEnv } : {}),
            }
          : {}),
      }),
    );
    options.assertCurrent?.();
  } catch (error) {
    options.assertCurrent?.();
    if (options.stopOnProbeError) throw error;
    if (requiresCli) result.status = 'blocked';
    result.diagnostics.push({
      code: !requiresCli
        ? 'WORKER_CLI_NOT_REQUIRED'
        : error instanceof AutopodError
          ? error.code
          : 'PREFLIGHT_RUNTIME_UNAVAILABLE',
      detail: !requiresCli
        ? 'Configured worker CLI is unavailable; this phase does not start a coding agent.'
        : error instanceof AutopodError
          ? error.message
          : `Runtime CLI probe unavailable after ${AGENT_CLI_PROBE_ATTEMPTS} attempts (${describeAgentCliProbeFailure(error)}); inspect container connectivity and image capabilities.`,
    });
  }
  try {
    options.assertCurrent?.();
    const metadata = await boundedMetadata(cm, containerId);
    options.assertCurrent?.();
    if (metadata) {
      result.imageDigest =
        metadata.imageDigest && /^sha256:[a-f0-9]{64}$/.test(metadata.imageDigest)
          ? metadata.imageDigest
          : null;
      result.capabilities.memoryLimitBytes =
        Number.isSafeInteger(metadata.memoryLimitBytes) && (metadata.memoryLimitBytes ?? 0) > 0
          ? metadata.memoryLimitBytes
          : null;
      result.capabilities.cpuLimit =
        Number.isFinite(metadata.cpuLimit) && (metadata.cpuLimit ?? 0) > 0
          ? metadata.cpuLimit
          : null;
      result.capabilities.networkMode =
        typeof metadata.networkMode === 'string' && metadata.networkMode.length <= 256
          ? metadata.networkMode
          : null;
      const required = Math.max(
        (profile.containerMemoryGb ?? DEFAULT_CONTAINER_MEMORY_GB) * 1024 ** 3,
        declared?.minimumMemoryBytes ?? 0,
      );
      if (
        purpose !== 'completion' &&
        result.capabilities.memoryLimitBytes !== null &&
        result.capabilities.memoryLimitBytes < required
      ) {
        result.status = 'blocked';
        result.diagnostics.push({
          code: 'PREFLIGHT_INSUFFICIENT_MEMORY',
          detail: `Effective container memory ${metadata.memoryLimitBytes} bytes is below required ${required} bytes. Reconcile the requirement or execution target.`,
        });
      }
    }
  } catch (error) {
    options.assertCurrent?.();
    if (options.stopOnProbeError) throw error;
    result.diagnostics.push({
      code: 'ENVIRONMENT_METADATA_UNAVAILABLE',
      detail: 'Backend environment metadata could not be read.',
    });
  }
  if (purpose !== 'completion' && purpose !== 'review')
    result.commands = await inspectRequiredCommands(
      cm,
      containerId,
      requirements?.version === 2 && !workerRequirementsApply && pod.contract
        ? { ...pod, contract: { ...pod.contract, executionRequirements: undefined } }
        : pod,
      profile,
      options,
    );
  options.assertCurrent?.();
  for (const requirement of result.commands.requirements) {
    const strict =
      declared?.version === 2 && requirement.source === 'contract.executionRequirements';
    // Preserve v1's advisory unknowns. v2 only makes explicitly declared launchers mandatory;
    // static inference is not a complete requirement declaration or execution proof.
    const mandatory = declared?.version !== 2 || strict;
    if (requirement.available === false && mandatory) {
      result.status = 'blocked';
      result.diagnostics.push({
        code: 'PREFLIGHT_COMMAND_UNAVAILABLE',
        detail: `Required launcher ${requirement.executable} (${requirement.source}) is missing. Reconcile the image or declared command before ${purpose}.`,
      });
    } else if (requirement.available === null && strict) {
      result.status = 'blocked';
      result.diagnostics.push({
        code: 'PREFLIGHT_COMMAND_UNVERIFIED',
        detail: `Explicit strict launcher ${requirement.executable} is unverified; the read-only probe returned no usable result. Reconcile the image or probe before ${purpose}.`,
      });
    } else if (requirement.available === null) {
      result.diagnostics.push({
        code: 'COMMAND_AVAILABILITY_UNVERIFIED',
        detail: `Launcher ${requirement.executable} (${requirement.source}) is unverified; the read-only probe returned no usable result. Execution remains a validation gate.`,
      });
    } else if (requirement.available === false) {
      result.diagnostics.push({
        code: 'INFERRED_COMMAND_UNAVAILABLE',
        detail: `Inferred launcher ${requirement.executable} (${requirement.source}) is missing. Declare strict prerequisites explicitly; actual script execution remains a validation gate.`,
      });
    }
  }
  if (result.commands.unresolvedSources.length) {
    // Static discovery bails on ordinary shell structure (`cd`, `$VAR`, `if`,
    // redirects). That proves nothing about availability, so it stays advisory
    // evidence and never blocks startup.
    result.diagnostics.push({
      code: result.commands.explicitDependencies
        ? 'COMMAND_DISCOVERY_PARTIAL'
        : 'COMMAND_DECLARATION_RECOMMENDED',
      detail: `Static launcher discovery could not resolve ${formatUnresolvedSources(
        result.commands.unresolvedSources,
      )}. Declare contract.executionRequirements.executables to verify those launchers. ${
        declared?.version === 2
          ? 'Explicit v2 launchers gate preflight; inferred availability remains advisory. Actual script execution remains a validation gate.'
          : 'Launcher availability is advisory; actual script execution remains a validation gate.'
      }`,
    });
  }
  if (
    (declared?.minimumMemoryBytes && result.capabilities.memoryLimitBytes === null) ||
    (declared?.minimumCpu &&
      (result.capabilities.cpuLimit === null || result.capabilities.cpuLimit < declared.minimumCpu))
  ) {
    result.status = 'blocked';
    result.diagnostics.push({
      code: 'PREFLIGHT_RESOURCE_REQUIREMENT_UNVERIFIED',
      detail:
        'Explicit resource requirements are unavailable or exceed effective limits. Reconcile the environment before coding.',
    });
  }
  if (purpose === 'coding' && result.capabilities.streamingExec === 'unsupported') {
    result.status = 'blocked';
    result.diagnostics.push({
      code: 'STREAMING_EXEC_UNSUPPORTED',
      detail: 'This backend cannot stream the coding agent.',
    });
  }
  if (!result.imageDigest)
    result.diagnostics.push({
      code: 'IMAGE_IDENTITY_UNAVAILABLE',
      detail: 'Actual image digest is unverified.',
    });
  if (result.capabilities.memoryLimitBytes === null)
    result.diagnostics.push({
      code: 'MEMORY_CAPACITY_UNVERIFIED',
      detail: 'Effective memory capacity is unverified.',
    });
  if (!result.release.commitSha || !result.validationImplementationHash)
    result.diagnostics.push({
      code: 'RELEASE_IDENTITY_INCOMPLETE',
      detail: 'Build release or validation implementation identity is unavailable.',
    });
  options.assertCurrent?.();
  return result;
}

/** Bounded operator-facing list of the sources static discovery could not resolve. */
function formatUnresolvedSources(sources: string[]): string {
  const shown = sources.slice(0, 8).map((source) => source.replace(/\s+/g, ' ').slice(0, 64));
  const omitted = sources.length - shown.length;
  return omitted > 0 ? `${shown.join(', ')} (+${omitted} more)` : shown.join(', ');
}

async function boundedMetadata(
  cm: ContainerManager,
  containerId: string,
): Promise<ContainerExecutionMetadata | undefined> {
  if (!cm.getExecutionMetadata) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      cm.getExecutionMetadata(containerId),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Metadata probe timed out')), 15000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
