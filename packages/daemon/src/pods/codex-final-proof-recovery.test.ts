import { execFile } from 'node:child_process';
import { cp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrManager } from '../interfaces/pr-manager.js';
import { CodexRuntime } from '../runtimes/codex-runtime.js';
import {
  materializeCheckpointFixture,
  retainedCheckpointFixture,
} from '../test-utils/retained-checkpoint-helpers.js';
import { INTEGRATION_TEST_TIMEOUT_MS } from '../test-utils/test-budgets.js';
import { ReviewerRunRepository } from '../validation/reviewer-run-repository.js';
import { createRetainedCheckpointRecovery } from './retained-checkpoint-recovery.js';
import { assertSourceDeliveryAllowed } from './source-custody-guards.js';
import { createStalledWorkerRecovery } from './stalled-worker-recovery.js';

vi.setConfig({ testTimeout: INTEGRATION_TEST_TIMEOUT_MS });
const fixtures: Awaited<ReturnType<typeof retainedCheckpointFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.recovery.wait(f.input.id);
    f.ctx.db.close();
    await rm(f.root, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});
const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) =>
  (
    await exec('git', args, {
      cwd,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_OPTIONAL_LOCKS: '0',
      },
    })
  ).stdout.trim();

type Terminal = 'stdout-completion' | 'complete-then-conflict' | 'summary-only';
async function fixture(
  terminal: Terminal,
  verified = true,
  dirty = false,
  hardTokenBudget?: number,
) {
  const prUrl = 'https://github.com/org/repo/pull/684';
  const createPr = vi.fn<PrManager['createPr']>(async () => ({ url: prUrl, usedFallback: false }));
  const mergePr = vi.fn<PrManager['mergePr']>(async () => {
    throw new Error('Merge must not run in a checks or publish-only recovery');
  });
  const provider: PrManager = {
    createPr,
    mergePr,
    findPr: async () => (createPr.mock.calls.length ? { url: prUrl, disposition: 'open' } : null),
    getPrStatus: async ({ worktreePath }) => {
      const created = createPr.mock.lastCall?.[0];
      if (!created?.repoUrl || !worktreePath) throw new Error('Missing exact fixture PR source');
      return {
        open: true,
        merged: false,
        ciFailures: [],
        reviewComments: [],
        headSha: await git(worktreePath, 'rev-parse', 'HEAD'),
        sourceTarget: {
          repository: created.repoUrl,
          branch: created.branch,
          baseBranch: created.baseBranch,
        },
      };
    },
  };
  const f = await retainedCheckpointFixture(
    'prevalidation',
    true,
    true,
    true,
    'local',
    undefined,
    undefined,
    undefined,
    false,
    { prManagerFactory: () => provider, hardTokenBudget },
  );
  fixtures.push(f);
  vi.stubEnv('DATA_DIR', f.root);
  vi.stubEnv('AUTOPOD_CODEX_STATE_DIR', path.join(f.root, 'codex'));
  f.deps.readLaunch = f.ctx.deps.launchConfiguration?.read;
  f.deps.executionSettings = f.ctx.deps.launchConfiguration?.executionSettings;
  const containerId = 'f'.repeat(64);
  f.ctx.podRepo.update(f.podId, { status: 'running', containerId, validationAttempts: 0 });
  await materializeCheckpointFixture(f);
  const host = f.pod().worktreePath;
  if (!host) throw new Error('Fixture worktree missing');
  const worker = path.join(f.root, 'worker');
  await cp(host, worker, { recursive: true });
  const start = await git(host, 'rev-parse', 'HEAD');
  await writeFile(path.join(worker, 'source.ts'), 'export const finished = true;\n');
  await git(worker, 'add', 'source.ts');
  await git(
    worker,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'Worker final source',
  );
  const head = await git(worker, 'rev-parse', 'HEAD');
  const tree = await git(worker, 'rev-parse', 'HEAD^{tree}');
  if (dirty) await writeFile(path.join(worker, 'source.ts'), 'uncommitted worker bytes\n');

  const runtime = new CodexRuntime(f.ctx.deps.logger, f.cm, f.ctx.podRepo, f.ctx.eventBus);
  const session = 'synthetic-thread';
  const timestamp = new Date().toISOString();
  const usage = { input_tokens: 80, cached_input_tokens: 50, output_tokens: 7 };
  const response = (response_id: string, turn_token_usage: typeof usage) => ({
    type: 'token_usage_record',
    timestamp,
    payload: { thread_id: session, turn_id: 'fixture-turn', response_id, usage, turn_token_usage },
  });
  const nativeTerminal = {
    type: 'event_msg',
    payload: { type: 'task_complete', last_agent_message: 'Finished fixture changes' },
  };
  const kill = vi.fn(async () => {
    if (!verified) throw new Error('PRIVATE_TERMINATION_SENTINEL');
  });
  vi.mocked(f.cm.execStreaming).mockImplementationOnce(async () => {
    const rows = [
      { type: 'thread.started', thread_id: session },
      response('response-1', usage),
      ...(terminal === 'stdout-completion'
        ? [{ type: 'turn.completed', usage }]
        : terminal === 'complete-then-conflict'
          ? [
              nativeTerminal,
              response('response-2', { ...usage, input_tokens: 999 }),
              {
                ...nativeTerminal,
                payload: {
                  ...nativeTerminal.payload,
                  last_agent_message: 'PRIVATE_TRANSCRIPT_SENTINEL',
                },
              },
            ]
          : []),
    ];
    f.ctx.eventBus.emit({
      type: 'pod.agent_activity',
      podId: f.podId,
      timestamp,
      event: {
        type: 'task_summary',
        timestamp,
        actualSummary: 'Finished and committed fixture source',
        how: 'Fixture',
        deviations: [],
      },
    });
    return {
      stdout: Readable.from(rows.map((row) => `${JSON.stringify(row)}\n`)),
      stderr: Readable.from([]),
      exitCode: verified ? Promise.resolve(0) : new Promise<number>(() => {}),
      kill,
    };
  });
  const activity: string[] = [];
  const dispose = f.ctx.eventBus.subscribeToSession(f.podId, (e) => {
    if (e.type === 'pod.agent_activity') activity.push(JSON.stringify(e.event));
  });
  expect(
    await f.manager.consumeAgentEvents(
      f.podId,
      runtime.spawn({
        podId: f.podId,
        model: 'gpt-6.1-sol',
        task: 'Fixture',
        workDir: '/workspace',
        containerId,
        executionTarget: 'local',
      }),
    ),
  ).toBe('failed');
  dispose();

  // Docker transport and import are fixtures. Identity and both retained
  // source trees come from actual, different Git checkouts.
  f.cm.getResourceKey.mockResolvedValue(JSON.stringify(['docker', 'fixture-engine', containerId]));
  vi.mocked(f.cm.getStatus).mockImplementation(async (id) =>
    id === containerId ? 'stopped' : 'running',
  );
  vi.mocked(f.cm.extractDirectoryFromContainer).mockImplementation(
    async (_id, _from, destination) => {
      await cp(worker, destination, { recursive: true });
    },
  );
  f.worktrees.inspectSourcePreservation = async (cwd) => ({
    branch: await git(cwd, 'branch', '--show-current'),
    commitSha: await git(cwd, 'rev-parse', 'HEAD'),
    treeSha: await git(cwd, 'rev-parse', 'HEAD^{tree}'),
    worktreeClean: !(await git(cwd, 'status', '--porcelain')),
  });
  f.worktrees.inspectSource = f.worktrees.inspectSourcePreservation;
  vi.mocked(f.worktrees.pushBranch).mockImplementation(async (cwd, branch, options) => {
    const source = await f.worktrees.inspectSourcePreservation(cwd, branch);
    if (!options?.expectedRepository) throw new Error('Missing exact fixture publication target');
    const receipt = {
      ...source,
      repository: options.expectedRepository,
      remoteRef: `refs/heads/${branch}`,
      observedRemoteCommitSha: source.commitSha,
      observedAt: new Date().toISOString(),
    };
    options.onPrepared?.(receipt);
    return receipt;
  });
  f.worktrees.selectRetainedContinuationSource = vi.fn(async () => ({
    head,
    tree,
    baseCommitSha: start,
  }));
  const stop = createStalledWorkerRecovery({
    ...f.deps,
    getContainerManager: () => f.cm,
    root: path.join(f.root, 'archives'),
    preserveWorkspace: async (_pod, archive) => {
      await cp(archive, host, { recursive: true, force: true });
    },
  });
  f.recovery = createRetainedCheckpointRecovery(f.deps);
  f.input.checkpointHead = head;
  const inspect = () => stop.inspectStalledWorkerRecovery(f.podId);
  const seal = () =>
    stop.recoverStalledWorker(
      f.podId,
      {
        requestKey: 'fixture-retain',
        expectedBinding: inspect().binding,
        expectedGeneration: 1,
        reason: 'Seal the exact committed final source for independent checks',
      },
      f.actor,
    );
  return {
    ...f,
    containerId,
    inspect,
    seal,
    kill,
    activity,
    head,
    tree,
    start,
    host,
    prUrl,
    createPr,
    mergePr,
  };
}

describe('native Codex final proof hold and exact-source recovery', () => {
  it.each([
    ['stdout-completion', 'missing_rollout', 80],
    ['complete-then-conflict', 'aggregate_mismatch', 80],
    ['summary-only', 'missing_terminal', 80],
  ] as const)('recovers checks only after %s (%s)', async (terminal, reason, input) => {
    const f = await fixture(terminal);
    const tasks = f.ctx.podRepo.taskExecutions;
    if (!tasks) throw new Error('Fixture task ledger missing');
    expect(f.pod()).toMatchObject({
      status: 'failed',
      containerId: f.containerId,
      inputTokens: input,
      tokenTelemetryAccuracy: 'partial',
      lastValidationResult: null,
      prUrl: null,
    });
    expect(f.kill).toHaveBeenCalledOnce();
    expect(f.ctx.deps.providerAttemptRepo?.list(f.podId)).toMatchObject([
      { outcome: 'failed', inputTokens: input, outputTokens: 7 },
    ]);
    expect(f.activity.join('\n')).toContain(`"codexFinalProofRefusal":"${reason}"`);
    expect(f.activity.join('\n')).not.toContain('PRIVATE_TRANSCRIPT_SENTINEL');
    expect(f.activity.some((value) => JSON.parse(value).type === 'complete')).toBe(
      terminal === 'complete-then-conflict',
    );
    expect(tasks.latestRun?.(f.podId, 1)).toMatchObject({
      outcome: 'failed',
      endedAt: expect.any(String),
    });
    expect(tasks.codexFinalProofHold?.(f.podId, 1)).toMatchObject({ reason });
    expect(() => f.manager.assertCanRework(f.podId)).toThrow(
      'Native Codex final usage is incomplete',
    );
    await expect(f.manager.resumePod(f.podId)).rejects.toThrow(
      'Native Codex final usage is incomplete',
    );
    expect(f.recovery.inspect(f.podId)).toMatchObject({ status: 'blocked', sealedSource: null });
    expect(await git(f.host, 'rev-parse', 'HEAD')).toBe(f.start);
    const ledgerBefore = tasks.latestRun?.(f.podId, 1);
    expect(await f.seal()).toMatchObject({ state: 'settled', resourcesRetained: true });
    expect(tasks.latestRun?.(f.podId, 1)).toEqual(ledgerBefore);
    expect(f.recovery.inspect(f.podId)).toMatchObject({
      status: 'requires_selection',
      codexFinalProofRefusal: reason,
      sealedSource: { head: f.head, tree: f.tree },
    });
    expect(await git(f.host, 'rev-parse', 'HEAD')).toBe(f.head);
    expect(f.ctx.validationEngine.validate).not.toHaveBeenCalled();
    expect(f.cm.stop).not.toHaveBeenCalled();
    expect(() =>
      tasks.beginRun(f.podId, 1, 2, {
        model: 'gpt-6.1-sol',
        runtime: 'codex',
        providerAccountId: null,
      }),
    ).toThrow('Native Codex final usage is incomplete');
    const selection = f.recovery.selection(f.podId);
    const validate = vi.mocked(f.ctx.validationEngine.validate).getMockImplementation();
    if (!selection || !validate) throw new Error('Fixture checks selection missing');
    f.input.expectedResultHash = selection.expectedResultHash;
    vi.mocked(f.ctx.validationEngine.validate).mockImplementation(async (config) => ({
      ...(await validate(config)),
      taskReview: {
        status: 'pass',
        reasoning: 'Independent fixture review',
        issues: [],
        model: 'fixture',
        screenshots: [],
        diff: config.diff,
      },
    }));
    await f.recovery.continueRetained(f.podId, f.input, f.actor);
    await f.recovery.wait(f.input.id);
    expect(f.pod().lifecycleGeneration).toBe(2);
    expect(() => assertSourceDeliveryAllowed(f.ctx.db, f.podId)).toThrow('current exact-source');
    await f.manager.processPod(f.podId).catch((error) => {
      throw new Error(`${String(error)}; pod failure: ${f.pod().failureReason}`);
    });
    expect(f.pod()).toMatchObject({
      status: 'validated',
      inputTokens: input,
      tokenTelemetryAccuracy: 'partial',
      prUrl: null,
      autoApprove: false,
    });
    expect(f.ctx.validationEngine.validate).toHaveBeenCalledOnce();
    expect(f.ctx.runtime.spawn).not.toHaveBeenCalled();
    expect(f.ctx.runtime.resume).not.toHaveBeenCalled();
    expect(f.cm.kill).not.toHaveBeenCalled();
    expect(f.worktrees.pushBranch).not.toHaveBeenCalled();
    expect(f.worktrees.mergeBranch).not.toHaveBeenCalled();
    expect(f.recovery.list(f.podId)[0]?.originalEvidence).toMatchObject({
      result: null,
      prevalidationSource: { head: f.head, tree: f.tree },
    });
    expect(() => assertSourceDeliveryAllowed(f.ctx.db, f.podId)).not.toThrow();
    expect(f.createPr).not.toHaveBeenCalled();

    if (terminal === 'stdout-completion') {
      await expect(f.manager.approveSession(f.podId)).rejects.toThrow(
        'fresh authenticated human approval',
      );
      const before = tasks.snapshot(f.podId);
      const approvalLogs: string[] = [];
      const dispose = f.ctx.eventBus.subscribeToSession(f.podId, (event) => {
        if (event.type === 'pod.agent_activity' && ['status', 'error'].includes(event.event.type))
          approvalLogs.push(JSON.stringify(event.event));
      });
      try {
        await f.manager.approveSession(f.podId, {
          actor: f.actor,
          reason: 'Approve publication of the exact independently checked saved source',
          publishOnly: true,
        });
      } catch (error) {
        throw new Error(`${String(error)}. ${approvalLogs.join('\n')}`);
      } finally {
        dispose();
      }
      expect(f.pod()).toMatchObject({
        status: 'validated',
        prUrl: f.prUrl,
        lifecycleGeneration: 2,
        tokenTelemetryAccuracy: 'partial',
      });
      expect(f.ctx.podRepo.sourcePublications?.latestConfirmedForMerge?.(f.pod())).toMatchObject({
        commitSha: f.head,
      });
      expect(f.worktrees.pushBranch).toHaveBeenCalledOnce();
      expect(f.createPr).toHaveBeenCalledOnce();
      expect(f.mergePr).not.toHaveBeenCalled();
      expect(f.cm.kill).not.toHaveBeenCalled();
      expect(tasks.codexFinalProofHold?.(f.podId, 1)).toMatchObject({ reason });
      expect(tasks.snapshot(f.podId)).toMatchObject({
        recordedInputTokens: before.recordedInputTokens,
        recordedOutputTokens: before.recordedOutputTokens,
        tokenBudget: before.tokenBudget,
      });
    }
  });

  it.each([
    'complete-then-conflict',
    'summary-only',
  ] as const)('does not infer termination from %s', async (terminal) => {
    const f = await fixture(terminal, false);
    expect(f.ctx.podRepo.taskExecutions?.hasUnverifiedTermination(f.podId)).toBe(true);
    expect(f.activity.join('\n')).not.toContain('PRIVATE_TERMINATION_SENTINEL');
    expect(f.recovery.inspect(f.podId).checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'continuation_policy',
          reason: expect.stringContaining('Worker settlement is unverified'),
        }),
      ]),
    );
    vi.mocked(f.cm.getStatus).mockResolvedValue('unknown');
    await expect(f.seal()).rejects.toThrow('unknown or unavailable');
    await expect(f.recovery.continueRetained(f.podId, f.input, f.actor)).rejects.toThrow(
      'Worker settlement is unverified',
    );
    expect(f.cm.extractDirectoryFromContainer).not.toHaveBeenCalled();
    expect(f.ctx.validationEngine.validate).not.toHaveBeenCalled();
    expect(f.cm.kill).not.toHaveBeenCalled();
    expect(f.pod()).toMatchObject({
      status: 'failed',
      inputTokens: 80,
      tokenTelemetryAccuracy: 'partial',
      prUrl: null,
    });
    // Independently observing this exact Docker resource stopped is different
    // from inferring stop/settlement from a successful worker message.
    vi.mocked(f.cm.getStatus).mockResolvedValue('stopped');
    expect(await f.seal()).toMatchObject({ state: 'settled' });
    expect(f.recovery.inspect(f.podId)).toMatchObject({
      sealedSource: { head: f.head, tree: f.tree },
    });
  });

  it('keeps the finite hard cap in force on the replacement generation', async () => {
    const f = await fixture('summary-only', true, false, 1_000);
    expect(await f.seal()).toMatchObject({ state: 'settled' });
    const selection = f.recovery.selection(f.podId);
    const tasks = f.ctx.podRepo.taskExecutions;
    const config = f.deps.readLaunch?.(f.podId);
    if (!selection || !tasks || !config) throw new Error('Fixture missing frozen checks and usage');
    await f.recovery.continueRetained(
      f.podId,
      { ...f.input, expectedResultHash: selection.expectedResultHash },
      f.actor,
    );
    await f.recovery.wait(f.input.id);
    expect(f.pod().lifecycleGeneration).toBe(2);
    expect(tasks.snapshot(f.podId)).toMatchObject({
      tokenBudget: 1_000,
      recordedInputTokens: 80,
      budgetCheck: { status: 'unavailable' },
    });
    const reviewerRuns = new ReviewerRunRepository(f.ctx.db, tasks.snapshot);
    expect(() => reviewerRuns.reserve('fixture-review', f.pod(), config, config.ai.main)).toThrow(
      /Cannot enforce hard task token limit 1000.*final usage unknown/,
    );
    expect(reviewerRuns.list(f.podId)).toEqual([]);
    expect(() => assertSourceDeliveryAllowed(f.ctx.db, f.podId)).toThrow();
    await expect(f.manager.approveSession(f.podId, { actor: f.actor })).rejects.toThrow();
    expect(f.createPr).not.toHaveBeenCalled();
    expect(f.worktrees.pushBranch).not.toHaveBeenCalled();
  });

  it('retains dirty source without granting checks for a different committed tree', async () => {
    const f = await fixture('summary-only', true, true);
    expect(await f.seal()).toMatchObject({ state: 'settled', resourcesRetained: true });
    expect(f.recovery.inspect(f.podId)).toMatchObject({ status: 'blocked', sealedSource: null });
    await expect(f.recovery.continueRetained(f.podId, f.input, f.actor)).rejects.toThrow(
      'Exact clean source is not sealed',
    );
    expect(f.ctx.validationEngine.validate).not.toHaveBeenCalled();
    expect(f.worktrees.pushBranch).not.toHaveBeenCalled();
    expect(() => assertSourceDeliveryAllowed(f.ctx.db, f.podId)).toThrow(
      'Native Codex final usage is incomplete',
    );
  });
});
