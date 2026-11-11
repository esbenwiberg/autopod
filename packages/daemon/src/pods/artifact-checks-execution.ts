import path from 'node:path';
import type { EffectiveLaunchConfig, Pod, ValidationResult } from '@autopod/shared';
import { configurationDigest } from '../configuration/configuration-digest.js';
import type { DockerNetworkManager } from '../containers/docker-network-manager.js';
import type { ContainerManager } from '../interfaces/container-manager.js';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import type { ReviewerExecutor } from '../interfaces/reviewer-executor.js';
import type { ValidationEngine, ValidationEngineConfig } from '../interfaces/validation-engine.js';
import { daemonRelease } from '../release.js';
import { createArtifactExecutionBoundary } from '../validation/artifact-execution-boundary.js';
import type { createArtifactChecksRecovery } from './artifact-checks-recovery.js';
import { artifactChecksError } from './artifact-checks-recovery-repository.js';
import { verifyArtifactExecutionSource } from './artifact-checks-source.js';
import { collectArtifactSnapshot } from './artifact-preservation.js';
import {
  fingerprintArtifactSnapshot,
  verifyArtifactSnapshot,
} from './artifact-snapshot-receipt.js';
import { inspectExecutionPreflight } from './execution-preflight.js';
import type { PodRepository } from './pod-repository.js';
import { resolveReviewerModel, resolveReviewerProvider } from './runtime-resolver.js';
import { requiresValidationSettlement } from './validation-recovery-policy.js';
import { getPodValidationSkipPhases } from './validation-workflow-policy.js';

type Execute = Parameters<typeof createArtifactChecksRecovery>[0]['execute'];
/** A deliberately separate artifact execution: no Git, agent shim, session, MCP,
 * publication or correction worker. Native reviewer accounting stays on the task.
 */
export function createArtifactChecksExecution(deps: {
  podRepo: PodRepository;
  cm: ContainerManager;
  network?: Pick<DockerNetworkManager, 'buildNetworkConfig'>;
  prepareEnvironment(launch: EffectiveLaunchConfig): Promise<string>;
  assertCapabilities(launch: EffectiveLaunchConfig): Promise<void>;
  executionForPod(pod: Pod): PodExecutionSettings;
  reviewer(pod: Pod): {
    profile: PodExecutionSettings;
    credentials: ValidationEngineConfig['reviewerProviderCredentials'];
  };
  reviewerExecutor(pod: Pod): ReviewerExecutor | undefined;
  engine: ValidationEngine;
  logger: import('pino').Logger;
}): Execute {
  return async (input) => {
    const { pod, launch, assertCurrent, record } = input;
    const profile = deps.executionForPod(pod);
    await deps.assertCapabilities(launch);
    assertCurrent();
    const image = await deps.prepareEnvironment(launch);
    if (!/^sha256:[a-f0-9]{64}$/.test(image))
      artifactChecksError('Immutable Docker execution image required');
    assertCurrent();
    const identity = `${pod.id}-artifact-checks-${configurationDigest(input.operationId).slice(0, 20)}`;
    const policy = profile.networkPolicy;
    if (policy?.enabled && !deps.network)
      artifactChecksError('Frozen network isolation unavailable');
    const network = policy?.enabled
      ? await deps.network!.buildNetworkConfig(
          policy,
          [],
          '127.0.0.1',
          [],
          identity,
          [],
          [],
          0,
          false,
        )
      : null;
    if (policy?.enabled && !network) artifactChecksError('Frozen network isolation unavailable');
    assertCurrent();
    const containerId = await deps.cm.spawn({
      image,
      podId: pod.id,
      resourceIdentity: identity,
      env: { PORT: '3000', HOST: '0.0.0.0' },
      ports: [],
      volumes: [{ host: input.workspace, container: '/workspace' }],
      exposeHostGateway: false,
      workingDir: '/workspace',
      networkName: network?.networkName,
      firewallScript: network?.firewallScript,
      networkPolicyMode: policy?.enabled ? (policy.mode ?? 'restricted') : undefined,
      memoryBytes: launch.resolvedExecution.main.memoryGb * 1024 ** 3,
      nanoCpus:
        launch.resolvedExecution.main.cpus === null
          ? undefined
          : launch.resolvedExecution.main.cpus * 1e9,
      onCreated: (id) => {
        assertCurrent();
        record('allocated', { containerId: id, image, identity });
      },
    });
    assertCurrent();
    if (containerId === pod.containerId)
      artifactChecksError('Checks require a separate execution resource');
    const metadata = await deps.cm.getExecutionMetadata!(containerId);
    const resourceKey = await deps.cm.getResourceKey!(containerId);
    deps.podRepo.validationExecutions?.assertResourceUnshared(pod.id, containerId);
    const requirements = pod.contract!.executionRequirements!;
    if (
      !resourceKey ||
      metadata.imageDigest !== image ||
      metadata.podId !== pod.id ||
      metadata.resourceIdentity !== identity ||
      !metadata.memoryLimitBytes ||
      metadata.memoryLimitBytes < launch.resolvedExecution.main.memoryGb * 1024 ** 3 ||
      (requirements.minimumMemoryBytes &&
        metadata.memoryLimitBytes < requirements.minimumMemoryBytes) ||
      (requirements.minimumCpu &&
        (!metadata.cpuLimit || metadata.cpuLimit < requirements.minimumCpu))
    )
      artifactChecksError('Actual independent execution identity/capacity is unqualified');
    const qualification = createArtifactExecutionBoundary(deps.cm, assertCurrent);
    const preflight = await inspectExecutionPreflight(
      qualification.manager,
      containerId,
      pod,
      profile,
      'validation',
      'worker',
      {
        assertCurrent,
        user: 'autopod',
        probeNodePath: '/usr/local/bin/node',
        stopOnProbeError: true,
      },
    );
    const context = await qualification.manager.execInContainer(
      containerId,
      [
        '/usr/local/bin/node',
        '-e',
        "process.stdout.write(JSON.stringify({platform:process.platform+'/'+({x64:'amd64',arm64:'arm64'}[process.arch]||process.arch),uid:process.getuid(),cwd:process.cwd()}))",
      ],
      { user: 'autopod', cwd: '/workspace', timeout: 10_000, maxOutputBytes: 4096, assertCurrent },
    );
    qualification.assertVerified();
    const observed = context.exitCode === 0 ? JSON.parse(context.stdout) : null;
    if (
      !observed ||
      observed.platform !== launch.resolvedEnvironment.platform ||
      observed.uid !== 1000 ||
      observed.cwd !== '/workspace' ||
      (requirements.version === 2 &&
        requirements.platform &&
        observed.platform !== requirements.platform)
    )
      artifactChecksError('Actual execution platform/user/context is unqualified');
    if (
      preflight.status !== 'checked' ||
      preflight.commands.requirements.some((r) => r.available !== true)
    )
      artifactChecksError('Frozen execution prerequisites remain unqualified');
    deps.podRepo.executionProvenance?.record(pod.id, pod.lifecycleGeneration, preflight);
    record('qualified', { resourceKey, metadata, preflight });
    const reviewer = deps.reviewer(pod);
    const executor =
      deps.reviewerExecutor(pod) ?? artifactChecksError('Independent frozen reviewer unavailable');
    const verifySource = async () => {
      assertCurrent();
      await verifyArtifactSnapshot(
        input.snapshot,
        path.dirname(input.snapshot),
        pod.lifecycleGeneration,
        pod.finalization!.cycle,
        input.sourceHash,
      );
      await verifyArtifactExecutionSource(input.snapshot, input.workspace, assertCurrent);
      await verifyArtifactSnapshot(
        input.snapshot,
        path.dirname(input.snapshot),
        pod.lifecycleGeneration,
        pod.finalization!.cycle,
        input.sourceHash,
      );
      assertCurrent();
    };
    const config: ValidationEngineConfig = {
      podId: pod.id,
      containerId,
      executionTarget: 'local',
      previewUrl: 'http://127.0.0.1:3000',
      attempt: pod.validationAttempts + 1,
      task: pod.task,
      diff: input.diff,
      validationSuite: 'full',
      validationSetupCommand: profile.validationSetupCommand,
      buildCommand: profile.buildCommand ?? '',
      startCommand: profile.startCommand ?? '',
      buildWorkDir: profile.buildWorkDir,
      healthPath: profile.healthPath ?? '/',
      healthTimeout: profile.healthTimeout ?? 120,
      smokePages: profile.smokePages,
      testCommand: profile.testCommand,
      buildTimeout: (profile.buildTimeout ?? 300) * 1000,
      testTimeout: (profile.testTimeout ?? 600) * 1000,
      lintCommand: profile.lintCommand,
      lintTimeout: (profile.lintTimeout ?? 120) * 1000,
      sastCommand: profile.sastCommand,
      sastTimeout: (profile.sastTimeout ?? 300) * 1000,
      reviewerModel: resolveReviewerModel(reviewer.profile, deps.logger),
      reviewerProvider: resolveReviewerProvider(reviewer.profile),
      reviewerProviderAccountId: reviewer.profile.providerAccountId,
      reviewerProviderCredentials: reviewer.credentials,
      reviewerExecutor: executor,
      assertReviewerCurrent: () => {
        assertCurrent();
      },
      artifactSource: {
        sha256: input.sourceHash,
        assertCurrent,
        verify: verifySource,
      },
      contract: pod.contract ?? undefined,
      hasWebUi: false,
      worktreePath: input.snapshot,
      plan: pod.plan ?? undefined,
      taskSummary: pod.taskSummary ?? undefined,
      skipPhases: getPodValidationSkipPhases(profile, pod),
      extraExecEnv: profile.buildEnv ?? undefined,
      nonSecretExecEnv: profile.buildEnv ?? undefined,
    };
    await deps.assertCapabilities(launch);
    assertCurrent();
    if ((await fingerprintArtifactSnapshot(input.workspace)).sha256 !== input.sourceHash)
      artifactChecksError('Independent execution source changed before check dispatch');
    const retries =
      deps.podRepo.taskRetries ?? artifactChecksError('Task retry accounting unavailable');
    const admission = retries.admit(
      pod.id,
      pod.lifecycleGeneration,
      {
        source: input.sourceHash,
        contract: configurationDigest(pod.contract),
        commands: configurationDigest([
          profile.validationSetupCommand,
          profile.buildCommand,
          profile.testCommand,
          profile.lintCommand,
          profile.sastCommand,
        ]),
        environment: launch.digest,
        implementation: configurationDigest(daemonRelease),
      },
      configurationDigest([input.operationId, resourceKey, launch.ai]),
      [],
    );
    record('admission', { id: admission.id, containerId, sourceHash: input.sourceHash });
    retries.start(admission.id);
    const started = performance.now();
    let result: ValidationResult;
    try {
      result = await deps.engine.validate(config);
    } catch (error) {
      // Unknown execution stays owned and unverified. No automatic second dispatch.
      retries.finish(admission.id, 'unknown', Math.round(performance.now() - started));
      throw error;
    }
    record('engineResult', { result, sourceHash: input.sourceHash, resourceKey });
    if (requiresValidationSettlement({ lastValidationResult: result })) {
      retries.finish(admission.id, 'unknown', Math.round(performance.now() - started));
      artifactChecksError(
        'Checks termination is unverified; retain the exact execution and inspect its saved evidence',
      );
    }
    let sourceVerified = true;
    let sourceError: unknown;
    const prove = async (verify: () => Promise<unknown>) => {
      try {
        await verify();
      } catch (error) {
        sourceVerified = false;
        sourceError ??= error;
      }
    };
    await prove(verifySource);
    // Retain reports even after known source drift. Do not settle pass until
    // the exported source AND live copy both prove the selected input again.
    await prove(async () => {
      const reports = await collectArtifactSnapshot({
        containerManager: deps.cm,
        containerId,
        artifactRoot: path.dirname(input.workspace),
        generation: pod.lifecycleGeneration,
        cycle: pod.finalization!.cycle,
        isCurrent: () => {
          assertCurrent();
          return true;
        },
      });
      record('reports', { path: reports, containerId, sourceHash: input.sourceHash });
      await verifyArtifactExecutionSource(input.snapshot, reports, assertCurrent);
    });
    await prove(verifySource);
    record(sourceVerified ? 'sourceVerified' : 'sourceRejected', { sourceHash: input.sourceHash });
    retries.finish(
      admission.id,
      sourceVerified && result.overall === 'pass' ? 'pass' : 'nonretryable',
      Math.round(performance.now() - started),
    );
    if (!sourceVerified)
      throw sourceError instanceof Error
        ? sourceError
        : new Error('Independent execution source could not be verified');
    return result;
  };
}
