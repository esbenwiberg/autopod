import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { InfrastructureRecoveryRequest } from '@autopod/shared';
import Dockerode from 'dockerode';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { errorHandler } from '../api/error-handler.js';
import { authPlugin } from '../api/plugins/auth.js';
import { checkpointRecoveryRoutes } from '../api/routes/checkpoint-recovery.js';
import {
  type RetainedExecutionSelection,
  retainedContinuationLaunch,
} from '../configuration/retained-continuation-launch.js';
import { DockerContainerManager } from '../containers/docker-container-manager.js';
import { environmentImageKey } from '../images/environment-image-key.js';
import type { PrManager } from '../interfaces/pr-manager.js';
import {
  materializeCheckpointFixture,
  recordPreValidationInfrastructure,
  retainedCheckpointFixture,
} from '../test-utils/retained-checkpoint-helpers.js';
import { terminationAuth } from '../test-utils/termination-reconciliation-helpers.js';
import { LocalWorktreeManager } from '../worktrees/local-worktree-manager.js';
import { createPodManager } from './pod-manager.js';
import { createRetainedCheckpointRecovery } from './retained-checkpoint-recovery.js';
import {
  assertCheckpointResourceNotRetained,
  checkpointHash,
  createRetainedCheckpointRepository,
} from './retained-checkpoint-repository.js';
import { assertSourceDeliveryAllowed } from './source-custody-guards.js';

const exec = promisify(execFile);
const fixtures: Awaited<ReturnType<typeof retainedCheckpointFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.recovery.wait(f.input.id);
    if (f.ctx.db.open) f.ctx.db.close();
    await rm(f.root, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});
async function fixture(mode: 'checks' | 'rework' = 'checks') {
  const f = await retainedCheckpointFixture('validation', true, false, true, 'local');
  fixtures.push(f);
  const launch = f.ctx.deps.launchConfiguration;
  if (!launch) throw new Error('Missing native launch');
  f.deps.readLaunch = launch.read;
  f.deps.executionSettings = launch.executionSettings;
  if (f.actor.type === 'human') f.actor.userId = 'operator-oid';
  f.deps.executionForPod = () => launch.executionSettings(launch.read(f.podId)!);
  recordPreValidationInfrastructure(f);
  await materializeCheckpointFixture(f);
  vi.stubEnv('DATA_DIR', f.root);
  let stopped = false;
  vi.mocked(f.cm.getStatus).mockImplementation(async (id) =>
    id === f.containerId ? (stopped ? 'stopped' : 'running') : 'running',
  );
  vi.mocked(f.cm.stop).mockImplementation(async (id) => {
    if (id !== f.containerId) return; // normal post-validation replacement stop is separate
    const op = f.recovery.list(f.podId)[0];
    expect(op?.prepared).toBeTruthy();
    expect(op?.infrastructure?.stopDispatched).toBe(true);
    expect(() => assertCheckpointResourceNotRetained(f.ctx.db, id)).toThrow();
    stopped = true;
  });
  const real = new LocalWorktreeManager({
    cacheDir: path.join(f.root, 'cache'),
    worktreeDir: path.join(f.root, 'unused'),
    logger: f.ctx.deps.logger,
  });
  f.worktrees.assertSourceDescendsFrom = real.assertSourceDescendsFrom.bind(real);
  f.worktrees.selectRetainedContinuationSource = vi.fn(async (input) => {
    const source = await f.worktrees.inspectSourceAdoption(input.worktreePath, input.branch);
    return { head: source.commitSha, tree: source.treeSha, baseCommitSha: f.input.checkpointHead };
  });
  f.recovery = createRetainedCheckpointRecovery(f.deps);
  const content =
    'Pinned, credential-free source context: fix the implementation against the actual upstream schema. Preserve the original task and checks.';
  const request: InfrastructureRecoveryRequest = {
    ...f.input,
    mode,
    qualification:
      'Owner inspected the reported runner/source limitation and selected preserved-source recovery with normal checks and review.',
    ...(mode === 'rework'
      ? { instructions: { content, sha256: createHash('sha256').update(content).digest('hex') } }
      : {}),
  };
  f.ctx.podRepo.taskRetries!.authorize(
    f.podId,
    'fresh-checks',
    'One fresh validation, separate from source selection and worker accounting',
    f.actor,
  );
  return {
    ...f,
    launch,
    request,
    stopped: () => stopped,
    markStopped: () => {
      stopped = true;
    },
  };
}
function passingReview(f: Awaited<ReturnType<typeof fixture>>) {
  const validate = vi.mocked(f.ctx.validationEngine.validate).getMockImplementation();
  if (!validate) throw new Error('Missing validation mock');
  vi.mocked(f.ctx.validationEngine.validate).mockImplementation(async (config) => ({
    ...(await validate(config)),
    taskReview: {
      status: 'pass',
      reasoning: 'New independent review of exact selected source',
      issues: [],
      model: 'fixture-reviewer',
      screenshots: [],
      diff: config.diff,
    },
  }));
}

function qualifiedExecution(f: Awaited<ReturnType<typeof fixture>>) {
  const parent = f.launch.read(f.podId)!;
  const environment = { ...parent.environment, template: 'node24' as const };
  const resolvedEnvironment = {
    ...parent.resolvedEnvironment,
    pinnedBase: `sha256:${'a'.repeat(64)}`,
  };
  resolvedEnvironment.imageKey = environmentImageKey({ environment, ...resolvedEnvironment });
  const selection: RetainedExecutionSelection = {
    profileId: 'qualified-local',
    parentDigest: parent.digest,
    environment,
    resolvedEnvironment,
    target: 'local',
    main: parent.resolvedExecution.main,
    resolvedExecution: parent.resolvedExecution,
    digest: '',
  };
  selection.digest = retainedContinuationLaunch(parent, f.podId, selection).digest;
  f.deps.previewExecution = async () => structuredClone(selection);
  f.request.executionProfileId = selection.profileId;
  f.request.expectedExecutionDigest = selection.digest;
  return { parent, selection };
}
function delivery(f: Awaited<ReturnType<typeof fixture>>) {
  const target = {
    repository: f.deps.executionForPod(f.pod()).repoUrl.replace(/\.git$/, ''),
    branch: f.pod().branch,
    baseBranch: 'main',
  };
  const source = async () =>
    f.worktrees.inspectSourceAdoption(f.pod().worktreePath!, f.pod().branch);
  vi.mocked(f.ctx.worktreeManager.inspectSource).mockImplementation(async (_dir, branch) => ({
    ...(await source()),
    branch,
  }));
  vi.mocked(f.ctx.worktreeManager.pushBranch).mockImplementation(async (_dir, branch, options) => {
    const snapshot = await source();
    const receipt = {
      ...snapshot,
      branch,
      repository: target.repository,
      remoteRef: `refs/heads/${branch}`,
      observedRemoteCommitSha: snapshot.commitSha,
      observedAt: new Date().toISOString(),
    };
    options?.onPrepared?.(receipt);
    return receipt;
  });
  let merged = false;
  const provider = {
    findPr: vi.fn<NonNullable<PrManager['findPr']>>(async () => null),
    createPr: vi.fn<PrManager['createPr']>(async () => ({
      url: `${target.repository}/pull/27`,
      usedFallback: false,
    })),
    getPrStatus: vi.fn<PrManager['getPrStatus']>(async () => ({
      merged,
      open: !merged,
      ciFailures: [],
      reviewComments: [],
      headSha: (await source()).commitSha,
      sourceTarget: target,
      reviewDecision: 'APPROVED',
      mergeBlocked: false,
    })),
    mergePr: vi.fn<PrManager['mergePr']>(async (config) => {
      config.onPrepared?.();
      merged = true;
      return {
        merged: true,
        autoMergeScheduled: false,
        source: {
          headSha: config.expectedHeadSha!,
          target: config.expectedTarget!,
          observedAt: new Date().toISOString(),
        },
      };
    }),
  } satisfies PrManager;
  f.ctx.deps.prManagerFactory = () => provider;
  f.manager = createPodManager(f.ctx.deps);
  return provider;
}
async function publishAndComplete(
  f: Awaited<ReturnType<typeof fixture>>,
  provider: ReturnType<typeof delivery>,
) {
  await expect(
    f.manager.approveSession(f.podId, { actor: { type: 'automation', id: 'not-an-approval' } }),
  ).rejects.toThrow('fresh authenticated human approval');
  await f.manager.approveSession(f.podId, {
    publishOnly: true,
    actor: f.actor,
    reason:
      'Publish this exact freshly checked and independently reviewed source, without merge authority',
  });
  expect(f.pod().status).toBe('validated');
  expect(f.pod().prUrl).toContain('/pull/27');
  expect(provider.createPr).toHaveBeenCalledTimes(1);
  expect(provider.mergePr).not.toHaveBeenCalled();
  await f.manager.approveSession(f.podId, {
    actor: f.actor,
    reason: 'Approve the published exact source for normal provider-confirmed delivery',
  });
  expect(f.pod().status, f.pod().failureReason ?? '').toBe('complete');
  expect(provider.mergePr).toHaveBeenCalledTimes(1);
  expect(f.cm.kill).not.toHaveBeenCalledWith(f.containerId);
  expect(() => assertCheckpointResourceNotRetained(f.ctx.db, f.containerId)).toThrow();
}

describe('qualified infrastructure recovery from real incident shapes', () => {
  it('preserves the running original before one stop, runs checks without coding, and retains exact publication proof', async () => {
    const f = await fixture();
    const original = f.pod();
    passingReview(f);
    const provider = delivery(f);
    const app = Fastify();
    app.setErrorHandler(errorHandler);
    authPlugin(app, terminationAuth());
    checkpointRecoveryRoutes(app, {
      ...f.manager,
      recoverInfrastructure: f.recovery.recoverInfrastructure,
      reconcileInfrastructure: f.recovery.reconcileInfrastructure,
      getCheckpointRecoveries: f.recovery.list,
    });
    let admittedId = '';
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/pods/${f.podId}/infrastructure-recovery`,
        headers: { authorization: 'Bearer human-token' },
        payload: f.request,
      });
      expect(response.statusCode, response.body).toBe(202);
      admittedId = response.json<{ operation: { id: string } }>().operation.id;
    } finally {
      await app.close();
    }
    await f.recovery.wait(f.input.id);
    expect(f.recovery.list(f.podId)[0]?.blocked).toBeNull();
    expect(f.stopped()).toBe(true);
    expect(f.cm.stop).toHaveBeenCalledTimes(1);
    expect(f.pod()).toMatchObject({
      status: 'queued',
      skipAgent: true,
      lifecycleGeneration: 2,
      validationAttempts: original.validationAttempts,
    });
    await f.manager.processPod(f.podId);
    const record = f.recovery.list(f.podId)[0]!;
    expect(record.blocked, f.pod().failureReason ?? '').toBeNull();
    expect(f.pod().status, f.pod().failureReason ?? '').toBe('validated');
    expect(record.checked?.result.taskReview?.status).toBe('pass');
    expect(() => assertSourceDeliveryAllowed(f.ctx.db, f.podId)).not.toThrow();
    expect(await readFile(path.join(original.worktreePath!, 'source.ts'), 'utf8')).toBe(
      'export const preserved = true;\n',
    );
    expect(f.ctx.runtime.spawn).not.toHaveBeenCalled();
    expect(f.cm.kill).not.toHaveBeenCalled();
    const replay = await f.recovery.recoverInfrastructure(f.podId, f.request, f.actor);
    expect(replay.id).toBe(admittedId);
    expect(vi.mocked(f.cm.stop).mock.calls.filter(([id]) => id === f.containerId)).toHaveLength(1);
    expect(f.deps.enqueue).toHaveBeenCalledTimes(1);
    await publishAndComplete(f, provider);
  });

  it('starts exactly one real manager-owned coding repair, freezes its descendant, then independently checks it', async () => {
    const f = await fixture('rework');
    const original = f.pod();
    const before = f.ctx.podRepo.taskExecutions!.snapshot(f.podId);
    const { parent, selection } = qualifiedExecution(f);
    passingReview(f);
    const provider = delivery(f);
    vi.mocked(f.ctx.runtime.spawn).mockImplementation(async function* (options) {
      expect(options.task).toContain(f.request.instructions!.content);
      const current = f.pod();
      expect(current.worktreePath).not.toBe(original.worktreePath);
      await writeFile(
        path.join(current.worktreePath!, 'source.ts'),
        'export const preserved = true;\nexport const repaired = true;\n',
      );
      await exec('git', ['add', 'source.ts'], { cwd: current.worktreePath! });
      await exec(
        'git',
        [
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          'commit',
          '-m',
          'fix: complete preserved implementation',
        ],
        { cwd: current.worktreePath! },
      );
      f.ctx.podRepo.update(f.podId, {
        taskSummary: {
          actualSummary: 'Repaired the preserved implementation',
          how: 'Updated source and tests',
          deviations: [],
        },
      });
      yield {
        type: 'complete' as const,
        timestamp: new Date().toISOString(),
        result: 'Repair complete; fresh checks remain daemon-owned',
      };
    });
    await f.recovery.recoverInfrastructure(f.podId, f.request, f.actor);
    await f.recovery.wait(f.input.id);
    expect(f.pod()).toMatchObject({
      skipAgent: false,
      status: 'queued',
      lifecycleGeneration: 2,
      launchConfigDigest: selection.digest,
    });
    expect(f.launch.read(f.podId)?.workflow).toEqual(parent.workflow);
    expect(f.launch.read(f.podId)?.ai).toEqual(parent.ai);
    await f.manager.processPod(f.podId).catch((error) => {
      throw new Error(`status=${f.pod().status}; ${f.pod().failureReason}`, { cause: error });
    });
    const record = f.recovery.list(f.podId)[0]!;
    expect(record.blocked, f.pod().failureReason ?? JSON.stringify(record)).toBeNull();
    expect(f.pod().status, f.pod().failureReason ?? '').toBe('validated');
    expect(record.infrastructure?.candidate?.head).not.toBe(record.prepared?.head);
    expect(record.checked?.source?.tree).toBe(record.infrastructure?.candidate?.tree);
    expect(record.checked?.result.taskReview?.status).toBe('pass');
    expect(f.ctx.runtime.spawn).toHaveBeenCalledTimes(1);
    expect(f.ctx.runtime.resume).not.toHaveBeenCalled();
    expect(f.ctx.podRepo.taskExecutions!.snapshot(f.podId).taskId).toBe(before.taskId);
    expect(f.ctx.podRepo.taskExecutions!.snapshot(f.podId).agentRunCount).toBe(
      before.agentRunCount + 1,
    );
    expect(await readFile(path.join(original.worktreePath!, 'source.ts'), 'utf8')).toBe(
      'export const preserved = true;\n',
    );
    expect(() => assertSourceDeliveryAllowed(f.ctx.db, f.podId)).not.toThrow();
    expect(f.cm.kill).not.toHaveBeenCalled();
    const reopened = createRetainedCheckpointRepository(f.ctx.db);
    expect(() => f.manager.assertCanRework(f.podId)).toThrow('Retained continuation owns');
    expect(reopened.ownsRepairExecution(f.podId)).toBe(false);
    await publishAndComplete(f, provider);
  });

  it('does not replay an uncertain stop, including through a reconstructed controller', async () => {
    const f = await fixture();
    vi.mocked(f.cm.stop).mockImplementation(async () => {
      throw new Error('Lost provider response');
    });
    await f.recovery.recoverInfrastructure(f.podId, f.request, f.actor);
    await f.recovery.wait(f.input.id);
    expect(f.pod().lifecycleGeneration).toBe(1);
    expect(f.recovery.list(f.podId)[0]).toMatchObject({
      activated: null,
      blocked: null,
      infrastructure: { stopDispatched: true, stopped: false },
    });
    const reopened = createRetainedCheckpointRecovery(f.deps);
    await Promise.all([
      reopened.reconcileInfrastructure(f.podId, f.request, f.actor),
      reopened.reconcileInfrastructure(f.podId, f.request, f.actor),
    ]);
    expect(f.cm.stop).toHaveBeenCalledTimes(1);
    f.markStopped();
    await reopened.reconcileInfrastructure(f.podId, f.request, f.actor);
    expect(f.pod().lifecycleGeneration).toBe(2);
    expect(f.cm.stop).toHaveBeenCalledTimes(1);
    expect(f.deps.enqueue).toHaveBeenCalledTimes(1);
  });

  it.each([
    'dirty-source',
    'active-control',
    'active-worker',
    'uncollected-guidance',
    'shared-resource',
    'missing-reviewer',
    'unpreserved-source',
    'stale-report',
    'unknown-provider',
  ] as const)('refuses %s before custody or provider stop', async (fault) => {
    const f = await fixture();
    if (fault === 'dirty-source')
      await writeFile(path.join(f.pod().worktreePath!, 'source.ts'), 'uncommitted change');
    if (fault === 'active-control') f.deps.isIdle = () => false;
    if (fault === 'active-worker')
      f.ctx.podRepo.taskExecutions!.beginRun(f.podId, f.pod().lifecycleGeneration, 1, {
        runtime: f.pod().runtime,
        model: f.pod().model,
        providerAccountId: null,
        resource: { containerId: f.containerId, executionTarget: 'local' },
      });
    if (fault === 'uncollected-guidance')
      f.deps.assertGuidanceCollected = () => {
        throw new Error('Uncollected guidance');
      };
    if (fault === 'shared-resource') {
      const other = f.manager.createResolvedSession(f.launch.read(f.podId)!, 'operator');
      f.ctx.podRepo.update(other.id, { containerId: f.containerId });
    }
    if (fault === 'missing-reviewer') {
      const read = f.launch.read;
      f.deps.readLaunch = (id) => {
        const value = read(id)!;
        return { ...value, ai: { ...value.ai, reviewer: { mode: 'off' } } };
      };
    }
    if (fault === 'unpreserved-source')
      f.ctx.db
        .prepare('UPDATE pod_finalizations SET source_preserved_at=NULL WHERE pod_id=?')
        .run(f.podId);
    if (fault === 'stale-report') f.request.expectedResultHash = checkpointHash(null);
    if (fault === 'unknown-provider') vi.mocked(f.cm.getStatus).mockResolvedValue('unknown');
    await expect(f.recovery.recoverInfrastructure(f.podId, f.request, f.actor)).rejects.toThrow();
    expect(f.recovery.list(f.podId)).toEqual([]);
    expect(f.cm.stop).not.toHaveBeenCalled();
    expect(f.cm.kill).not.toHaveBeenCalled();
    expect(f.pod().lifecycleGeneration).toBe(1);
  });

  it.each([
    'generation',
    'report',
    'provider-namespace',
    'source',
  ] as const)('retains custody and refuses dispatch after %s drift during preparation', async (fault) => {
    const f = await fixture();
    const prepare = f.deps.prepare!;
    f.deps.prepare = async (input) => {
      const prepared = await prepare(input);
      // Real SQLite drift injection emulates a stale/out-of-band observation, never a production operation.
      if (fault === 'generation')
        f.ctx.db
          .prepare('UPDATE pods SET lifecycle_generation=lifecycle_generation+1 WHERE id=?')
          .run(f.podId);
      if (fault === 'report')
        f.ctx.db.prepare("UPDATE escalation_requests SET payload='{}' WHERE pod_id=?").run(f.podId);
      if (fault === 'provider-namespace')
        vi.mocked(f.cm.getResourceKey!).mockResolvedValue('different-provider:resource');
      if (fault === 'source')
        await writeFile(
          path.join(f.pod().worktreePath!, 'source.ts'),
          'drift during independent preparation',
        );
      return prepared;
    };
    await f.recovery.recoverInfrastructure(f.podId, f.request, f.actor);
    await f.recovery.wait(f.input.id);
    expect(f.recovery.list(f.podId)[0]?.activated).toBeNull();
    expect(f.recovery.list(f.podId)[0]?.blocked).toBeTruthy();
    expect(f.cm.stop).not.toHaveBeenCalled();
    expect(f.deps.enqueue).not.toHaveBeenCalled();
    expect(() => assertCheckpointResourceNotRetained(f.ctx.db, f.containerId)).toThrow();
  });

  it('leaves a new infrastructure failure blocked without launching another coding worker', async () => {
    const f = await fixture('rework');
    vi.mocked(f.ctx.runtime.spawn).mockImplementation(async function* () {
      yield {
        type: 'complete' as const,
        timestamp: new Date().toISOString(),
        result: 'No further code required; checks remain required',
      };
    });
    const validate = vi.mocked(f.ctx.validationEngine.validate).getMockImplementation()!;
    vi.mocked(f.ctx.validationEngine.validate).mockImplementation(async (config) => {
      const result = await validate(config);
      return {
        ...result,
        overall: 'fail',
        taskReview: {
          status: 'fail',
          reasoning: 'The required runner is unavailable',
          issues: [
            {
              description: 'Required independent runner unavailable',
              severity: 'blocking',
              category: 'infrastructure',
            },
          ],
          model: 'fixture',
          screenshots: [],
          diff: config.diff,
        },
      };
    });
    await f.recovery.recoverInfrastructure(f.podId, f.request, f.actor);
    await f.recovery.wait(f.input.id);
    await f.manager.processPod(f.podId);
    expect(f.ctx.runtime.spawn).toHaveBeenCalledTimes(1);
    expect(f.pod().status).not.toBe('queued');
    expect(f.deps.enqueue).toHaveBeenCalledTimes(1);
    expect(() => assertSourceDeliveryAllowed(f.ctx.db, f.podId)).toThrow();
    expect(f.ctx.worktreeManager.pushBranch).not.toHaveBeenCalled();
    expect(f.ctx.worktreeManager.mergeBranch).not.toHaveBeenCalled();
  });

  it.each([
    'dirty-candidate',
    'resource-drift',
    'worker-failure',
  ] as const)('holds %s without a second worker or publication', async (fault) => {
    const f = await fixture('rework');
    passingReview(f);
    vi.mocked(f.ctx.runtime.spawn).mockImplementation(async function* () {
      if (fault === 'dirty-candidate')
        await writeFile(
          path.join(f.pod().worktreePath!, 'source.ts'),
          'Uncommitted repair candidate',
        );
      if (fault === 'resource-drift')
        f.ctx.db
          .prepare('UPDATE pods SET container_id=? WHERE id=?')
          .run('another-replacement', f.podId);
      if (fault === 'worker-failure')
        throw new Error('Coding execution failed before producing a qualified candidate');
      yield {
        type: 'complete' as const,
        timestamp: new Date().toISOString(),
        result: 'Execution ended; independently inspect actual source',
      };
    });
    await f.recovery.recoverInfrastructure(f.podId, f.request, f.actor);
    await f.recovery.wait(f.input.id);
    await expect(f.manager.processPod(f.podId)).rejects.toThrow();
    expect(f.recovery.list(f.podId)[0]?.blocked).toBeTruthy();
    expect(f.ctx.runtime.spawn).toHaveBeenCalledTimes(1);
    expect(f.ctx.validationEngine.validate).not.toHaveBeenCalled();
    await expect(f.manager.processPod(f.podId)).rejects.toThrow();
    expect(f.ctx.runtime.spawn).toHaveBeenCalledTimes(1);
    expect(f.ctx.worktreeManager.pushBranch).not.toHaveBeenCalled();
    expect(f.ctx.worktreeManager.mergeBranch).not.toHaveBeenCalled();
    expect(() => assertCheckpointResourceNotRetained(f.ctx.db, f.containerId)).toThrow();
  });

  it.each([
    true,
    false,
  ])('answers only the owned repair question, preserving guidance acknowledgement (ack=%s)', async (acknowledge) => {
    const f = await fixture('rework');
    passingReview(f);
    let release = () => {};
    const proceed = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(f.ctx.runtime.spawn).mockImplementation(async function* () {
      const question = {
        id: 'repair-decision',
        podId: f.podId,
        type: 'ask_human' as const,
        timestamp: new Date().toISOString(),
        payload: { question: 'Which original acceptance case should guide the preserved repair?' },
        response: null,
      };
      f.ctx.escalationRepo.insert(question);
      yield {
        type: 'escalation' as const,
        timestamp: question.timestamp,
        escalationType: 'ask_human' as const,
        payload: question,
      };
      await proceed;
      const guidance = f.ctx.deps.nudgeRepo.readPending(f.podId);
      expect(guidance?.messages).toContain(
        'Use the actual pinned schema and preserve the original acceptance requirements',
      );
      if (acknowledge && guidance)
        f.ctx.deps.nudgeRepo.acknowledgeDelivery(f.podId, guidance.deliveryId);
      yield {
        type: 'complete' as const,
        timestamp: new Date().toISOString(),
        result: 'Original source inspected; independent checks remain required',
      };
    });
    await f.recovery.recoverInfrastructure(f.podId, f.request, f.actor);
    await f.recovery.wait(f.input.id);
    const run = f.manager.processPod(f.podId);
    try {
      await vi.waitFor(() => expect(f.pod().status).toBe('awaiting_input'));
      await expect(
        f.manager.sendMessage(f.podId, 'Not an authenticated decision', {
          type: 'automation',
          id: 'fixture',
        }),
      ).rejects.toThrow('Authenticated human');
      const recoveryGuard = vi
        .spyOn(f.ctx.podRepo.validationExecutions!, 'assertNoPendingRecovery')
        .mockImplementation(() => {
          throw new Error('Concurrent validation recovery remains held');
        });
      await expect(
        f.manager.sendMessage(f.podId, 'Do not bypass another recovery', f.actor),
      ).rejects.toThrow('Concurrent validation recovery');
      expect(f.pod().pendingEscalation?.id).toBe('repair-decision');
      recoveryGuard.mockRestore();
      await f.manager.sendMessage(
        f.podId,
        'Use the actual pinned schema and preserve the original acceptance requirements',
        f.actor,
      );
      expect(f.pod().status).toBe('running');
      expect(f.ctx.deps.nudgeRepo.hasPending(f.podId)).toBe(true);
      expect(f.ctx.escalationRepo.getOrThrow('repair-decision').response).toMatchObject({
        actor: f.actor,
        response: 'Use the actual pinned schema and preserve the original acceptance requirements',
      });
      await expect(
        f.manager.sendMessage(f.podId, 'A second reply must not resume a new coding turn', f.actor),
      ).rejects.toThrow('Retained continuation owns');
    } finally {
      release();
    }
    if (acknowledge) {
      await run.catch((error) => {
        throw new Error(`${f.pod().status}: ${f.pod().failureReason}`, { cause: error });
      });
      expect(f.pod().status, f.pod().failureReason ?? '').toBe('validated');
      expect(f.ctx.deps.nudgeRepo.hasPending(f.podId)).toBe(false);
    } else {
      await expect(run).rejects.toThrow();
      expect(f.pod().status).not.toBe('validated');
      expect(f.pod().failureReason?.toLowerCase()).toContain('guidance');
      expect(f.ctx.validationEngine.validate).not.toHaveBeenCalled();
      expect(f.ctx.deps.nudgeRepo.hasPending(f.podId)).toBe(true);
    }
    expect(f.ctx.runtime.spawn).toHaveBeenCalledTimes(1);
    expect(f.ctx.runtime.resume).not.toHaveBeenCalled();
    expect(vi.mocked(f.cm.stop).mock.calls.filter(([id]) => id === f.containerId)).toHaveLength(1);
  });

  it('rejects changed actor/context on replay or reconciliation', async () => {
    const f = await fixture('rework');
    vi.mocked(f.cm.stop).mockRejectedValue(new Error('Unknown provider stop outcome'));
    await f.recovery.recoverInfrastructure(f.podId, f.request, f.actor);
    await f.recovery.wait(f.input.id);
    await expect(
      f.recovery.recoverInfrastructure(
        f.podId,
        {
          ...f.request,
          qualification: 'Different qualified software selection after the original admission',
        },
        f.actor,
      ),
    ).rejects.toThrow('different source or actor');
    await expect(
      f.recovery.reconcileInfrastructure(f.podId, f.request, { type: 'human', userId: 'other' }),
    ).rejects.toThrow('exact original request');
    await expect(
      f.recovery.reconcileInfrastructure(
        f.podId,
        {
          ...f.request,
          instructions: {
            ...f.request.instructions!,
            content: 'Changed bytes with an old checksum',
          },
        },
        f.actor,
      ),
    ).rejects.toThrow('exact original request');
    expect(f.cm.stop).toHaveBeenCalledTimes(1);
  });

  it.each([
    'checks',
    'rework',
  ] as const)('admits %s through the real facade without self-conflicting on control quiescence', async (mode) => {
    const f = await fixture(mode);
    f.manager = createPodManager(f.ctx.deps);
    await f.manager.recoverInfrastructure(f.podId, f.request, f.actor);
    await vi.waitFor(() =>
      expect(
        f.manager.getCheckpointRecoveries(f.podId)[0]?.activated,
        f.pod().failureReason ?? '',
      ).toEqual({ generation: 2 }),
    );
    expect(f.manager.getCheckpointRecoveries(f.podId)[0]?.blocked).toBeNull();
    expect(f.pod().skipAgent).toBe(mode === 'checks');
    expect(f.cm.stop).toHaveBeenCalledTimes(1);
    expect(f.ctx.runtime.spawn).not.toHaveBeenCalled();
  });

  it.skipIf(!process.env.AUTOPOD_RECOVERY_DOCKER_FIXTURE_IMAGE)(
    'qualifies controller-owned stop against one disposable local Docker container, without mounts, network or deletion',
    async () => {
      const image = process.env.AUTOPOD_RECOVERY_DOCKER_FIXTURE_IMAGE;
      const socketPath = process.env.AUTOPOD_RECOVERY_DOCKER_FIXTURE_SOCKET;
      if (!image?.startsWith('sha256:') || !socketPath)
        throw new Error('Explicit cached image ID and local socket required');
      const docker = new Dockerode({ socketPath });
      await docker.getImage(image).inspect();
      const owned = await docker.createContainer({
        Image: image,
        Cmd: ['sleep', '300'],
        User: '1000:1000',
        Labels: { 'autopod.fixture': 'infrastructure-recovery' },
        HostConfig: {
          NetworkMode: 'none',
          ReadonlyRootfs: true,
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges'],
          Memory: 67108864,
          PidsLimit: 32,
        },
      });
      try {
        await owned.start();
        const f = await fixture();
        f.ctx.podRepo.update(f.podId, { containerId: owned.id });
        const cm = new DockerContainerManager({
          docker,
          logger: f.ctx.deps.logger,
          managedDatabase: f.ctx.db,
        });
        f.deps.getContainerManager = () => cm;
        await f.recovery.recoverInfrastructure(f.podId, f.request, f.actor);
        await f.recovery.wait(f.input.id);
        const record = f.recovery.list(f.podId)[0]!;
        expect(record.blocked).toBeNull();
        expect(record.containerId).toBe(owned.id);
        expect(record.infrastructure).toMatchObject({ stopDispatched: true, stopped: true });
        expect(record.activated).toEqual({ generation: 2 });
        expect(await cm.getStatus(owned.id)).toBe('stopped');
        expect((await owned.inspect()).Config.Labels['autopod.fixture']).toBe(
          'infrastructure-recovery',
        );
        await expect(cm.stop(owned.id)).rejects.toThrow('Original continuation resource');
        await expect(cm.kill(owned.id)).rejects.toThrow('Original continuation resource');
        await expect(cm.execInContainer(owned.id, ['true'])).rejects.toThrow(
          'Original continuation resource',
        );
        expect(f.ctx.podRepo.listReferencedContainerIds()).toContain(owned.id);
        expect(f.ctx.runtime.spawn).not.toHaveBeenCalled();
      } finally {
        await owned.remove({ force: true });
      }
    },
    15000,
  );

  it('refuses unverified repair inputs and preserves old stopped-only admission', async () => {
    const f = await fixture('rework');
    await expect(
      f.recovery.recoverInfrastructure(
        f.podId,
        { ...f.request, instructions: { ...f.request.instructions!, sha256: '0'.repeat(64) } },
        f.actor,
      ),
    ).rejects.toThrow('checksummed');
    await expect(f.recovery.continueRetained(f.podId, f.input, f.actor)).rejects.toThrow(
      'stopped original',
    );
    expect(f.recovery.list(f.podId)).toEqual([]);
    expect(f.cm.stop).not.toHaveBeenCalled();
  });
});
