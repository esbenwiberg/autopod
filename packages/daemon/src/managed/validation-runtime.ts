import { readFileSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ManagedPodRequest, SourceCandidateReceipt, ValidationPhase } from '@autopod/shared';
import { z } from 'zod';
import type { ContainerManager, ContainerSpawnConfig } from '../interfaces/container-manager.js';
import type { ValidationPhaseCallbacks } from '../interfaces/validation-engine.js';
import { canonical, digest } from './canonical.js';
import { managedGit } from './source-git.js';
import type {
  ManagedValidationConfig,
  ManagedValidationPort,
  ManagedValidationRunResult,
} from './validation.js';

const commandPhaseSchema = z.enum(['setup', 'lint', 'sast', 'build', 'test']);
export const managedValidationConfigSchema = z
  .object({
    phases: z
      .array(
        z
          .object({
            phase: commandPhaseSchema,
            command: z.string().min(1).max(4096),
            timeoutMs: z.number().int().min(1000).max(600000),
          })
          .strict(),
      )
      .min(1)
      .max(5),
    workingDirectory: z
      .string()
      .max(512)
      .regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_./-]*$/),
  })
  .strict()
  .superRefine((configuration, context) => {
    const phases = configuration.phases.map(({ phase }) => phase);
    if (new Set(phases).size !== phases.length) {
      context.addIssue({ code: 'custom', message: 'Managed validation phases must be unique' });
    }
  });

export interface ManagedValidationBoundary {
  route: ManagedPodRequest['route'];
  profileId?: string;
  manager: ContainerManager;
  image: string;
  configuration: ManagedValidationConfig;
  dependencyCache?: { enrollmentId: string; path: string };
  sourceWorkspace(podId: string, repositoryId: string): string;
  network(request: ManagedPodRequest): Pick<ContainerSpawnConfig, 'firewallScript' | 'networkName'>;
}

interface SupervisorSnapshot {
  specDigest: string;
  configurationDigest: string;
  candidateDigest: string;
  newCommit: string;
  state: 'claimed' | 'running' | 'stopped';
  observedExit: boolean;
  startedAt: number;
  completedAt: number;
  phases: Array<{
    phase: ManagedValidationConfig['phases'][number]['phase'];
    status: 'not-run' | 'running' | 'passed' | 'failed';
    durationMs: number;
  }>;
  result: 'running' | 'passed' | 'failed' | 'unavailable';
  reason: string;
}

const supervisorSnapshotSchema = z
  .object({
    specDigest: z.string(),
    configurationDigest: z.string(),
    candidateDigest: z.string(),
    newCommit: z.string(),
    state: z.enum(['claimed', 'running', 'stopped']),
    observedExit: z.boolean(),
    startedAt: z.number().int().nonnegative(),
    completedAt: z.number().int().nonnegative(),
    phases: z.array(
      z
        .object({
          phase: commandPhaseSchema,
          status: z.enum(['not-run', 'running', 'passed', 'failed']),
          durationMs: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    result: z.enum(['running', 'passed', 'failed', 'unavailable']),
    reason: z.enum([
      '',
      'command-failed',
      'command-start-failed',
      'dependency-cache-untrusted',
      'expired',
      'phase-timeout',
      'revoked',
      'source-mutated',
      'workspace-preparation-failed',
    ]),
  })
  .strict();

const ROOT_WRITE = `import os,sys
p=sys.argv[1]; os.makedirs(os.path.dirname(p),mode=0o700,exist_ok=True)
fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
with os.fdopen(fd,'w') as f: f.write(sys.argv[2]); f.flush(); os.fsync(f.fileno())
`;

const wait = (durationMs: number) => new Promise((resolve) => setTimeout(resolve, durationMs));

/** Dedicated validation resource with a detached root-owned supervisor and one-start receipt. */
export class ManagedSupervisedValidation implements ManagedValidationPort {
  constructor(
    readonly boundaries: readonly ManagedValidationBoundary[],
    private readonly supervisorSource = readFileSync(
      fileURLToPath(new URL('./runtime/validation-supervisor.py', import.meta.url)),
      'utf8',
    ),
  ) {}

  private configuration(boundary: ManagedValidationBoundary): ManagedValidationConfig {
    try {
      return managedValidationConfigSchema.parse(boundary.configuration);
    } catch {
      throw new Error('managed-validation-configuration-invalid');
    }
  }

  private boundary(request: ManagedPodRequest): ManagedValidationBoundary {
    const matches = this.boundaries.filter(
      (boundary) =>
        canonical(boundary.route) === canonical(request.route) &&
        (boundary.profileId === undefined ||
          boundary.profileId === request.profileSnapshot.profileId),
    );
    const boundary = matches[0];
    if (matches.length !== 1 || !boundary) throw new Error('managed-validation-route-unavailable');
    return boundary;
  }

  preflight(
    request: ManagedPodRequest,
  ): readonly Exclude<ValidationPhase, 'review' | 'advisory'>[] {
    const boundary = this.boundary(request);
    const configuration = this.configuration(boundary);
    const choice = request.validation.autopod;
    if (
      choice?.mode !== 'deterministic' ||
      choice.configurationDigest !== digest(configuration) ||
      !boundary.manager.ensureManagedContainer ||
      !boundary.image.includes('@sha256:') ||
      process.env.AUTOPOD_FAIL_OPEN_FIREWALL === '1'
    )
      throw new Error('managed-validation-enforcement-unavailable');
    const phases = configuration.phases.map((phase) => phase.phase);
    if (new Set(phases).size !== phases.length)
      throw new Error('managed-validation-phases-invalid');
    const repository = request.effectiveGrant.scope.repositories.find(
      (item) => item.enrollmentId === request.outputs.source.repository,
    );
    if (!repository || repository.access !== 'write')
      throw new Error('managed-validation-source-required');
    if (
      boundary.dependencyCache &&
      (boundary.dependencyCache.enrollmentId !== repository.enrollmentId ||
        !/^\/opt\/autopod-managed\/[A-Za-z0-9_.-]+\/node_modules$/.test(
          boundary.dependencyCache.path,
        ))
    )
      throw new Error('managed-validation-dependency-cache-binding');
    const network = boundary.network(request);
    if (
      request.route.executionTarget === 'local' &&
      (!network.firewallScript || !network.networkName)
    )
      throw new Error('managed-validation-network-unavailable');
    return phases;
  }

  async run(
    request: ManagedPodRequest,
    candidate: SourceCandidateReceipt,
    deadline: number,
    callbacks: ValidationPhaseCallbacks,
    signal: AbortSignal,
    checkpoint: (containerId: string) => void,
  ): Promise<ManagedValidationRunResult> {
    this.preflight(request);
    if (!Number.isSafeInteger(deadline) || deadline <= Math.floor(Date.now() / 1000))
      throw new Error('managed-validation-deadline-expired');
    const boundary = this.boundary(request);
    const configuration = this.configuration(boundary);
    const repositoryId = request.outputs.source.repository;
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(repositoryId))
      throw new Error('managed-validation-source-unavailable');
    const source = boundary.sourceWorkspace(candidate.podId, repositoryId);
    if (
      !path.isAbsolute(source) ||
      (await lstat(source)).isSymbolicLink() ||
      (await realpath(source)) !== source
    )
      throw new Error('managed-validation-source-unavailable');
    const assertSource = async () => {
      if (
        (await managedGit(source, ['rev-parse', '--verify', 'HEAD^{commit}'])) !==
          candidate.newCommit ||
        (await managedGit(source, [
          '-c',
          'core.filemode=false',
          'status',
          '--porcelain',
          '--untracked-files=all',
        ]))
      )
        throw new Error('managed-validation-source-mismatch');
    };
    await assertSource();
    if (signal.aborted) throw new Error('managed-validation-interrupted');
    const ensure = boundary.manager.ensureManagedContainer;
    if (!ensure) throw new Error('managed-validation-allocation-unavailable');
    const resourceDigest = digest({
      executionSpecDigest: request.executionSpecDigest,
      configurationDigest: request.validation.autopod?.configurationDigest,
      candidateDigest: candidate.candidateDigest,
    });
    const resourceId = `managed-validation-${candidate.podId.replace(/^managed-/, '')}`;
    const ref = await ensure.call(boundary.manager, {
      ...boundary.network(request),
      podId: resourceId,
      managedSpecDigest: resourceDigest,
      image: boundary.image,
      env: {},
      exposeHostGateway: false,
      networkPolicyMode: request.effectiveGrant.scope.network.destinations.length
        ? 'restricted'
        : 'deny-all',
      allowedHosts: [...request.effectiveGrant.scope.network.destinations],
      volumes: [{ host: source, container: `/repositories/${repositoryId}`, readOnly: true }],
      workingDir: '/tmp',
      onCreated: checkpoint,
    });
    await assertSource();
    checkpoint(ref);
    const root = `/run/autopod-validation-${candidate.podId}`;
    const write = async (name: string, value: string) => {
      const result = await boundary.manager.execInContainer(
        ref,
        ['python3', '-c', ROOT_WRITE, `${root}/${name}`, value],
        { user: 'root' },
      );
      if (result.exitCode !== 0) throw new Error('managed-validation-provisioning-failed');
    };
    let stopRequested = false;
    const stop = async () => {
      if (stopRequested) return;
      stopRequested = true;
      await write('revoked', 'true');
    };
    const abort = () => void stop().catch(() => {});
    signal.addEventListener('abort', abort, { once: true });
    const reported = new Map<string, string>();
    try {
      if (signal.aborted) await stop();
      await write('supervisor.py', this.supervisorSource);
      await write(
        'launch.json',
        canonical({
          specDigest: request.executionSpecDigest,
          configurationDigest: request.validation.autopod?.configurationDigest,
          candidateDigest: candidate.candidateDigest,
          newCommit: candidate.newCommit,
          expiresAt: deadline,
          workerUid: 1000,
          workerGid: 1000,
          source: `/repositories/${repositoryId}`,
          workspace: '/workspace',
          ...(boundary.dependencyCache ? { dependencyCache: boundary.dependencyCache.path } : {}),
          phases: configuration.phases.map((phase) => ({
            ...phase,
            cwd: configuration.workingDirectory
              ? `/workspace/${configuration.workingDirectory}`
              : '/workspace',
          })),
        }),
      );
      const started = await boundary.manager.execInContainer(
        ref,
        ['python3', `${root}/supervisor.py`, root, '--detach'],
        { user: 'root' },
      );
      if (started.exitCode !== 0) throw new Error('managed-validation-supervisor-start-failed');
      for (;;) {
        if (signal.aborted) await stop();
        const snapshot = await this.observe(boundary, ref, request, candidate, configuration);
        for (const phase of snapshot.phases) {
          const prior = reported.get(phase.phase);
          if (phase.status === 'running' && prior !== 'running')
            callbacks.onPhaseStarted?.(phase.phase);
          if ((phase.status === 'passed' || phase.status === 'failed') && prior !== phase.status)
            callbacks.onPhaseCompleted?.(phase.phase, phase.status === 'passed' ? 'pass' : 'fail', {
              duration: phase.durationMs,
            });
          reported.set(phase.phase, phase.status);
        }
        if (snapshot.observedExit) {
          if (snapshot.result === 'passed') return { overall: 'pass' };
          if (snapshot.result === 'failed')
            return { overall: 'fail', reason: snapshot.reason || 'validation-failed' };
          const phase =
            snapshot.phases.find((item) => item.status === 'failed')?.phase ??
            configuration.phases[0]?.phase ??
            'setup';
          return {
            overall: 'fail',
            reason: snapshot.reason || 'validation-infrastructure-unavailable',
            infrastructureFailure: {
              phase,
              code: snapshot.reason || 'managed-validation-unavailable',
              message: 'Managed validation did not complete successfully.',
              retryable: false,
            },
          };
        }
        await wait(250);
      }
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }

  private async observe(
    boundary: ManagedValidationBoundary,
    ref: string,
    request: ManagedPodRequest,
    candidate: SourceCandidateReceipt,
    configuration: ManagedValidationConfig,
  ): Promise<SupervisorSnapshot> {
    const result = await boundary.manager.execInContainer(
      ref,
      [
        'python3',
        '-c',
        'import pathlib,sys; print(pathlib.Path(sys.argv[1]).read_text())',
        `/run/autopod-validation-${candidate.podId}/execution.json`,
      ],
      { user: 'root' },
    );
    if (result.exitCode !== 0) {
      if ((await boundary.manager.getStatus(ref)) === 'running')
        return {
          specDigest: request.executionSpecDigest,
          configurationDigest: request.validation.autopod?.configurationDigest ?? '',
          candidateDigest: candidate.candidateDigest,
          newCommit: candidate.newCommit,
          state: 'claimed',
          observedExit: false,
          startedAt: 0,
          completedAt: 0,
          phases: configuration.phases.map(({ phase }) => ({
            phase,
            status: 'not-run',
            durationMs: 0,
          })),
          result: 'running',
          reason: '',
        };
      throw new Error('managed-validation-observation-unavailable');
    }
    const snapshot = supervisorSnapshotSchema.parse(JSON.parse(result.stdout));
    if (
      snapshot.specDigest !== request.executionSpecDigest ||
      snapshot.configurationDigest !== request.validation.autopod?.configurationDigest ||
      snapshot.candidateDigest !== candidate.candidateDigest ||
      snapshot.newCommit !== candidate.newCommit ||
      canonical(snapshot.phases.map((phase) => phase.phase)) !==
        canonical(configuration.phases.map((phase) => phase.phase)) ||
      snapshot.observedExit !== (snapshot.state === 'stopped') ||
      (snapshot.observedExit &&
        (snapshot.completedAt < snapshot.startedAt || snapshot.result === 'running'))
    )
      throw new Error('managed-validation-supervisor-binding');
    return snapshot as SupervisorSnapshot;
  }

  async cleanup(request: ManagedPodRequest, containerId: string): Promise<void> {
    const boundary = this.boundary(request);
    // ContainerManager.kill resolves only after the backend has confirmed destruction (or a
    // backend-specific not-found response). An additional status read would turn a Docker 404
    // into its intentionally ambiguous `unknown` projection.
    await boundary.manager.kill(containerId);
  }
}
