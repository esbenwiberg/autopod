import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  AgentEvent,
  ExecutionRequirements,
  RepairContinuationRequestV1,
} from '@autopod/shared';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
async function fixture() {
  const f = await retainedCheckpointFixture('validation', true, true, requirements);
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
    resource: { containerId: f.containerId, executionTarget: 'sandbox' },
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
