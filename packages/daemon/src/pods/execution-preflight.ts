import { createHash } from 'node:crypto';
import {
  AutopodError,
  DEFAULT_CONTAINER_MEMORY_GB,
  type ExecutionProvenanceInput,
  type Pod,
  type Profile,
} from '@autopod/shared';
import type {
  ContainerExecutionMetadata,
  ContainerManager,
} from '../interfaces/container-manager.js';
import { daemonRelease } from '../release.js';
import { verifyAgentCli } from '../runtimes/agent-cli-preflight.js';
import { inspectRequiredCommands } from './required-command-preflight.js';

/** Read-only pre-agent evidence. Unknown capabilities are explicit diagnostics. */
export async function inspectExecutionPreflight(
  cm: ContainerManager,
  containerId: string,
  pod: Pod,
  profile: Profile,
): Promise<ExecutionProvenanceInput> {
  const result: ExecutionProvenanceInput = {
    version: 1,
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
  try {
    Object.assign(result, await verifyAgentCli(cm, containerId, pod.runtime));
  } catch (error) {
    result.status = 'blocked';
    result.diagnostics.push({
      code: error instanceof AutopodError ? error.code : 'PREFLIGHT_RUNTIME_UNAVAILABLE',
      detail:
        error instanceof AutopodError
          ? error.message
          : 'Runtime CLI probe unavailable; inspect container connectivity and image capabilities.',
    });
  }
  try {
    const metadata = await boundedMetadata(cm, containerId);
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
        pod.contract?.executionRequirements?.minimumMemoryBytes ?? 0,
      );
      if (
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
  } catch {
    result.diagnostics.push({
      code: 'ENVIRONMENT_METADATA_UNAVAILABLE',
      detail: 'Backend environment metadata could not be read.',
    });
  }
  result.commands = await inspectRequiredCommands(cm, containerId, pod, profile);
  for (const requirement of result.commands.requirements) {
    if (requirement.available !== true) {
      result.status = 'blocked';
      result.diagnostics.push({
        code: 'PREFLIGHT_COMMAND_UNAVAILABLE',
        detail: `Required launcher ${requirement.executable} (${requirement.source}) is ${requirement.available === false ? 'missing' : 'unverified'}. Reconcile the image or declared command before coding.`,
      });
    }
  }
  if (result.commands.unresolvedSources.length) {
    if (!result.commands.explicitDependencies) result.status = 'blocked';
    result.diagnostics.push({
      code: result.commands.explicitDependencies
        ? 'COMMAND_DISCOVERY_PARTIAL'
        : 'PREFLIGHT_COMMAND_DECLARATION_REQUIRED',
      detail:
        'Dynamic shell commands require explicit executionRequirements.executables in the contract. Only launcher availability is verified; actual script execution remains a validation gate.',
    });
  }
  const declared = pod.contract?.executionRequirements;
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
  if (result.capabilities.streamingExec === 'unsupported') {
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
  return result;
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
