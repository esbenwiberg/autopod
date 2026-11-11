import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ArtifactChecksRecoveryRequest } from '@autopod/shared';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { errorHandler } from '../api/error-handler.js';
import { authPlugin } from '../api/plugins/auth.js';
import { artifactChecksRecoveryRoutes } from '../api/routes/artifact-checks-recovery.js';
import { resolveLaunchAgentRoute } from '../configuration/agent-route-resolution.js';
import { configurationDigest } from '../configuration/configuration-digest.js';
import { admitLaunch } from '../configuration/launch-admission.js';
import { resolveLaunchExecutionSettings } from '../configuration/launch-execution-settings.js';
import { createLaunchSnapshotRepository } from '../configuration/launch-snapshot.js';
import { createDatabase } from '../db/connection.js';
import { createProviderAccountStore } from '../provider-accounts/provider-account-store.js';
import { createTestConfiguration } from '../test-utils/configuration-helpers.js';
import { createPassingValidationResult, createTestContext } from '../test-utils/mock-helpers.js';
import { terminationAuth } from '../test-utils/termination-reconciliation-helpers.js';
import { IsolatedReviewer } from '../validation/isolated-reviewer.js';
import { ReviewerRunRepository } from '../validation/reviewer-run-repository.js';
import { artifactReviewContents } from './artifact-checks-recovery.js';
import { createPodManager } from './pod-manager.js';
import { createPodRepository, type PodRepository } from './pod-repository.js';
import { assertCheckpointResourceNotRetained } from './retained-checkpoint-repository.js';
import { assertSourceAvailable, assertSourceDeliveryAllowed } from './source-custody-guards.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
async function fixture() {
  const ctx = createTestContext();
  const root = await mkdtemp(path.join(os.tmpdir(), 'artifact-checks-'));
  vi.stubEnv('DATA_DIR', root);
  const original = path.join(root, 'original');
  await mkdir(original);
  await writeFile(path.join(original, 'source.js'), 'export const answer = 42;\n');
  await writeFile(path.join(original, '.gitignore'), 'ignored-report.txt\n');
  await writeFile(path.join(original, 'ignored-report.txt'), 'Retain this original report\n');
  const { store, services } = createTestConfiguration(ctx.db);
  const snapshots = createLaunchSnapshotRepository(ctx.db, store);
  const accounts = createProviderAccountStore(ctx.db);
  accounts.create({
    id: 'account',
    name: 'Fixture account',
    provider: 'anthropic',
    credentials: { provider: 'anthropic', apiKey: 'fixture-only' },
  });
  services.resolveAgentRoute = async (route) => resolveLaunchAgentRoute(route, accounts);
  ctx.deps.providerAccountStore = accounts;
  const cm = ctx.containerManager;
  const image = `sha256:${'a'.repeat(64)}`;
  const reviewer = new IsolatedReviewer({
    runs: new ReviewerRunRepository(ctx.db),
    accounts,
    logger: ctx.deps.logger,
    manager: () => cm,
    image: () => image,
    readPod: (id) => ctx.podRepo.getOrThrow(id),
    assertAllowed: async () => {},
  });
  // The paid reviewer execution is a boundary double. Selection still resolves the frozen route.
  const review = vi.fn();
  vi.spyOn(reviewer, 'executor').mockReturnValue(review);
  ctx.deps.launchConfiguration = {
    read: snapshots.get,
    executionSettings: (config) => resolveLaunchExecutionSettings(config, { image }),
    assertCurrentCapabilities: vi.fn(async () => {}),
    prepareEnvironment: vi.fn(async () => image),
    reviewer,
  };
  let manager = createPodManager(ctx.deps);
  const requirements = {
    version: 2 as const,
    executables: ['node'],
    platform: 'linux/amd64' as const,
  };
  const contract = {
    contractVersion: 1 as const,
    title: 'Artifact facts',
    dependsOn: [],
    scenarios: [
      // biome-ignore lint/suspicious/noThenProperty: executable contract scenario schema
      { id: 'contents', given: ['Artifact source'], when: ['Checked'], then: ['Answer holds'] },
    ],
    humanReview: [],
    executionRequirements: requirements,
    requiredFacts: [
      {
        id: 'answer',
        proves: ['contents'],
        kind: 'custom-command' as const,
        artifact: { path: 'source.js', change: 'create' as const },
        command: 'node source.js',
      },
    ],
  };
  const admitted = await admitLaunch({
    request: {
      emptyWorkspace: true,
      profileId: 'profile',
      task: 'Check existing artifact',
      work: { contract },
      overrides: {
        workflow: { output: 'artifact', validationPhases: ['facts', 'review'], tokenBudget: null },
        ai: {
          reviewer: {
            mode: 'independent',
            route: { providerAccountId: 'account', runtime: 'claude', model: 'claude-opus-4-6' },
          },
        },
      },
    },
    actorId: 'operator-oid',
    services,
    snapshots,
    createPod: (config) => manager.createResolvedSession(config, 'operator-oid').id,
  });
  const podId = admitted.podId;
  const pod = () => ctx.podRepo.getOrThrow(podId);
  ctx.podRepo.update(podId, { status: 'running', containerId: 'original-container' });
  ctx.podRepo.completionJournal!.begin(pod());
  const cycle = pod().finalization!.cycle;
  const run = ctx.podRepo.taskExecutions!.beginRun(podId, pod().lifecycleGeneration, cycle, {
    runtime: pod().runtime,
    model: pod().model,
    providerAccountId: pod().providerAccountIdSnapshot,
    resource: { containerId: pod().containerId, executionTarget: 'local' },
  });
  ctx.podRepo.taskExecutions!.finishRun(run, 'failed', null);
  ctx.podRepo.completionJournal!.settle(pod(), 'Settled existing artifact');
  ctx.podRepo.completionJournal!.mark(pod(), 'ready');
  ctx.podRepo.update(podId, { status: 'failed', tokenTelemetryAccuracy: 'complete' });
  ctx.escalationRepo.insert({
    id: 'launcher-report',
    podId,
    type: 'report_blocker',
    timestamp: new Date().toISOString(),
    response: null,
    payload: {
      kind: 'infrastructure',
      lifecycleGeneration: pod().lifecycleGeneration,
      requiresResponse: false,
      owner: 'validation',
      phase: 'Prerequisite lookup',
      description: 'Required launcher unavailable',
      attempted: ['node lookup'],
      needs: 'Frozen declared node launcher',
      prerequisiteBlocker: {
        version: 1,
        kind: 'missing-execution-prerequisites',
        requirementsHash: configurationDigest(requirements),
        launchers: ['node'],
      },
    },
  });
  let stopped = false;
  let spawned: Parameters<typeof cm.spawn>[0] | undefined;
  Object.assign(cm, {
    supportsStreamingExec: true,
    getResourceKey: vi.fn(async (id: string) => `docker:fixture:${id}`),
    getExecutionMetadata: vi.fn(async () => ({
      workspaceStorage: 'container',
      podId,
      resourceIdentity: spawned?.resourceIdentity,
      imageDigest: image,
      memoryLimitBytes: admitted.config.resolvedExecution.main.memoryGb * 1024 ** 3,
      cpuLimit: 1,
      networkMode: 'isolated',
    })),
  });
  vi.mocked(cm.getStatus).mockImplementation(async (id) =>
    id === 'original-container' ? (stopped ? 'stopped' : 'running') : 'running',
  );
  vi.mocked(cm.stop).mockImplementation(async () => {
    stopped = true;
  });
  vi.mocked(cm.spawn).mockImplementation(async (config) => {
    spawned = config;
    config.onCreated?.('checks-container');
    return 'checks-container';
  });
  vi.mocked(cm.extractDirectoryFromContainer).mockImplementation(async (id, _remote, target) => {
    await cp(id === 'original-container' ? original : spawned!.volumes![0]!.host, target, {
      recursive: true,
    });
  });
  vi.mocked(cm.execInContainer).mockImplementation(async (_id, command) => {
    if (command.includes('--version')) return { exitCode: 0, stdout: 'claude 2.0.1', stderr: '' };
    if (command[2]?.includes('autopod-command-preflight-v1'))
      return {
        exitCode: 0,
        stdout: JSON.stringify([{ executable: 'node', available: true }]),
        stderr: '',
      };
    if (command[2]?.includes('process.getuid'))
      return {
        exitCode: 0,
        stdout: JSON.stringify({ platform: 'linux/amd64', uid: 1000, cwd: '/workspace' }),
        stderr: '',
      };
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  vi.mocked(ctx.validationEngine.validate).mockImplementation(async (config) => {
    await config.artifactSource!.verify();
    expect(config.diff).toContain('+export const answer = 42;');
    expect(config.preSubmitReview).toBeUndefined();
    expect(config.startCommitSha).toBeUndefined();
    const result = createPassingValidationResult(podId, config.attempt);
    result.factValidation = {
      status: 'pass',
      results: [
        {
          factId: 'answer',
          proves: [],
          command: 'node source.js',
          artifactPath: 'source.js',
          passed: true,
          status: 'pass',
          exitCode: 0,
          reasoning: 'Executed frozen Fact',
        },
      ],
    };
    result.taskReview = {
      status: 'pass',
      reasoning: 'Fresh independent content review',
      issues: [],
      model: 'fixture-reviewer',
      screenshots: [],
      diff: config.diff,
    };
    return result;
  });
  const app = Fastify();
  app.setErrorHandler(errorHandler);
  authPlugin(app, terminationAuth());
  artifactChecksRecoveryRoutes(app, {
    inspectArtifactChecksRecovery: (id) => manager.inspectArtifactChecksRecovery(id),
    recoverArtifactChecks: (...args) => manager.recoverArtifactChecks(...args),
  });
  await app.ready();
  const url = `/pods/${podId}/artifact-checks-recovery`;
  const headers = { authorization: 'Bearer human-token' };
  const preview = await app.inject({ url, headers });
  const request: ArtifactChecksRecoveryRequest = {
    id: 'exact-request',
    expectedBindingHash: preview.json().selection?.expectedBindingHash,
    reason: 'Independently check the retained source without coding or delivery',
  };
  const operation = () => ctx.podRepo.artifactChecks!.forPod(podId)!;
  const wait = async () => {
    await vi.waitFor(
      () => expect(operation()?.events.checked ?? operation()?.events.blocked).toBeTruthy(),
      { timeout: 5000 },
    );
  };
  cleanups.push(async () => {
    await app.close();
    ctx.db.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    ctx,
    pod,
    podId,
    cm,
    app,
    url,
    headers,
    request,
    preview,
    operation,
    wait,
    original,
    restart: (podRepo: PodRepository = ctx.podRepo) => {
      manager = createPodManager({ ...ctx.deps, podRepo });
    },
    markStopped: () => {
      stopped = true;
    },
    manager: () => manager,
  };
}

describe('held empty-workspace artifact checks through production manager/API', () => {
  it('inspects without side effects and records source-bound independent checks without coding or delivery', async () => {
    const f = await fixture();
    expect(f.preview.statusCode).toBe(200);
    expect(f.preview.json().refusal).toBeNull();
    expect(f.operation()).toBeNull();
    expect(f.cm.stop).not.toHaveBeenCalled();
    expect(f.cm.spawn).not.toHaveBeenCalled();
    expect(f.cm.extractDirectoryFromContainer).not.toHaveBeenCalled();
    const before = f.pod();
    const selected = await f.app.inject({
      method: 'POST',
      url: f.url,
      headers: f.headers,
      payload: f.request,
    });
    expect(selected.statusCode).toBe(202);
    await f.wait();
    expect(f.operation().events.blocked).toBeUndefined();
    expect(f.operation().events.checked).toMatchObject({ outcome: 'pass', originalRetained: true });
    expect(f.pod()).toEqual(before);
    expect(f.ctx.podRepo.hasInfrastructureBlocker!(f.podId)).toBe(true);
    expect(f.ctx.runtime.spawn).not.toHaveBeenCalled();
    expect(f.ctx.runtime.resume).not.toHaveBeenCalled();
    expect(f.ctx.worktreeManager.create).not.toHaveBeenCalled();
    expect(f.ctx.worktreeManager.pushBranch).not.toHaveBeenCalled();
    expect(f.cm.kill).not.toHaveBeenCalled();
    expect(f.ctx.podRepo.taskRetries!.state(f.podId).executedCount).toBe(1);
    expect(() => assertSourceAvailable(f.ctx.db, f.podId)).toThrow('Checks-only');
    expect(() => assertSourceDeliveryAllowed(f.ctx.db, f.podId)).toThrow();
    expect(() => assertCheckpointResourceNotRetained(f.ctx.db, 'original-container')).toThrow();
    const captured = f.operation().events.captured as { snapshot: string };
    expect(await readFile(path.join(captured.snapshot, 'ignored-report.txt'), 'utf8')).toContain(
      'original report',
    );
    expect(await readFile(path.join(f.original, 'source.js'), 'utf8')).toContain('answer');
  });
  it('coalesces duplicate and restarted requests without recapture or checks replay', async () => {
    const f = await fixture();
    await Promise.all(
      [1, 2].map(() =>
        f.app.inject({ method: 'POST', url: f.url, headers: f.headers, payload: f.request }),
      ),
    );
    await f.wait();
    f.restart();
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: `${f.url}/reconcile`,
          headers: f.headers,
          payload: f.request,
        })
      ).statusCode,
    ).toBe(202);
    expect(f.cm.stop).toHaveBeenCalledOnce();
    expect(f.cm.spawn).toHaveBeenCalledOnce();
    expect(f.ctx.validationEngine.validate).toHaveBeenCalledOnce();
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: f.url,
          headers: f.headers,
          payload: { ...f.request, reason: 'Different request reason' },
        })
      ).statusCode,
    ).toBe(409);
  });
  it('reconciles checked identities from a reopened SQLite database without replay', async () => {
    const f = await fixture();
    await f.app.inject({ method: 'POST', url: f.url, headers: f.headers, payload: f.request });
    await f.wait();
    const file = path.join(path.dirname(f.original), 'reopened.db');
    await writeFile(file, f.ctx.db.serialize());
    const db = createDatabase(file, f.ctx.deps.logger);
    cleanups.push(async () => {
      db.close();
    });
    const pods = createPodRepository(db);
    f.restart(pods);
    const response = await f.app.inject({
      method: 'POST',
      url: `${f.url}/reconcile`,
      headers: f.headers,
      payload: f.request,
    });
    expect(response.statusCode).toBe(202);
    expect(response.json().operation.events.selected).toMatchObject({
      request: f.request,
      actor: { type: 'human', userId: 'operator-oid' },
    });
    expect(response.json().operation.events.checked).toMatchObject({ outcome: 'pass' });
    expect(f.ctx.validationEngine.validate).toHaveBeenCalledOnce();
    expect(() => assertSourceAvailable(db, f.podId)).toThrow();
  });
  it('observes a lost stop response without issuing another stop', async () => {
    const f = await fixture();
    vi.mocked(f.cm.stop).mockRejectedValue(new Error('Lost response'));
    await f.app.inject({ method: 'POST', url: f.url, headers: f.headers, payload: f.request });
    await vi.waitFor(() => expect(f.cm.stop).toHaveBeenCalledOnce());
    f.restart();
    f.markStopped();
    await f.app.inject({
      method: 'POST',
      url: `${f.url}/reconcile`,
      headers: f.headers,
      payload: f.request,
    });
    await f.wait();
    expect(f.operation().events.checked).toMatchObject({ outcome: 'pass' });
    expect(f.cm.stop).toHaveBeenCalledOnce();
  });
  it.each([
    'copy-only',
    'failed-fact',
    'infrastructure',
    'missing-review',
    'throw',
  ])('retains originals for %s without certifying success', async (mode) => {
    const f = await fixture();
    const execute = vi.mocked(f.ctx.validationEngine.validate).getMockImplementation()!;
    vi.mocked(f.ctx.validationEngine.validate).mockImplementation(async (config) => {
      if (mode === 'throw') throw new Error('Uncertain dispatch');
      const result = await execute(config);
      if (mode === 'copy-only') result.factValidation = null;
      if (mode === 'failed-fact') result.factValidation!.results[0]!.passed = false;
      if (mode === 'missing-review') result.taskReview = null;
      if (mode === 'infrastructure')
        result.infrastructureFailure = {
          phase: 'facts',
          code: 'BLOCKED',
          message: 'Runner unavailable',
          retryable: false,
        };
      return result;
    });
    await f.app.inject({ method: 'POST', url: f.url, headers: f.headers, payload: f.request });
    await f.wait();
    expect(f.operation().events.checked).not.toMatchObject({ outcome: 'pass' });
    expect(f.cm.kill).not.toHaveBeenCalled();
    expect(f.ctx.runtime.spawn).not.toHaveBeenCalled();
  });
  it('refuses unauthenticated, pod-token, stale and extra-authority requests', async () => {
    const f = await fixture();
    for (const headers of [{}, { authorization: 'Bearer pod-token' }])
      expect(
        (await f.app.inject({ method: 'POST', url: f.url, headers, payload: f.request }))
          .statusCode,
      ).toBe(401);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: f.url,
          headers: f.headers,
          payload: { ...f.request, expectedBindingHash: '0'.repeat(64) },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: f.url,
          headers: f.headers,
          payload: { ...f.request, force: true },
        })
      ).statusCode,
    ).toBe(400);
    expect(f.cm.stop).not.toHaveBeenCalled();
  });
  it('rejects missing source before independent checks and retains the original', async () => {
    const f = await fixture();
    vi.mocked(f.cm.extractDirectoryFromContainer).mockRejectedValue(new Error('Missing source'));
    await f.app.inject({ method: 'POST', url: f.url, headers: f.headers, payload: f.request });
    await f.wait();
    expect(f.operation().events.blocked).toBeTruthy();
    expect(f.ctx.validationEngine.validate).not.toHaveBeenCalled();
    expect(f.cm.kill).not.toHaveBeenCalled();
  });
  it.each([
    'unsettled',
    'unqualified-needs',
    'missing-reviewer',
    'pending-decision',
    'waiver',
    'incomplete-accounting',
    'mounted-source',
  ])('fails closed before custody/stop for %s', async (mode) => {
    const f = await fixture();
    if (mode === 'unsettled') f.ctx.podRepo.completionJournal!.begin(f.pod());
    if (mode === 'unqualified-needs')
      f.ctx.db
        .prepare(
          "UPDATE escalations SET payload=json_remove(payload,'$.prerequisiteBlocker') WHERE id='launcher-report'",
        )
        .run();
    if (mode === 'missing-reviewer') {
      const read = f.ctx.deps.launchConfiguration!.read;
      f.ctx.deps.launchConfiguration!.read = (id) => {
        const config = read(id)!;
        return { ...config, ai: { ...config.ai, reviewer: { mode: 'follow-main' } } };
      };
      f.restart();
    }
    if (mode === 'pending-decision')
      f.ctx.podRepo.update(f.podId, {
        pendingEscalation: {
          id: 'pending',
          podId: f.podId,
          type: 'ask_human',
          timestamp: new Date().toISOString(),
          payload: { question: 'Choose' },
          response: null,
        },
      });
    if (mode === 'waiver') f.ctx.podRepo.update(f.podId, { skipValidation: true });
    if (mode === 'incomplete-accounting')
      f.ctx.podRepo.update(f.podId, { tokenTelemetryAccuracy: 'partial' });
    if (mode === 'mounted-source')
      vi.mocked(f.cm.getExecutionMetadata!).mockResolvedValue({
        workspaceStorage: 'mounted',
        imageDigest: null,
        memoryLimitBytes: null,
        cpuLimit: null,
        networkMode: null,
      });
    const response = await f.app.inject({
      method: 'POST',
      url: f.url,
      headers: f.headers,
      payload: f.request,
    });
    expect(response.statusCode).toBe(409);
    expect(f.operation()).toBeNull();
    expect(f.cm.stop).not.toHaveBeenCalled();
  });
  it('refuses reconciliation that has no original saved request', async () => {
    const f = await fixture();
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: `${f.url}/reconcile`,
          headers: f.headers,
          payload: f.request,
        })
      ).statusCode,
    ).toBe(409);
    expect(f.cm.stop).not.toHaveBeenCalled();
  });
  it('rejects a competing recovery fork acquired after inspection before any artifact mutation', async () => {
    const f = await fixture();
    // Synthetic competing durable admission; no child or worker is launched.
    f.ctx.db
      .prepare('INSERT INTO recovery_forks VALUES(?,?,?,?,?,?,?,?,?)')
      .run(
        'competing-fork',
        f.podId,
        'fork-request',
        'operator-oid',
        'request-hash',
        '{}',
        '{}',
        'fixture-process',
        new Date().toISOString(),
      );
    const response = await f.app.inject({
      method: 'POST',
      url: f.url,
      headers: f.headers,
      payload: f.request,
    });
    expect(response.statusCode).toBe(409);
    expect(f.operation()).toBeNull();
    expect(f.cm.stop).not.toHaveBeenCalled();
    expect(f.cm.spawn).not.toHaveBeenCalled();
    expect(f.ctx.runtime.spawn).not.toHaveBeenCalled();
  });
  it('admits only one of two concurrent request identities for the same source', async () => {
    const f = await fixture();
    const responses = await Promise.all(
      [f.request, { ...f.request, id: 'other-request' }].map((payload) =>
        f.app.inject({ method: 'POST', url: f.url, headers: f.headers, payload }),
      ),
    );
    expect(responses.map((response) => response.statusCode).sort()).toEqual([202, 409]);
    await f.wait();
    expect(f.cm.stop).toHaveBeenCalledOnce();
    expect(f.cm.spawn).toHaveBeenCalledOnce();
    expect(f.ctx.validationEngine.validate).toHaveBeenCalledOnce();
  });
  it('does not replay an uncertain checks dispatch after reopening the controller', async () => {
    const f = await fixture();
    vi.mocked(f.ctx.validationEngine.validate).mockRejectedValue(new Error('Lost checks response'));
    await f.app.inject({ method: 'POST', url: f.url, headers: f.headers, payload: f.request });
    await f.wait();
    f.restart();
    const response = await f.app.inject({
      method: 'POST',
      url: `${f.url}/reconcile`,
      headers: f.headers,
      payload: f.request,
    });
    expect(response.statusCode).toBe(202);
    expect(response.json().operation.events.checked).toBeUndefined();
    expect(response.json().operation.events.blocked).toBeTruthy();
    expect(f.cm.stop).toHaveBeenCalledOnce();
    expect(f.cm.spawn).toHaveBeenCalledOnce();
    expect(f.ctx.validationEngine.validate).toHaveBeenCalledOnce();
    expect(f.ctx.podRepo.taskRetries!.state(f.podId).executedCount).toBe(1);
    expect(f.cm.kill).not.toHaveBeenCalled();
  });
  it('retains unknown original state without stopping, capturing or checking it', async () => {
    const f = await fixture();
    vi.mocked(f.cm.getStatus).mockResolvedValue('unknown');
    await f.app.inject({ method: 'POST', url: f.url, headers: f.headers, payload: f.request });
    await f.manager().inspectArtifactChecksRecovery(f.podId);
    await f.app.inject({
      method: 'POST',
      url: `${f.url}/reconcile`,
      headers: f.headers,
      payload: f.request,
    });
    expect(f.operation().events.checked).toBeUndefined();
    expect(f.cm.stop).not.toHaveBeenCalled();
    expect(f.cm.extractDirectoryFromContainer).not.toHaveBeenCalled();
    expect(f.cm.spawn).not.toHaveBeenCalled();
  });
  it('rejects changed captured source even when a check boundary returns pass', async () => {
    const f = await fixture();
    const execute = vi.mocked(f.ctx.validationEngine.validate).getMockImplementation()!;
    vi.mocked(f.ctx.validationEngine.validate).mockImplementation(async (config) => {
      const result = await execute(config);
      await writeFile(path.join(config.worktreePath!, 'source.js'), 'Changed captured bytes');
      return result;
    });
    await f.app.inject({ method: 'POST', url: f.url, headers: f.headers, payload: f.request });
    await f.wait();
    expect(f.operation().events.checked).toBeUndefined();
    expect(f.operation().events.blocked).toBeTruthy();
    expect(f.ctx.validationEngine.validate).toHaveBeenCalledOnce();
  });
  it('retains an uncertain capture across restart without dispatching it again', async () => {
    const f = await fixture();
    vi.mocked(f.cm.extractDirectoryFromContainer).mockRejectedValue(
      new Error('Capture response lost'),
    );
    await f.app.inject({ method: 'POST', url: f.url, headers: f.headers, payload: f.request });
    await f.wait();
    f.restart();
    await f.app.inject({
      method: 'POST',
      url: `${f.url}/reconcile`,
      headers: f.headers,
      payload: f.request,
    });
    expect(f.cm.extractDirectoryFromContainer).toHaveBeenCalledOnce();
    expect(f.ctx.validationEngine.validate).not.toHaveBeenCalled();
  });
  it('does not use an empty or binary content packet as independent review', async () => {
    const f = await fixture();
    await writeFile(path.join(f.original, 'binary'), Buffer.from([0, 1, 2]));
    await expect(artifactReviewContents(f.original)).rejects.toThrow('Binary');
  });
});
