import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  AgentEvent,
  ExecutionRequirements,
  RepairContinuationOperationV1,
  RepairContinuationRequestV1,
} from '@autopod/shared';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
// Test-only producer/consumer boundary: production packages remain independent.
import { repairInspection, repairOperation } from '../../../cli/src/api/repair-continuation.js';
import { repairContinuationRoutes } from '../api/routes/repair-continuation.js';
import { configurationDigest } from '../configuration/configuration-digest.js';
import {
  type RetainedExecutionSelection,
  retainedContinuationLaunch,
} from '../configuration/retained-continuation-launch.js';
import {
  createFailingValidationResult,
  createPassingValidationResult,
} from '../test-utils/mock-helpers.js';
import {
  materializeCheckpointFixture,
  recordPreValidationInfrastructure,
  retainedCheckpointFixture,
} from '../test-utils/retained-checkpoint-helpers.js';
import { QUALIFICATION_SOURCE_PROBE } from './environment-qualification.js';
import { createPodManager } from './pod-manager.js';
import { createPodRepository } from './pod-repository.js';
import { createProviderAttemptRepository } from './provider-attempt-repository.js';
import { createRetainedCheckpointRecovery } from './retained-checkpoint-recovery.js';
import { resolveRetainedSource } from './retained-finalization-source.js';
import { unavailableWorkerInputs, workerBindingHash } from './worker-retry-history.js';

const exec = promisify(execFile);
const fixtures: Awaited<ReturnType<typeof retainedCheckpointFixture>>[] = [];
const candidateId = '2'.repeat(64);
const image = `sha256:${'a'.repeat(64)}`;
const requirements: ExecutionRequirements = {
  version: 2,
  executables: ['jq'],
  platform: 'linux/amd64',
  minimumMemoryBytes: 2 * 1024 ** 3,
  minimumCpu: 1,
};
async function git(cwd: string, ...args: string[]) {
  return (
    await exec('git', args, {
      cwd,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    })
  ).stdout.trim();
}
type RepositoryContext = NonNullable<Parameters<typeof retainedCheckpointFixture>[6]>;
type TestLaunchConfiguration = NonNullable<
  Awaited<ReturnType<typeof retainedCheckpointFixture>>['ctx']['deps']['launchConfiguration']
>;
async function fixture(
  repositoryContext?: RepositoryContext,
  configureLaunch?: (launch: TestLaunchConfiguration) => void,
  target: 'local' | 'sandbox' = 'sandbox',
) {
  const f = await retainedCheckpointFixture(
    'validation',
    true,
    true,
    target === 'local',
    target,
    requirements,
    repositoryContext,
  );
  fixtures.push(f);
  vi.stubEnv('DATA_DIR', f.root);
  vi.stubEnv('AUTOPOD_CLAUDE_STATE_DIR', path.join(f.root, 'claude-state'));
  vi.stubEnv('AUTOPOD_CODEX_STATE_DIR', path.join(f.root, 'codex-state'));
  await materializeCheckpointFixture(f);
  f.ctx.podRepo.update(f.podId, { startCommitSha: f.input.checkpointHead });
  const original = recordPreValidationInfrastructure(f);
  f.ctx.escalationRepo.getOrThrow(original.report.id);
  f.ctx.db.prepare('UPDATE escalations SET payload=? WHERE id=?').run(
    JSON.stringify({
      ...original.report.payload,
      phase: 'coding',
      description: 'jq launcher missing',
      needs: 'Declared jq launcher',
      prerequisiteBlocker: {
        version: 1,
        kind: 'missing-execution-prerequisites',
        requirementsHash: configurationDigest(requirements),
        launchers: ['jq'],
      },
    }),
    original.report.id,
  );
  const runs = f.ctx.podRepo.taskExecutions!;
  const cycle = f.pod().finalization!.cycle;
  const runId = runs.beginRun(f.podId, f.pod().lifecycleGeneration, cycle, {
    runtime: f.pod().runtime,
    model: f.pod().model,
    providerAccountId: 'account',
    resource: { containerId: f.containerId, executionTarget: target },
  });
  const retries = f.ctx.podRepo.workerRetries!;
  // Import the already-settled original before the read-only preview; preview itself cannot write.
  runs.finishRun(runId, 'completed', null);
  retries.state(f.podId);
  const launch = f.ctx.deps.launchConfiguration!;
  const originalConfig = launch.read(f.podId)!;
  const execution: RetainedExecutionSelection = {
    profileId: 'profile',
    parentDigest: originalConfig.digest,
    environment: originalConfig.environment,
    resolvedEnvironment: originalConfig.resolvedEnvironment,
    target: 'local',
    main: originalConfig.resolvedExecution.main,
    resolvedExecution: { ...originalConfig.resolvedExecution, target: 'local' },
    digest: '',
  };
  execution.digest = retainedContinuationLaunch(originalConfig, f.podId, execution).digest;
  launch.previewRetainedExecution = vi.fn(async () => execution);
  launch.prepareEnvironment = vi.fn(async () => image);
  f.cm.supportsStreamingExec = true;
  f.cm.getResourceKey = vi.fn(async (id) =>
    id === candidateId ? `docker://fixture/${id}` : f.resourceKey,
  );
  f.cm.getExecutionMetadata = vi.fn(async () => ({
    imageDigest: image,
    memoryLimitBytes: 2 * 1024 ** 3,
    cpuLimit: 1,
    networkMode: 'isolated',
  }));
  f.cm.getStatus = vi.fn(async (id) => (id === f.containerId ? 'stopped' : 'running'));
  vi.mocked(f.cm.spawn).mockResolvedValue(candidateId);
  const defaultExec = vi.mocked(f.cm.execInContainer).getMockImplementation()!;
  vi.mocked(f.cm.execInContainer).mockImplementation(async (id, command, options) => {
    if (command[2] === QUALIFICATION_SOURCE_PROBE) {
      const source = await f.worktrees.inspectSourceAdoption(f.pod().worktreePath!, f.pod().branch);
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          platform: 'linux/amd64',
          uid: 1000,
          cwd: '/workspace',
          head: source.commitSha,
          tree: source.treeSha,
          clean: source.worktreeClean,
          baseAncestor: true,
        }),
        stderr: '',
      };
    }
    if (command[2] === 'command -v claude')
      return { exitCode: 0, stdout: '/usr/local/bin/claude', stderr: '' };
    if (command.includes('--version')) return { exitCode: 0, stdout: 'claude 2.0.1', stderr: '' };
    if (command[2]?.includes('autopod-command-preflight-v1')) {
      const names = JSON.parse(command[3] ?? '[]') as string[];
      return {
        exitCode: 0,
        stdout: JSON.stringify(names.map((executable) => ({ executable, available: true }))),
        stderr: '',
      };
    }
    if (command.includes('HEAD'))
      return { exitCode: 0, stdout: f.input.checkpointHead, stderr: '' };
    return defaultExec(id, command, options);
  });
  f.worktrees.assertSourceDescendsFrom = vi.fn(async (cwd, ancestor) => {
    await git(cwd, 'merge-base', '--is-ancestor', ancestor, 'HEAD');
  });
  vi.mocked(f.ctx.runtime.spawn).mockImplementation(async function* (): AsyncIterable<AgentEvent> {
    const cwd = f.pod().worktreePath!;
    await writeFile(path.join(cwd, 'source.ts'), 'export const repaired = true;\n');
    await git(cwd, 'add', 'source.ts');
    await git(
      cwd,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-m',
      'continue selected task',
    );
    await mkdir(path.join(cwd, '.autopod/evidence'), { recursive: true });
    await writeFile(path.join(cwd, '.autopod/evidence/worker.txt'), 'Fresh worker report\n');
    yield {
      type: 'complete',
      timestamp: new Date().toISOString(),
      result: 'Implemented continuation',
      totalInputTokens: 10,
      totalOutputTokens: 5,
    };
  });
  vi.mocked(f.ctx.validationEngine.validate).mockImplementation(async (config) => {
    const result = createPassingValidationResult(config.podId, config.attempt);
    return {
      ...result,
      taskReview: {
        status: 'pass',
        reasoning: 'Independent selected source review',
        issues: [],
        model: 'fixture',
        screenshots: [],
        diff: config.diff,
      },
    };
  });
  f.ctx.podRepo.taskRetries!.authorize(
    f.podId,
    'explicit-check-retry',
    'Separately authorize the existing failed validation retry',
    f.actor,
  );
  f.ctx.deps.providerAttemptRepo = createProviderAttemptRepository(f.ctx.db);
  configureLaunch?.(launch);
  const manager = createPodManager(f.ctx.deps);
  const preview = () =>
    manager.previewRepairContinuation(f.podId, {
      sourceHead: f.input.checkpointHead,
      executionProfileId: 'profile',
    });
  async function request(id = 'one-coding-segment'): Promise<RepairContinuationRequestV1> {
    const view = await preview();
    expect(view, JSON.stringify(view)).toMatchObject({
      conditionalAttemptEligible: true,
      actualQualification: 'not_run',
    });
    const { requirementsHash: _requirementsHash, target: _target, ...selection } = view.selection!;
    return {
      version: 1,
      intent: 'qualify_then_code_once',
      id,
      ...selection,
      reason: 'Authorize reviewed environment and one conditional fresh coding segment',
    };
  }
  return { ...f, manager, preview, request, reportId: original.report.id };
}
/** Fully bound request a previously optimistic client could have saved; no caller-authored proof. */
async function boundRequest(
  f: Awaited<ReturnType<typeof fixture>>,
): Promise<RepairContinuationRequestV1> {
  const pod = f.pod();
  const parent = f.ctx.deps.launchConfiguration!.read(f.podId)!;
  const execution = await f.ctx.deps.launchConfiguration!.previewRetainedExecution!(
    f.podId,
    'profile',
  );
  const replacement = retainedContinuationLaunch(parent, f.podId, execution);
  const source = await f.worktrees.inspectSourceAdoption(pod.worktreePath!, pod.branch);
  const result = f.ctx.podRepo.retainedCheckpoints!.selectionEvidence(pod)!;
  const reports = f.ctx.podRepo.retainedCoding!.reports(f.podId, pod.lifecycleGeneration);
  const task = f.ctx.podRepo.taskExecutions!.snapshot(f.podId);
  return {
    version: 1,
    intent: 'qualify_then_code_once',
    id: 'static-context-attempt',
    expectedGeneration: pod.lifecycleGeneration,
    expectedResultHash: result.expectedResultHash,
    expectedReportSetHash: reports.hash,
    sourceHead: source.commitSha,
    executionProfileId: 'profile',
    expectedExecutionDigest: replacement.digest,
    expectedBindingDigest: configurationDigest({
      version: 1,
      podId: f.podId,
      generation: pod.lifecycleGeneration,
      original: parent.digest,
      replacement: replacement.digest,
      result: result.expectedResultHash,
      reportSet: reports.hash,
      source,
      base: pod.startCommitSha,
      taskId: task.taskId,
      executionId: task.executionId,
      requirements: configurationDigest(parent.work.contract!.executionRequirements),
    }),
    reason: 'Authorize a fully bound conditional static-context attempt',
  };
}
async function assertNoRepairEffects(
  f: Awaited<ReturnType<typeof fixture>>,
  before: { changes: unknown; queued: string[] },
) {
  expect(f.ctx.db.prepare('SELECT total_changes() AS n').get()).toEqual(before.changes);
  expect(f.ctx.podRepo.retainedCheckpoints!.latest(f.podId)).toBeNull();
  expect(f.ctx.podRepo.retainedCoding!.latest(f.podId)).toBeNull();
  expect(f.ctx.enqueuedSessions).toEqual(before.queued);
  expect(f.cm.spawn).not.toHaveBeenCalled();
  expect(f.ctx.runtime.spawn).not.toHaveBeenCalled();
  expect(f.ctx.deps.launchConfiguration!.prepareEnvironment).not.toHaveBeenCalled();
  await expect(readdir(path.join(f.root, 'checkpoint-recoveries'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
}
/** New module epoch + reconstructed SQLite, without rewriting any historical fact. */
async function afterRestart(
  f: Awaited<ReturnType<typeof fixture>>,
  input: RepairContinuationRequestV1,
) {
  const reopened = new Database(f.ctx.db.serialize());
  vi.resetModules();
  const { createPodRepository: freshRepository } = await import('./pod-repository.js');
  const pods = freshRepository(reopened);
  try {
    expect(pods.retainedCoding!.processEpoch).not.toBe(f.ctx.podRepo.retainedCoding!.processEpoch);
    const before = pods.retainedCoding!.latest(f.podId);
    const attempts = pods.taskExecutions!.snapshot(f.podId);
    const recovery = createRetainedCheckpointRecovery({ ...f.deps, podRepo: pods });
    const changes = reopened.prepare('SELECT total_changes() AS n').get();
    const observed = recovery.repair!.operation(f.podId, input.id);
    expect(repairOperation(observed, f.podId, input.id, input)).toEqual(observed);
    const inspection = recovery.repair!.inspect(f.podId);
    expect(repairInspection(inspection, f.podId).operation).toEqual(observed);
    expect(await recovery.repair!.authorize(f.podId, input, f.actor)).toEqual(observed);
    expect(reopened.prepare('SELECT total_changes() AS n').get()).toEqual(changes);
    expect(pods.retainedCoding!.latest(f.podId)).toEqual(before);
    expect(pods.taskExecutions!.snapshot(f.podId)).toEqual(attempts);
    expect(() => pods.retainedCoding!.withWorkerScope(f.podId, () => {})).toThrow();
    expect(() => pods.retainedCheckpoints!.assertWorkerAllowed(f.podId)).toThrow();
    return { observed, inspection };
  } finally {
    reopened.close();
  }
}
async function captureClientProjection(values: Record<string, unknown>) {
  const capture = process.env.REPAIR_CLIENT_PRODUCER_FIXTURE;
  if (!capture) return;
  const existing = JSON.parse(await readFile(capture, 'utf8'));
  await writeFile(capture, JSON.stringify({ ...existing, ...values }, null, 2) + '\n');
}
async function waitPreparation(f: (typeof fixtures)[number]) {
  for (let n = 0; n < 1000; n++) {
    const root = f.ctx.podRepo.retainedCheckpoints!.latest(f.podId);
    if (!root || root.activated || root.blocked) return root;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Bounded independent preparation did not settle');
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    if (f.ctx.db.open) await waitPreparation(f);
    if (f.ctx.db.open) f.ctx.db.close();
    await rm(f.root, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});
describe('conditional retained coding continuation', () => {
  it('arbitrates concurrent infrastructure checks and qualified coding on the same retained root', async () => {
    const f = await fixture(undefined, undefined, 'local');
    const coding = await f.request();
    const infrastructure = {
      ...f.input,
      id: 'competing-infrastructure-checks',
      mode: 'checks' as const,
      qualification:
        'Operator selected preserved source for independent checks, without coding authority',
    };
    const outcomes = await Promise.allSettled([
      f.manager.authorizeRepairContinuation(f.podId, coding, f.actor),
      f.manager.recoverInfrastructure(f.podId, infrastructure, f.actor),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    const root = await waitPreparation(f);
    expect(root?.blocked, JSON.stringify(root)).toBeNull();
    expect(root?.activated).not.toBeNull();
    expect(f.ctx.podRepo.retainedCheckpoints!.list(f.podId)).toHaveLength(1);
    const companion = f.ctx.podRepo.retainedCoding!.latest(f.podId);
    if (root?.binding.continuation?.infrastructure) {
      expect(companion).toBeNull();
      expect(f.pod().skipAgent).toBe(true);
    } else {
      expect(companion?.id).toBe(root?.id);
      expect(f.pod().skipAgent).toBe(false);
    }
    expect(f.ctx.runtime.spawn).not.toHaveBeenCalled();
    expect(f.cm.stop).not.toHaveBeenCalled();
  });
  it('feeds actual inspection/qualified/failed/final projections to clients without rewriting immutable IDs', async () => {
    const f = await fixture();
    // Real producer hashing/serialization must preserve slash, controls, Unicode
    // composition and astral characters in the actual resource identity.
    const resourceKey = f.cm.getResourceKey!.bind(f.cm);
    f.cm.getResourceKey = vi.fn(async (id) =>
      id === candidateId
        ? 'docker://fixture/' + id + '/é/e\u0301/😀/"\\\n\t\u0000'
        : resourceKey(id),
    );
    const inspection = f.manager.inspectRepairContinuation(f.podId);
    expect(inspection).toMatchObject({ available: true, sourceHead: null });
    expect(repairInspection(inspection, f.podId)).toEqual(inspection);
    const preview = await f.preview();
    const request = await f.request('stable-external-request');
    const claimed = await f.manager.authorizeRepairContinuation(f.podId, request, f.actor);
    expect(claimed.operationId).not.toBe(request.id);
    expect(repairOperation(claimed, f.podId, request.id, request)).toEqual(claimed);
    await waitPreparation(f);
    let qualified: RepairContinuationOperationV1 | undefined;
    const store = f.ctx.podRepo.retainedCoding!;
    const append = store.append.bind(store);
    vi.spyOn(store, 'append').mockImplementation((id, kind, evidence) => {
      append(id, kind, evidence);
      if (kind === 'qualified') {
        qualified = f.manager.getRepairContinuation(f.podId, request.id);
        expect(qualified.state).toBe('qualified');
        expect(qualified.qualification?.outcome).toBe('qualified');
        expect(qualified.qualification?.binding.operationId).toBe(qualified.operationId);
        expect(qualified.qualification?.binding.custodyId).toBe(qualified.operationId);
        expect(repairOperation(qualified, f.podId, request.id, request)).toEqual(qualified);
      }
    });
    await f.manager.processPod(f.podId);
    expect(qualified).toBeDefined();
    const validated = f.manager.getRepairContinuation(f.podId, request.id);
    expect(validated.state).toBe('validated');
    expect(validated.codingFinalSource?.operationId).toBe(validated.operationId);
    expect(repairOperation(validated, f.podId, request.id, request)).toEqual(validated);
    const restarted = await afterRestart(f, request);
    expect(restarted.observed).toEqual(validated);
    expect(restarted.observed).toMatchObject({
      state: 'validated',
      codingAdmission: 'consumed',
      checks: 'passed',
    });
    expect(f.ctx.runtime.spawn).toHaveBeenCalledTimes(1);
    // A failed actual-source probe produces immutable failed evidence without a worker.
    const failedFixture = await fixture();
    const failedRequest = await failedFixture.request('failed-external-request');
    const exec = vi.mocked(failedFixture.cm.execInContainer).getMockImplementation()!;
    vi.mocked(failedFixture.cm.execInContainer).mockImplementation(async (id, command, options) =>
      command[2] === QUALIFICATION_SOURCE_PROBE
        ? {
            exitCode: 0,
            stdout: JSON.stringify({
              platform: 'linux/amd64',
              uid: 1000,
              cwd: '/workspace',
              head: 'e'.repeat(40),
              tree: 'e'.repeat(40),
              clean: true,
              baseAncestor: true,
            }),
            stderr: '',
          }
        : exec(id, command, options),
    );
    await failedFixture.manager.authorizeRepairContinuation(
      failedFixture.podId,
      failedRequest,
      failedFixture.actor,
    );
    await waitPreparation(failedFixture);
    await expect(failedFixture.manager.processPod(failedFixture.podId)).rejects.toThrow();
    const failed = failedFixture.manager.getRepairContinuation(
      failedFixture.podId,
      failedRequest.id,
    );
    expect(failed.state).toBe('failed');
    expect(failed.qualification?.outcome).toBe('failed');
    expect(failed.qualification?.binding.operationId).toBe(failed.operationId);
    expect(failed.qualification?.binding.custodyId).toBe(failed.operationId);
    expect(repairOperation(failed, failed.podId, failedRequest.id, failedRequest)).toEqual(failed);
    expect(failedFixture.ctx.runtime.spawn).not.toHaveBeenCalled();
    // Explicit opt-in capture is used by the native regression. Normal tests never rewrite fixtures.
    const capture = process.env.REPAIR_CLIENT_PRODUCER_FIXTURE;
    if (capture)
      await writeFile(
        capture,
        JSON.stringify(
          {
            inspection,
            preview,
            request,
            claimed,
            qualified,
            failed,
            validated,
            restartedValidated: restarted.observed,
            restartedValidatedInspection: restarted.inspection,
          },
          null,
          2,
        ) + '\n',
      );
  });
  it('retains proven consumed admission after sealing while restarted checks remain unknown', async () => {
    const f = await fixture();
    const input = await f.request();
    let enteredChecks!: () => void;
    let releaseChecks!: () => void;
    const checking = new Promise<void>((resolve) => {
      enteredChecks = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      releaseChecks = resolve;
    });
    const validate = vi.mocked(f.ctx.validationEngine.validate).getMockImplementation()!;
    vi.mocked(f.ctx.validationEngine.validate).mockImplementation(async (config) => {
      enteredChecks();
      await hold;
      return validate(config);
    });
    await f.manager.authorizeRepairContinuation(f.podId, input, f.actor);
    await waitPreparation(f);
    const processing = f.manager.processPod(f.podId);
    try {
      await Promise.race([
        checking,
        processing.then(() => {
          throw new Error('Checks never entered');
        }),
      ]);
      const restarted = await afterRestart(f, input);
      expect(restarted.observed).toMatchObject({
        state: 'unknown',
        codingAdmission: 'consumed',
        checks: 'unknown',
        codingFinalSource: { workerSettled: true, clean: true, descendant: true },
      });
      await captureClientProjection({
        restartedSealed: restarted.observed,
        restartedSealedInspection: restarted.inspection,
      });
    } finally {
      releaseChecks();
      await processing;
    }
    expect(f.ctx.runtime.spawn).toHaveBeenCalledTimes(1);
    expect(f.manager.getRepairContinuation(f.podId, input.id).state).toBe('validated');
  });
  it('qualifies the actual candidate, spawns once, seals descendant source and runs real checks without delivery', async () => {
    const f = await fixture();
    const before = f.pod();
    const input = await f.request();
    const accepted = await f.manager.authorizeRepairContinuation(f.podId, input, f.actor);
    expect(accepted.qualification).toBeNull();
    expect(f.ctx.runtime.spawn).not.toHaveBeenCalled();
    const rootId = f.ctx.podRepo.retainedCoding!.latest(f.podId)!.id;
    // Authorization schedules existing retained preparation; wait for its queue receipt.
    await waitPreparation(f);
    const preparedRoot = f.ctx.podRepo.retainedCheckpoints!.get(rootId);
    expect(preparedRoot?.blocked, JSON.stringify(preparedRoot)).toBeNull();
    expect(preparedRoot?.activated, JSON.stringify(preparedRoot)).not.toBeNull();
    await f.manager.processPod(f.podId).catch((error) => {
      throw new Error(
        JSON.stringify({
          error: String(error),
          failure: f.pod().failureReason,
          proof: f.manager.getRepairContinuation(f.podId, input.id).qualification?.observations,
        }),
      );
    });
    const operation = f.manager.getRepairContinuation(f.podId, input.id);
    expect(operation, JSON.stringify({ operation, pod: f.pod() })).toMatchObject({
      state: 'validated',
      codingAdmission: 'consumed',
      checks: 'passed',
      qualification: { outcome: 'qualified' },
      publicationAuthorized: false,
    });
    expect(operation.codingFinalSource?.source.head).not.toBe(input.sourceHead);
    const config = f.ctx.deps.launchConfiguration!.read(f.podId)!;
    const anchor = resolveRetainedSource(
      f.ctx.podRepo,
      f.pod(),
      config.repository!.config.remote,
      f.pod().baseBranch ?? 'main',
    );
    expect(anchor.head).toBe(operation.codingFinalSource?.source.head);
    expect(anchor.tree).toBe(operation.codingFinalSource?.source.tree);
    expect(anchor.head).not.toBe(preparedRoot?.prepared?.head);
    expect(f.ctx.db.prepare('SELECT * FROM retained_infrastructure_events').all()).toEqual([]);
    expect(f.ctx.runtime.spawn).toHaveBeenCalledTimes(1);
    expect(f.ctx.runtime.resume).not.toHaveBeenCalled();
    expect(f.ctx.worktreeManager.pushBranch).not.toHaveBeenCalled();
    expect(f.ctx.worktreeManager.mergeBranch).not.toHaveBeenCalled();
    expect(f.cm.kill).not.toHaveBeenCalled();
    expect(f.pod().validationAttempts).toBe(before.validationAttempts + 1);
    expect(await readFile(path.join(before.worktreePath!, 'ignored-report.txt'), 'utf8')).toContain(
      'Original report',
    );
    expect(await f.manager.authorizeRepairContinuation(f.podId, input, f.actor)).toEqual(operation);
    await f.manager.processPod(f.podId);
    expect(f.ctx.runtime.spawn).toHaveBeenCalledTimes(1);
  });
  it.each([
    {
      name: 'NODE_OPTIONS',
      context: { buildEnv: { NODE_OPTIONS: { value: '--require /workspace/preload.js' } } },
    },
    { name: 'NODE_PATH', context: { buildEnv: { NODE_PATH: { value: '/workspace/modules' } } } },
    { name: 'LD_PRELOAD', context: { buildEnv: { LD_PRELOAD: { value: '/tmp/preload.so' } } } },
    {
      name: 'LD_LIBRARY_PATH',
      context: { buildEnv: { LD_LIBRARY_PATH: { value: '/tmp/libraries' } } },
    },
    { name: 'BASH_ENV', context: { buildEnv: { BASH_ENV: { value: '/workspace/env.sh' } } } },
    { name: 'ENV', context: { buildEnv: { ENV: { value: '/workspace/env.sh' } } } },
    { name: 'relative PATH', context: { buildEnv: { PATH: { value: 'bin:/usr/bin' } } } },
    {
      name: 'workspace PATH',
      context: { buildEnv: { PATH: { value: '/workspace/bin:/usr/bin' } } },
    },
    { name: 'empty PATH entry', context: { buildEnv: { PATH: { value: '/usr/bin::/bin' } } } },
    { name: 'tmp PATH', context: { buildEnv: { PATH: { value: '/tmp/bin:/usr/bin' } } } },
    { name: 'unsupported cwd', context: { buildWorkDir: 'directory with spaces' } },
  ] satisfies Array<{
    name: string;
    context: RepositoryContext;
  }>)('refuses frozen unsupported static context ($name) in preview and POST without effects', async ({
    context,
  }) => {
    const f = await fixture(context);
    const input = await boundRequest(f);
    const before = {
      changes: f.ctx.db.prepare('SELECT total_changes() AS n').get(),
      queued: [...f.ctx.enqueuedSessions],
    };
    const app = Fastify();
    app.addHook('preHandler', async (req) => {
      req.user = { oid: 'operator' } as NonNullable<typeof req.user>;
    });
    repairContinuationRoutes(app, f.manager);
    try {
      const preview = await app.inject({
        url: `/pods/${f.podId}/repair-continuation-v1/preview?sourceHead=${input.sourceHead}&executionProfileId=profile`,
      });
      expect(preview.statusCode).toBe(200);
      expect(preview.json()).toMatchObject({
        conditionalAttemptEligible: false,
        configurationOnly: true,
        actualQualification: 'not_run',
        selection: null,
        refusals: [{ code: 'unsupported_task' }],
      });
      expect(preview.json().refusals[0].message).toContain('context is unsupported');
      const post = await app.inject({
        method: 'POST',
        url: `/pods/${f.podId}/repair-continuation-v1`,
        payload: input,
      });
      expect(post.statusCode).toBe(409);
      expect(post.json().message).toContain('context is unsupported');
      await assertNoRepairEffects(f, before);
    } finally {
      await app.close();
    }
  });
  it('preserves supported static-context eligibility without claiming actual qualification', async () => {
    const f = await fixture({
      buildEnv: {
        PATH: { value: '/usr/local/bin:/usr/bin:/bin' },
        NODE_ENV: { value: 'development' },
      },
      buildWorkDir: 'packages/web',
    });
    const input = await boundRequest(f);
    const before = {
      changes: f.ctx.db.prepare('SELECT total_changes() AS n').get(),
      queued: [...f.ctx.enqueuedSessions],
    };
    const view = await f.preview();
    expect(view).toMatchObject({
      conditionalAttemptEligible: true,
      actualQualification: 'not_run',
      configurationOnly: true,
      refusals: [],
      selection: {
        expectedBindingDigest: input.expectedBindingDigest,
        expectedExecutionDigest: input.expectedExecutionDigest,
      },
    });
    await assertNoRepairEffects(f, before);
  });
  it.each([
    'replacement-reselection',
    'last-original-observation',
  ] as const)('rechecks static context before authorization effects at %s', async (stage) => {
    let unsupported = false;
    const f = await fixture(undefined, (launch) => {
      const resolve = launch.executionSettings;
      launch.executionSettings = (config) => {
        const settings = resolve(config);
        return config.execution.target === 'local' && unsupported
          ? { ...settings, buildEnv: { NODE_OPTIONS: '--require /workspace/preload.js' } }
          : settings;
      };
    });
    const input = await f.request();
    if (stage === 'replacement-reselection') {
      const selected = vi
        .mocked(f.ctx.deps.launchConfiguration!.previewRetainedExecution!)
        .getMockImplementation()!;
      let selections = 0;
      vi.mocked(f.ctx.deps.launchConfiguration!.previewRetainedExecution!).mockImplementation(
        async (...args) => {
          if (++selections === 2) unsupported = true;
          return selected(...args);
        },
      );
    } else {
      const status = vi.mocked(f.cm.getStatus).getMockImplementation()!;
      let observations = 0;
      vi.mocked(f.cm.getStatus).mockImplementation(async (...args) => {
        if (++observations === 2) unsupported = true;
        return status(...args);
      });
    }
    const before = {
      changes: f.ctx.db.prepare('SELECT total_changes() AS n').get(),
      queued: [...f.ctx.enqueuedSessions],
    };
    await expect(f.manager.authorizeRepairContinuation(f.podId, input, f.actor)).rejects.toThrow(
      'context is unsupported',
    );
    await assertNoRepairEffects(f, before);
  });
  it('keeps preview/configuration-only and refuses unsupported mixed report sets before allocation', async () => {
    const f = await fixture();
    const changes = () => f.ctx.db.prepare('SELECT total_changes() AS n').get();
    const writes = changes();
    const view = await f.preview();
    expect(view).toMatchObject({
      conditionalAttemptEligible: true,
      actualQualification: 'not_run',
    });
    expect(changes()).toEqual(writes);
    const saved = f.ctx.escalationRepo.getOrThrow(f.reportId);
    f.ctx.escalationRepo.insert({
      id: 'legacy-need',
      podId: f.podId,
      type: 'report_blocker',
      timestamp: new Date().toISOString(),
      payload: { ...saved.payload, prerequisiteBlocker: undefined },
      response: null,
    });
    expect(await f.preview()).toMatchObject({
      conditionalAttemptEligible: false,
      actualQualification: 'not_run',
    });
    expect(f.cm.spawn).not.toHaveBeenCalled();
  });
  it.each([
    'expectedGeneration',
    'expectedResultHash',
    'expectedReportSetHash',
    'expectedExecutionDigest',
    'expectedBindingDigest',
  ] as const)('refuses stale %s before custody/allocation', async (field) => {
    const f = await fixture();
    const input = await f.request();
    await expect(
      f.manager.authorizeRepairContinuation(
        f.podId,
        {
          ...input,
          [field]: field === 'expectedGeneration' ? input.expectedGeneration + 1 : 'e'.repeat(64),
        },
        f.actor,
      ),
    ).rejects.toThrow('changed');
    expect(f.cm.spawn).not.toHaveBeenCalled();
    expect(f.ctx.podRepo.retainedCheckpoints!.latest(f.podId)).toBeNull();
  });
  it.each([
    'guidance',
    'decision',
    'unverified-worker',
    'budget',
  ] as const)('refuses %s without discarding saved work', async (kind) => {
    const f = await fixture();
    const input = await f.request();
    if (kind === 'guidance') f.ctx.nudgeRepo.queue(f.podId, 'Saved guidance must not disappear');
    if (kind === 'decision')
      f.ctx.podRepo.update(f.podId, {
        pendingEscalation: {
          id: 'decision',
          podId: f.podId,
          type: 'ask_human',
          timestamp: new Date().toISOString(),
          payload: { question: 'Choose implementation scope' },
          response: null,
        },
      });
    if (kind === 'budget')
      f.ctx.podRepo.update(f.podId, {
        tokenBudget: 1,
        inputTokens: 1,
        tokenTelemetryAccuracy: 'complete',
      });
    if (kind === 'unverified-worker') {
      f.ctx.podRepo.completionJournal!.begin(f.pod());
      const cycle = f.pod().finalization!.cycle;
      const run = f.ctx.podRepo.taskExecutions!.beginRun(
        f.podId,
        f.pod().lifecycleGeneration,
        cycle,
        {
          runtime: f.pod().runtime,
          model: f.pod().model,
          providerAccountId: 'account',
          resource: { containerId: f.containerId, executionTarget: 'sandbox' },
        },
      );
      f.ctx.podRepo.taskExecutions!.retainUnverifiedRun(run);
    }
    expect(await f.preview()).toMatchObject({ conditionalAttemptEligible: false });
    await expect(f.manager.authorizeRepairContinuation(f.podId, input, f.actor)).rejects.toThrow();
    expect(f.cm.spawn).not.toHaveBeenCalled();
    if (kind === 'guidance') expect(f.ctx.nudgeRepo.hasPending(f.podId)).toBe(true);
  });
  it('does not infer a worker retry grant from environment selection and consumes a separate grant once', async () => {
    const f = await fixture();
    const oldInput = await f.request();
    const pods = f.ctx.podRepo;
    pods.completionJournal!.begin(f.pod());
    const cycle = f.pod().finalization!.cycle;
    const run = pods.taskExecutions!.beginRun(f.podId, f.pod().lifecycleGeneration, cycle, {
      runtime: f.pod().runtime,
      model: f.pod().model,
      providerAccountId: 'account',
      resource: { containerId: f.containerId, executionTarget: 'sandbox' },
    });
    const binding = workerBindingHash({
      runtime: f.pod().runtime,
      model: f.pod().model,
      providerAccountId: 'account',
    });
    const admission = pods.workerRetries!.admit(
      f.podId,
      f.pod().lifecycleGeneration,
      unavailableWorkerInputs,
      binding,
      [],
      run,
    );
    pods.workerRetries!.start(admission.id);
    pods.workerRetries!.finish(admission.id, 'nonretryable', 1);
    pods.taskExecutions!.finishRun(run, 'failed', 'auth');
    pods.completionJournal!.settle(f.pod(), 'Authentication failure positively settled');
    pods.completionJournal!.mark(f.pod(), 'ready', true);
    expect(await f.preview()).toMatchObject({ conditionalAttemptEligible: false });
    await expect(
      f.manager.authorizeRepairContinuation(f.podId, oldInput, f.actor),
    ).rejects.toThrow();
    expect(f.cm.spawn).not.toHaveBeenCalled();
    const grant = pods.workerRetries!.authorize(
      f.podId,
      'separate-worker-retry',
      'Explicit independent permission for the settled worker failure',
      f.actor,
      undefined,
      admission.id,
    );
    const input = await f.request();
    await f.manager.authorizeRepairContinuation(f.podId, input, f.actor);
    await waitPreparation(f);
    await f.manager.processPod(f.podId);
    const worker = pods.retainedCoding!.latest(f.podId)!.facts.worker!;
    expect(
      pods.workerRetries!.state(f.podId).authorizations.find((a) => a.id === grant.id)
        ?.usedByAttemptId,
    ).toBe(worker.runId);
    expect(pods.taskExecutions!.snapshot(f.podId).agentRunCount).toBe(3);
    expect(f.ctx.runtime.spawn).toHaveBeenCalledTimes(1);
  });
  it('binds all infrastructure reports independently of an unchanged non-null result', async () => {
    const f = await fixture();
    f.ctx.podRepo.update(f.podId, {
      lastValidationResult: createPassingValidationResult(f.podId, 1),
    });
    const input = await f.request();
    const saved = f.ctx.escalationRepo.getOrThrow(f.reportId);
    f.ctx.escalationRepo.insert({
      id: 'late-typed-need',
      podId: f.podId,
      type: 'report_blocker',
      timestamp: new Date().toISOString(),
      payload: saved.payload,
      response: null,
    });
    const next = await f.preview();
    expect(next.selection?.expectedResultHash).toBe(input.expectedResultHash);
    expect(next.selection?.expectedReportSetHash).not.toBe(input.expectedReportSetHash);
    await expect(f.manager.authorizeRepairContinuation(f.podId, input, f.actor)).rejects.toThrow(
      'changed',
    );
    expect(f.cm.spawn).not.toHaveBeenCalled();
  });
  it('coalesces concurrent authorization/queue callbacks and rejects replay conflicts before discovery', async () => {
    const f = await fixture();
    const input = await f.request();
    const operations = await Promise.all([
      f.manager.authorizeRepairContinuation(f.podId, input, f.actor),
      f.manager.authorizeRepairContinuation(f.podId, input, f.actor),
    ]);
    expect(operations.map((v) => v.request.id)).toEqual([input.id, input.id]);
    await waitPreparation(f);
    await Promise.all([
      f.manager.processPod(f.podId),
      f.manager.processPod(f.podId),
      f.manager.processPod(f.podId),
    ]);
    expect(f.ctx.runtime.spawn).toHaveBeenCalledTimes(1);
    expect(f.cm.spawn).toHaveBeenCalledTimes(1);
    await expect(
      f.manager.authorizeRepairContinuation(
        f.podId,
        { ...input, reason: 'Different saved authorization reason' },
        f.actor,
      ),
    ).rejects.toThrow('conflict');
    await expect(
      f.manager.authorizeRepairContinuation(f.podId, input, {
        type: 'human',
        userId: 'different-operator',
      }),
    ).rejects.toThrow('conflict');
    const observations = vi.mocked(f.cm.getResourceKey!).mock.calls.length;
    await f.manager.authorizeRepairContinuation(f.podId, input, f.actor);
    expect(vi.mocked(f.cm.getResourceKey!).mock.calls).toHaveLength(observations);
  });
  it.each([
    'unknown-memory',
    'wrong-image',
    'wrong-source',
  ] as const)('never starts coding after %s qualification', async (kind) => {
    const f = await fixture();
    const input = await f.request();
    if (kind === 'unknown-memory')
      f.cm.getExecutionMetadata = vi.fn(async () => ({
        imageDigest: image,
        memoryLimitBytes: null,
        cpuLimit: 1,
        networkMode: 'isolated',
      }));
    if (kind === 'wrong-image')
      f.cm.getExecutionMetadata = vi.fn(async () => ({
        imageDigest: `sha256:${'e'.repeat(64)}`,
        memoryLimitBytes: 2 * 1024 ** 3,
        cpuLimit: 1,
        networkMode: 'isolated',
      }));
    if (kind === 'wrong-source') {
      const original = vi.mocked(f.cm.execInContainer).getMockImplementation()!;
      vi.mocked(f.cm.execInContainer).mockImplementation(async (id, command, options) =>
        command[2] === QUALIFICATION_SOURCE_PROBE
          ? {
              exitCode: 0,
              stdout: JSON.stringify({
                platform: 'linux/amd64',
                uid: 1000,
                cwd: '/workspace',
                head: 'e'.repeat(40),
                tree: 'e'.repeat(40),
                clean: true,
                baseAncestor: true,
              }),
              stderr: '',
            }
          : original(id, command, options),
      );
    }
    await f.manager.authorizeRepairContinuation(f.podId, input, f.actor);
    await waitPreparation(f);
    await expect(f.manager.processPod(f.podId)).rejects.toThrow();
    expect(f.ctx.runtime.spawn).not.toHaveBeenCalled();
    expect(f.ctx.runtime.resume).not.toHaveBeenCalled();
    expect(f.ctx.podRepo.retainedCoding!.latest(f.podId)!.facts.worker).toBeUndefined();
    expect(f.cm.kill).not.toHaveBeenCalled();
    await f.manager.authorizeRepairContinuation(f.podId, input, f.actor);
    await expect(
      f.manager.authorizeRepairContinuation(f.podId, { ...input, id: 'escape-custody' }, f.actor),
    ).rejects.toThrow();
    expect(f.cm.spawn).toHaveBeenCalledTimes(1);
  });
  it('seals unchanged source and still runs checks/review, never the no-changes completion shortcut', async () => {
    const f = await fixture();
    const input = await f.request();
    vi.mocked(f.ctx.worktreeManager.getDiffStats).mockResolvedValue({
      filesChanged: 0,
      linesAdded: 0,
      linesRemoved: 0,
    });
    vi.mocked(f.ctx.runtime.spawn).mockImplementation(async function* () {
      await mkdir(path.join(f.pod().worktreePath!, '.autopod/evidence'), { recursive: true });
      yield {
        type: 'complete',
        timestamp: new Date().toISOString(),
        result: 'No further code changes required',
        totalInputTokens: 1,
        totalOutputTokens: 1,
      } as AgentEvent;
    });
    await f.manager.authorizeRepairContinuation(f.podId, input, f.actor);
    await waitPreparation(f);
    await f.manager.processPod(f.podId);
    expect(f.manager.getRepairContinuation(f.podId, input.id)).toMatchObject({
      state: 'validated',
      codingFinalSource: { source: { head: input.sourceHead } },
    });
    expect(f.ctx.validationEngine.validate).toHaveBeenCalledTimes(1);
    expect(f.cm.kill).not.toHaveBeenCalled();
  });
  it('records failed configured checks without an automatic second coding turn or publication', async () => {
    const f = await fixture();
    const input = await f.request();
    vi.mocked(f.ctx.validationEngine.validate).mockImplementation(async (config) =>
      createFailingValidationResult(config.podId, config.attempt),
    );
    await f.manager.authorizeRepairContinuation(f.podId, input, f.actor);
    await waitPreparation(f);
    await f.manager.processPod(f.podId);
    expect(f.manager.getRepairContinuation(f.podId, input.id)).toMatchObject({
      state: 'failed',
      checks: 'failed',
      codingAdmission: 'consumed',
    });
    expect(f.ctx.runtime.spawn).toHaveBeenCalledTimes(1);
    expect(f.ctx.runtime.resume).not.toHaveBeenCalled();
    expect(f.ctx.worktreeManager.pushBranch).not.toHaveBeenCalled();
    expect(() => f.ctx.podRepo.retainedCheckpoints!.assertWorkerAllowed(f.podId)).toThrow();
    const restarted = await afterRestart(f, input);
    expect(restarted.observed).toMatchObject({
      state: 'failed',
      checks: 'failed',
      codingAdmission: 'consumed',
    });
    expect(restarted.observed.codingFinalSource).not.toBeNull();
    await captureClientProjection({
      restartedFailedChecks: restarted.observed,
      restartedFailedChecksInspection: restarted.inspection,
    });
  });
  it('retains uncertain coding across SQLite reconstruction and observes replay without a second worker', async () => {
    const f = await fixture();
    const input = await f.request();
    vi.mocked(f.ctx.runtime.spawn).mockImplementation(async function* () {
      yield {
        type: 'error',
        timestamp: new Date().toISOString(),
        message: 'Native exit remains unknown',
        fatal: true,
        executionTermination: 'unverified',
      } as AgentEvent;
    });
    await f.manager.authorizeRepairContinuation(f.podId, input, f.actor);
    await waitPreparation(f);
    await expect(f.manager.processPod(f.podId)).rejects.toThrow();
    expect(f.manager.getRepairContinuation(f.podId, input.id)).toMatchObject({
      state: 'unknown',
      codingAdmission: 'unknown',
      codingFinalSource: null,
    });
    const restarted = await afterRestart(f, input);
    expect(restarted.observed).toMatchObject({
      state: 'unknown',
      codingAdmission: 'unknown',
      codingFinalSource: null,
    });
    await captureClientProjection({
      restartedUnsettled: restarted.observed,
      restartedUnsettledInspection: restarted.inspection,
    });
    const reopened = new Database(f.ctx.db.serialize());
    try {
      const pods = createPodRepository(reopened);
      const recovery = createRetainedCheckpointRecovery({ ...f.deps, podRepo: pods });
      const observed = recovery.repair!.operation(f.podId, input.id);
      expect(observed).toMatchObject({
        state: 'unknown',
        codingFinalSource: null,
        originalResourcesRetained: true,
      });
      expect(await recovery.repair!.authorize(f.podId, input, f.actor)).toEqual(observed);
      await expect(
        recovery.process(f.podId, async () => {
          throw new Error('Duplicate dispatch');
        }),
      ).rejects.toThrow('eligible');
      expect(pods.taskExecutions!.hasUnverifiedTermination(f.podId)).toBe(true);
      expect(pods.listReferencedContainerIds()).toContain(candidateId);
      expect(() => pods.retainedCoding!.withWorkerScope(f.podId, () => {})).toThrow();
    } finally {
      reopened.close();
    }
    expect(f.ctx.runtime.spawn).toHaveBeenCalledTimes(1);
    expect(f.cm.spawn).toHaveBeenCalledTimes(1);
    expect(f.cm.kill).not.toHaveBeenCalled();
  });
  it('does not seal a stream that produced no completion result', async () => {
    const f = await fixture();
    const input = await f.request();
    vi.mocked(f.ctx.runtime.spawn).mockImplementation(async function* () {});
    await f.manager.authorizeRepairContinuation(f.podId, input, f.actor);
    await waitPreparation(f);
    await expect(f.manager.processPod(f.podId)).rejects.toThrow();
    expect(f.manager.getRepairContinuation(f.podId, input.id)).toMatchObject({
      codingFinalSource: null,
      checks: 'not_started',
      codingAdmission: 'consumed',
    });
    expect(f.ctx.validationEngine.validate).not.toHaveBeenCalled();
    expect(f.cm.kill).not.toHaveBeenCalled();
  });
  it('rechecks original report-set ownership after qualification and before the lazy worker pull', async () => {
    const f = await fixture();
    const input = await f.request();
    const execute = vi.mocked(f.cm.execInContainer).getMockImplementation()!;
    let sourceReads = 0;
    vi.mocked(f.cm.execInContainer).mockImplementation(async (id, command, options) => {
      const result = await execute(id, command, options);
      if (command[2] === QUALIFICATION_SOURCE_PROBE && ++sourceReads === 2) {
        const saved = f.ctx.escalationRepo.getOrThrow(f.reportId);
        f.ctx.escalationRepo.insert({
          id: 'need-after-qualification',
          podId: f.podId,
          type: 'report_blocker',
          timestamp: new Date().toISOString(),
          payload: saved.payload,
          response: null,
        });
      }
      return result;
    });
    await f.manager.authorizeRepairContinuation(f.podId, input, f.actor);
    await waitPreparation(f);
    await expect(f.manager.processPod(f.podId)).rejects.toThrow();
    const op = f.manager.getRepairContinuation(f.podId, input.id);
    expect(op.qualification?.outcome).toBe('qualified');
    expect(op.codingFinalSource).toBeNull();
    expect(f.ctx.runtime.spawn).not.toHaveBeenCalled();
    expect(f.ctx.validationEngine.validate).not.toHaveBeenCalled();
  });
  it('archives prior sessions/summary and uses fresh native files while preserving historical NOT-RUN review context', async () => {
    const f = await fixture();
    const deferred = [
      {
        id: 'mac-check',
        check: 'Native verification',
        reason: 'Requires Mac',
        expectedExecutor: 'Mac',
        lifecycleGeneration: f.pod().lifecycleGeneration,
      },
    ];
    f.ctx.podRepo.update(f.podId, {
      claudeSessionId: 'old-claude',
      codexSessionId: 'old-codex',
      piSessionId: 'old-pi',
      taskSummary: {
        actualSummary: 'Old implementation context',
        deviations: [],
        deferredChecks: deferred,
        factEvidence: [
          {
            factId: 'historical-only',
            artifactPath: 'old/report.txt',
            command: 'old command',
            result: 'passed',
          },
        ],
      },
    });
    const oldDir = path.join(f.root, 'claude-state', f.podId);
    await mkdir(oldDir, { recursive: true });
    await writeFile(path.join(oldDir, 'original-session.jsonl'), 'Original native history\n');
    const run = vi.mocked(f.ctx.runtime.spawn).getMockImplementation()!;
    vi.mocked(f.ctx.runtime.spawn).mockImplementation(async function* (config) {
      yield {
        type: 'status',
        timestamp: new Date().toISOString(),
        message: 'Fresh session',
        sessionId: 'fresh-claude',
      } as AgentEvent;
      yield {
        type: 'task_summary',
        timestamp: new Date().toISOString(),
        actualSummary: 'Fresh continuation summary',
        deviations: [],
        factEvidence: [],
      } as AgentEvent;
      yield* run(config);
    });
    const input = await f.request();
    await f.manager.authorizeRepairContinuation(f.podId, input, f.actor);
    await waitPreparation(f);
    await f.manager.processPod(f.podId);
    const record = f.ctx.podRepo.retainedCoding!.latest(f.podId)!;
    expect(record.context).toMatchObject({
      claudeSessionId: 'old-claude',
      codexSessionId: 'old-codex',
      piSessionId: 'old-pi',
      taskSummary: { actualSummary: 'Old implementation context' },
    });
    expect(f.pod()).toMatchObject({
      claudeSessionId: 'fresh-claude',
      codexSessionId: null,
      piSessionId: null,
      taskSummary: { actualSummary: 'Fresh continuation summary' },
    });
    const mount = vi
      .mocked(f.cm.spawn)
      .mock.calls[0]?.[0].volumes?.find((v) => v.container.endsWith('/.claude/projects'));
    expect(mount?.host).toBe(path.join(f.root, 'claude-state', `${f.podId}-repair-${record.id}`));
    expect(await readFile(path.join(oldDir, 'original-session.jsonl'), 'utf8')).toBe(
      'Original native history\n',
    );
    const config = vi.mocked(f.ctx.validationEngine.validate).mock.calls[0]?.[0];
    expect(config?.historicalDeferredChecks).toEqual(deferred);
    expect(config?.taskSummary?.actualSummary).toBe('Fresh continuation summary');
    expect(config?.taskSummary?.factEvidence).toEqual([]);
    expect(config?.task).toContain('Old implementation context');
    expect(f.ctx.runtime.resume).not.toHaveBeenCalled();
  });
});

describe('typed retained worker active-question replies', () => {
  afterEach(() => vi.useRealTimers());
  const answer = 'Use the original acceptance case; preserve all required checks';
  async function questioningFixture(acknowledge = true) {
    const f = await fixture();
    const originalRun = vi.mocked(f.ctx.runtime.spawn).getMockImplementation()!;
    let release = () => {};
    const proceed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const question = {
      id: 'typed-worker-question',
      podId: f.podId,
      type: 'ask_human' as const,
      timestamp: new Date().toISOString(),
      payload: { question: 'Which original acceptance case should guide this implementation?' },
      response: null,
    };
    vi.mocked(f.ctx.runtime.spawn).mockImplementation(async function* (options) {
      question.timestamp = new Date().toISOString();
      f.ctx.escalationRepo.insert(question);
      yield {
        type: 'escalation',
        timestamp: question.timestamp,
        escalationType: 'ask_human',
        payload: question,
      } as const;
      await proceed;
      const guidance = f.ctx.nudgeRepo.readPending(f.podId);
      if (acknowledge && guidance)
        f.ctx.nudgeRepo.acknowledgeDelivery(f.podId, guidance.deliveryId);
      yield* originalRun(options);
    });
    const request = await f.request();
    await f.manager.authorizeRepairContinuation(f.podId, request, f.actor);
    await waitPreparation(f);
    const result = f.manager.processPod(f.podId).then(
      () => null,
      (error: unknown) => error,
    );
    try {
      await vi.waitFor(() => expect(f.pod().status).toBe('awaiting_input'));
    } catch (error) {
      release();
      await result;
      throw error;
    }
    return {
      ...f,
      question,
      result,
      finish: () => {
        release();
        return result;
      },
    };
  }
  it.each([
    true,
    false,
  ])('records the exact live answer, requiring guidance acknowledgement (ack=%s)', async (acknowledge) => {
    const f = await questioningFixture(acknowledge);
    const pods = f.ctx.podRepo;
    const before = f.pod();
    const worker = pods.retainedCoding!.latest(f.podId)!;
    const queue = f.ctx.nudgeRepo.queue.bind(f.ctx.nudgeRepo);
    vi.spyOn(f.ctx.nudgeRepo, 'queue').mockImplementation((id, message) => {
      expect(pods.retainedCoding!.isOwner(id)).toBe(true);
      expect(pods.retainedCheckpoints!.ownsRepairExecution(id)).toBe(false);
      expect(() =>
        pods.retainedCheckpoints!.infrastructureEvent(worker.id, 'stopped', {}),
      ).toThrow();
      expect(() => pods.retainedCheckpoints!.assertWorkerAllowed(id)).toThrow();
      return queue(id, message);
    });
    try {
      await expect(
        f.manager.sendMessage(f.podId, answer, { type: 'automation', id: 'not-human' }),
      ).rejects.toThrow('Authenticated human');
      const guard = vi
        .spyOn(pods.validationExecutions!, 'assertNoPendingRecovery')
        .mockImplementation(() => {
          throw new Error('Concurrent validation recovery is held');
        });
      await expect(f.manager.sendMessage(f.podId, answer, f.actor)).rejects.toThrow(
        'Concurrent validation recovery',
      );
      guard.mockRestore();
      await f.manager.sendMessage(f.podId, answer, f.actor);
      expect(f.pod().status).toBe('running');
      expect(f.ctx.escalationRepo.getOrThrow(f.question.id).response).toMatchObject({
        actor: f.actor,
        response: answer,
      });
      expect(f.ctx.nudgeRepo.readPending(f.podId)?.messages).toContain(answer);
      await expect(
        f.manager.sendMessage(f.podId, 'Second reply cannot resume or spawn', f.actor),
      ).rejects.toThrow('Retained continuation owns');
      expect(f.pod().budgetExtensionsUsed).toBe(before.budgetExtensionsUsed);
      expect(f.pod().lifecycleGeneration).toBe(before.lifecycleGeneration);
    } finally {
      await f.finish();
    }
    if (acknowledge) {
      expect(await f.result).toBeNull();
      expect(f.pod().status, f.pod().failureReason ?? '').toBe('validated');
      expect(f.ctx.nudgeRepo.hasPending(f.podId)).toBe(false);
    } else {
      expect(await f.result).not.toBeNull();
      expect(f.pod().status).not.toBe('validated');
      expect(f.ctx.nudgeRepo.hasPending(f.podId)).toBe(true);
      expect(f.ctx.validationEngine.validate).not.toHaveBeenCalled();
    }
    expect(f.ctx.runtime.spawn).toHaveBeenCalledTimes(1);
    expect(f.ctx.runtime.resume).not.toHaveBeenCalled();
    expect(f.ctx.db.prepare('SELECT * FROM retained_infrastructure_events').all()).toEqual([]);
  });
  it('answers a long-running live question after the consumed qualification receipt expires', async () => {
    const f = await questioningFixture();
    const receipt = f.ctx.podRepo.retainedCoding!.latest(f.podId)!.facts.qualified!;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse(receipt.expiresAt) + 60_000);
    try {
      expect(Date.now()).toBeGreaterThan(Date.parse(receipt.expiresAt));
      await f.manager.sendMessage(f.podId, answer, f.actor);
    } finally {
      await f.finish();
    }
    expect(await f.result).toBeNull();
    expect(f.pod().status, f.pod().failureReason ?? '').toBe('validated');
    expect(f.ctx.nudgeRepo.hasPending(f.podId)).toBe(false);
    expect(f.ctx.runtime.spawn).toHaveBeenCalledTimes(1);
    expect(f.ctx.runtime.resume).not.toHaveBeenCalled();
  });
  it.each([
    'dead-run',
    'generation',
    'candidate',
    'authority',
    'credential',
    'budget-pause',
    'question-race',
    'cold-manager',
    'process-epoch',
  ] as const)('refuses a stale or non-live question without recording guidance or replaying execution: %s', async (fault) => {
    const f = await questioningFixture();
    const pods = f.ctx.podRepo;
    const originalStore = pods.retainedCoding!;
    const record = originalStore.latest(f.podId)!;
    let manager = f.manager;
    let restore = () => {};
    const owned = <T>(run: () => T) =>
      pods.retainedCheckpoints!.owned(record.id, () => originalStore.owned(record.id, run));
    try {
      // Construct drift within the fixture's existing owner, not by relaxing
      // production custody guards or editing immutable worker/qualification facts.
      if (fault === 'dead-run')
        pods.taskExecutions!.finishRun(record.facts.worker!.runId, 'completed', null);
      if (fault === 'generation') owned(() => pods.incrementLifecycleGeneration(f.podId));
      if (fault === 'candidate') owned(() => pods.update(f.podId, { containerId: '3'.repeat(64) }));
      if (fault === 'authority')
        owned(() =>
          pods.update(f.podId, { providerAccountIdSnapshot: 'not-the-admitted-account' }),
        );
      if (fault === 'credential')
        owned(() =>
          pods.update(f.podId, {
            pendingEscalation: {
              ...f.question,
              type: 'request_credential',
              payload: { service: 'github', reason: 'No credential permit' },
            },
          }),
        );
      if (fault === 'budget-pause') owned(() => pods.update(f.podId, { pauseReason: 'budget' }));
      if (fault === 'cold-manager') manager = createPodManager(f.ctx.deps);
      if (fault === 'process-epoch') {
        vi.resetModules();
        const { createRetainedCodingRepository } = await import('./retained-coding-repository.js');
        pods.retainedCoding = createRetainedCodingRepository(f.ctx.db);
        expect(pods.retainedCoding.processEpoch).not.toBe(originalStore.processEpoch);
        restore = () => {
          pods.retainedCoding = originalStore;
        };
      }
      if (fault === 'question-race') {
        const roots = pods.retainedCheckpoints!;
        const owned = roots.owned.bind(roots);
        const spy = vi.spyOn(roots, 'owned').mockImplementation((id, run) =>
          owned(id, () => {
            pods.update(f.podId, {
              pendingEscalation: {
                ...f.question,
                payload: { question: 'Different question after reply admission' },
              },
            });
            return run();
          }),
        );
        restore = () => spy.mockRestore();
      }
      const before = f.pod();
      await expect(manager.sendMessage(f.podId, answer, f.actor)).rejects.toThrow(
        fault === 'question-race'
          ? 'Typed worker question ownership changed'
          : 'Retained continuation owns',
      );
      expect(f.ctx.escalationRepo.getOrThrow(f.question.id).response).toBeNull();
      expect(f.ctx.nudgeRepo.hasPending(f.podId)).toBe(false);
      expect(f.pod().budgetExtensionsUsed).toBe(before.budgetExtensionsUsed);
      expect(f.ctx.runtime.spawn).toHaveBeenCalledTimes(1);
      expect(f.ctx.runtime.resume).not.toHaveBeenCalled();
      expect(f.ctx.validationEngine.validate).not.toHaveBeenCalled();
    } finally {
      restore();
      await f.finish();
    }
    expect(f.ctx.runtime.spawn).toHaveBeenCalledTimes(1);
    expect(f.ctx.runtime.resume).not.toHaveBeenCalled();
  });
});
