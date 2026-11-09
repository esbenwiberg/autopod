import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestContext } from '../test-utils/mock-helpers.js';
import { createClaudeSessionTelemetry, parseClaudeSession } from './claude-session-telemetry.js';
import { createPodManager } from './pod-manager.js';
import { createProviderAttemptRepository } from './provider-attempt-repository.js';
import { readProviderUsage } from './provider-usage-projection.js';

const session = '92cf0f30-809f-4037-8948-2bbccdccd854';
const startedAt = '2026-11-06T18:00:00.000Z';
const endedAt = '2026-11-07T11:00:00.000Z';
const model = 'claude-opus-5-5';
const window = { startedAt, endedAt };
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const close of cleanup.splice(0)) await close();
});
function rows() {
  const assistant = (id: string, request: string) => ({
    type: 'assistant',
    sessionId: session,
    timestamp: '2026-11-06T19:00:00.000Z',
    requestId: request,
    message: {
      id,
      model,
      usage: {
        input_tokens: 2,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 30,
        output_tokens: 10,
        output_tokens_details: { thinking_tokens: 4 },
      },
    },
  });
  return [
    assistant('m1', 'r1'),
    assistant('m1', 'r1'),
    assistant('m2', 'r2'),
    {
      type: 'cost-state',
      sessionId: session,
      hasUnknownModelCost: false,
      totalCostUSD: 0.25,
      modelUsage: {
        [model]: {
          inputTokens: 4,
          cacheReadInputTokens: 200,
          cacheCreationInputTokens: 60,
          outputTokens: 20,
          thinkingTokens: 8,
          costUSD: 0.25,
        },
      },
    },
  ];
}
const serialize = (r: unknown[]) => r.map((row) => JSON.stringify(row)).join('\n') + '\n';

describe('exact native Claude session accounting', () => {
  it('deduplicates response blocks and includes both caches, without double counting thinking', () => {
    expect(parseClaudeSession(serialize(rows()), session, model, window)).toMatchObject({
      inputTokens: 264,
      outputTokens: 20,
      apiResponses: 2,
      costUsd: 0.25,
      costBasis: 'native_session_estimate',
      billingVerified: false,
    });
  });
  it('allows bounded large non-usage tool context without relaxing row/total accounting', () => {
    const r = rows();
    r.unshift({ type: 'user', sessionId: session, text: 'x'.repeat(1_058_402) } as never);
    expect(parseClaudeSession(serialize(r), session, model, window).inputTokens).toBe(264);
    r[0] = { type: 'user', sessionId: session, text: 'x'.repeat(2 * 1024 * 1024) } as never;
    expect(() => parseClaudeSession(serialize(r), session, model, window)).toThrow('oversized');
  });
  it.each([
    'conflicting-duplicate',
    'wrong-session',
    'wrong-model',
    'unsafe-number',
    'missing-final',
    'totals-disagree',
    'outside-window',
    'request-collision',
    'unknown-cost',
    'malformed',
    'usage-after-final',
  ])('rejects ambiguous native evidence: %s', (fault) => {
    const r = rows();
    if (fault === 'conflicting-duplicate') r[1]!.message!.usage.output_tokens++;
    if (fault === 'wrong-session') r[0]!.sessionId = 'other';
    if (fault === 'wrong-model') r[0]!.message!.model = 'other';
    if (fault === 'unsafe-number') r[0]!.message!.usage.input_tokens = Number.MAX_SAFE_INTEGER + 1;
    if (fault === 'missing-final') r.pop();
    if (fault === 'totals-disagree') r[3]!.totalCostUSD = 2;
    if (fault === 'outside-window') r[0]!.timestamp = '2025-01-01T00:00:00Z';
    if (fault === 'request-collision') r[2]!.requestId = 'r1';
    if (fault === 'unknown-cost') r[3]!.hasUnknownModelCost = true;
    if (fault === 'usage-after-final') r.push(r[0]!);
    const text = fault === 'malformed' ? serialize(r) + '{broken' : serialize(r);
    expect(() => parseClaudeSession(text, session, model, window)).toThrow();
  });
});

async function fixture() {
  const ctx = createTestContext();
  cleanup.push(() => ctx.db.close());
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'claude-telemetry-')));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  vi.stubEnv('AUTOPOD_CLAUDE_STATE_DIR', root);
  const manager = createPodManager(ctx.deps);
  const pod = manager.createSession(
    { profileName: 'test-profile', task: 'Retained task' },
    'operator',
  );
  const id = pod.id,
    containerId = 'a'.repeat(64);
  ctx.podRepo.update(id, {
    status: 'running',
    runtime: 'claude',
    model,
    containerId,
    claudeSessionId: session,
    launchConfigDigest: 'f'.repeat(64),
    tokenBudget: 100,
  });
  ctx.db.prepare('UPDATE pods SET launch_config_digest=? WHERE id=?').run('f'.repeat(64), id);
  const binding = {
    runtime: 'claude' as const,
    model,
    providerAccountId: null,
    resource: { containerId, executionTarget: 'local' as const },
  };
  const runId = ctx.podRepo.taskExecutions!.beginRun(id, 1, 1, binding);
  ctx.db.prepare('UPDATE task_agent_runs SET ended_at=? WHERE id=?').run(endedAt, runId);
  ctx.podRepo.update(id, { status: 'failed' });
  const attempts = createProviderAttemptRepository(ctx.db);
  attempts.open({
    podId: id,
    runtime: 'claude',
    model,
    provider: 'max',
    providerAccountId: null,
    profileReference: `pod:${id}@profile-snapshot#abcdef1`,
    profileSnapshot: {},
    startedAt,
  });
  attempts.updateActive(id, {
    nativeSessionId: session,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  });
  const rawBinding = (
    ctx.db.prepare('SELECT binding FROM task_agent_runs WHERE id=?').get(runId) as {
      binding: string;
    }
  ).binding;
  const receipt = { state: 'settled', resourcesRetained: true };
  const proof = {
    run: { id: runId, binding: rawBinding, generation: 1 },
    resourceKey: 'exact-docker-resource',
  };
  ctx.db
    .prepare(`INSERT INTO stalled_worker_recoveries
    (request_key,pod_id,task_id,container_id,request_hash,binding,receipt,archive_path,original_evidence)
    VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(
      'retained',
      id,
      ctx.podRepo.taskExecutions!.snapshot(id).taskId,
      containerId,
      'h',
      JSON.stringify(proof),
      JSON.stringify(receipt),
      '/retained/source',
      '{}',
    );
  const dir = path.join(root, id, '-workspace');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, session + '.jsonl');
  await writeFile(file, serialize(rows()));
  vi.mocked(ctx.containerManager.getStatus).mockResolvedValue('stopped');
  ctx.containerManager.getResourceKey = vi.fn(async () => 'exact-docker-resource');
  expect(ctx.podRepo.getOrThrow(id)).toMatchObject({
    status: 'failed',
    runtime: 'claude',
    model,
    claudeSessionId: session,
    launchConfigDigest: 'f'.repeat(64),
    executionTarget: 'local',
  });
  const service = () =>
    createClaudeSessionTelemetry({
      db: ctx.db,
      podRepo: ctx.podRepo,
      providerAttemptRepo: attempts,
      getContainerManager: () => ctx.containerManager,
    });
  return { ...ctx, id, attempts, file, service, runId };
}
describe('scoped settled Claude reconciliation', () => {
  it('previews read-only, appends evidence once, aborts only the positively stopped segment and preserves cumulative spend', async () => {
    const f = await fixture();
    const original = f.attempts.listRaw(f.id)[0]!;
    const preview = await f.service().inspect(f.id);
    if (preview.mode !== 'preview') throw Error('Preview required');
    expect(f.attempts.listRaw(f.id)[0]).toEqual(original);
    expect(
      f.db.prepare('SELECT COUNT(*) AS n FROM claude_session_telemetry_receipts').get(),
    ).toEqual({ n: 0 });
    const request = {
      expectedBinding: preview.expectedBinding,
      reason: 'Reconcile genuine session before a separately authorized budget change',
    };
    const receipt = await f.service().apply(f.id, request, 'operator');
    expect(receipt).not.toHaveProperty('attempt');
    const stored = f.db
      .prepare('SELECT receipt FROM claude_session_telemetry_receipts WHERE pod_id=?')
      .get(f.id) as { receipt: string };
    expect(JSON.parse(stored.receipt).attempt).toEqual(original);
    expect(f.attempts.getActive(f.id)).toBeNull();
    expect(f.attempts.listRaw(f.id)[0]).toMatchObject({
      outcome: 'aborted',
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(f.attempts.list(f.id)[0]).toMatchObject({
      inputTokens: 264,
      outputTokens: 20,
      costUsd: 0.25,
    });
    expect(f.attempts.totals(f.id)).toEqual({ inputTokens: 264, outputTokens: 20, costUsd: 0.25 });
    expect(readProviderUsage(f.db, f.id, true)).toMatchObject({
      inputTokens: 264,
      knownEstimatedCostUsd: 0.25,
    });
    expect(f.podRepo.taskExecutions!.snapshot(f.id)).toMatchObject({
      recordedTotalTokens: 284,
      budgetCheck: { status: 'exhausted' },
      tokenBudget: 100,
      agentRunCount: 1,
    });
    expect(f.db.prepare('SELECT outcome FROM task_agent_runs WHERE id=?').get(f.runId)).toEqual({
      outcome: null,
    });
    expect(await f.service().apply(f.id, request, 'operator')).toEqual(receipt);
    await expect(f.service().apply(f.id, request, 'other')).rejects.toThrow('Conflicting');
    expect(() => f.db.prepare('DELETE FROM claude_session_telemetry_receipts').run()).toThrow(
      'retained',
    );
    f.attempts.open({
      podId: f.id,
      runtime: 'claude',
      model,
      provider: 'max',
      providerAccountId: null,
      profileReference: `pod:${f.id}@profile-snapshot#abcdef1`,
      profileSnapshot: {},
    });
    f.attempts.updateActive(f.id, { inputTokens: 7, outputTokens: 3, costUsd: 0.1 });
    expect(f.attempts.totals(f.id)).toMatchObject({ inputTokens: 271, outputTokens: 23 });
    expect(f.podRepo.taskExecutions!.snapshot(f.id).recordedTotalTokens).toBe(294);
    expect(f.containerManager.stop).not.toHaveBeenCalled();
    expect(f.containerManager.kill).not.toHaveBeenCalled();
  });
  it.each([
    'running-resource',
    'late-resource-start',
    'wrong-resource',
    'stale-preview',
    'active-worker',
    'second-segment',
    'symlink-session',
  ])('refuses %s without changing accounting or starting/stopping execution', async (fault) => {
    const f = await fixture();
    const preview = await f.service().inspect(f.id);
    if (preview.mode !== 'preview') throw Error('Preview required');
    const request = {
      expectedBinding: preview.expectedBinding,
      reason: 'Reconcile only unchanged positive session evidence',
    };
    if (fault === 'running-resource')
      vi.mocked(f.containerManager.getStatus).mockResolvedValue('running');
    if (fault === 'late-resource-start')
      vi.mocked(f.containerManager.getStatus)
        .mockResolvedValueOnce('stopped')
        .mockResolvedValue('running');
    if (fault === 'wrong-resource')
      f.containerManager.getResourceKey = vi.fn(async () => 'different');
    if (fault === 'stale-preview') await writeFile(f.file, serialize(rows()) + '\n');
    if (fault === 'active-worker')
      vi.spyOn(f.podRepo.taskExecutions!, 'assertCanDelete').mockImplementation(() => {
        throw new Error('Worker still active');
      });
    if (fault === 'second-segment')
      f.attempts.close(f.id, {
        nativeSessionId: session,
        outcome: 'aborted',
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      });
    if (fault === 'symlink-session') {
      await rm(f.file);
      await symlink('/etc/passwd', f.file);
    }
    await expect(f.service().apply(f.id, request, 'operator')).rejects.toThrow();
    expect(
      f.db.prepare('SELECT COUNT(*) AS n FROM claude_session_telemetry_receipts').get(),
    ).toEqual({ n: 0 });
    expect(f.podRepo.getOrThrow(f.id).tokenBudget).toBe(100);
    expect(f.podRepo.getOrThrow(f.id).tokenTelemetryAccuracy).toBe('partial');
    expect(f.containerManager.stop).not.toHaveBeenCalled();
  });
});
