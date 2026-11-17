import type { ReviewerBudgetRevisionRequest } from '@autopod/shared';
import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { errorHandler } from '../api/error-handler.js';
import { configurationRoutes } from '../api/routes/configuration.js';
import { configurationDigest } from '../configuration/configuration-digest.js';
import { resolveLaunch } from '../configuration/launch-resolver.js';
import { createLaunchSnapshotRepository } from '../configuration/launch-snapshot.js';
import { createPodRepository } from '../pods/pod-repository.js';
import {
  createTestConfiguration,
  insertConfigurationTestPod,
} from '../test-utils/configuration-helpers.js';
import { createTestDb } from '../test-utils/mock-helpers.js';
import { effectiveReviewerBudget, ReviewerBudgetRevisions } from './reviewer-budget-revisions.js';
import { ReviewerRunRepository } from './reviewer-run-repository.js';

const databases: ReturnType<typeof createTestDb>[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
const actor = { type: 'human' as const, userId: 'operator' };
async function fixture(seed = true) {
  const db = createTestDb();
  databases.push(db);
  const { services, store } = createTestConfiguration(db);
  const config = await resolveLaunch(
    {
      repositoryId: 'repo-a',
      task: 'Review saved work',
      overrides: {
        workflow: { tokenBudget: null, tokenBudgetPolicy: 'hard', reviewerTokenBudget: 100000 },
      },
    },
    services,
  );
  const snapshots = createLaunchSnapshotRepository(db, store);
  snapshots.admit({
    config,
    requestDigest: config.digest,
    createPod() {
      insertConfigurationTestPod(db, 'subject');
      return 'subject';
    },
  });
  const pods = createPodRepository(db);
  pods.taskExecutions!.register('subject');
  const runs = new ReviewerRunRepository(db, (id) => pods.taskExecutions!.snapshot(id));
  if (seed)
    for (const [i, [inputTokens, outputTokens]] of [
      [30326, 457],
      [31022, 442],
      [12212, 168],
      [31724, 608],
    ].entries()) {
      const id = `review-00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`;
      runs.reserve(id, pods.getOrThrow('subject'), config, config.ai.main);
      runs.attach(id, 'isolated');
      runs.running(id);
      runs.finish(id, true, true, { inputTokens: inputTokens!, outputTokens: outputTokens! });
      runs.cleaned(id, true);
    }
  pods.update('subject', { status: 'failed' });
  const assertSettled = vi.fn((id: string) => {
    pods.taskExecutions!.assertCanDelete(id);
    pods.validationExecutions!.assertTaskSettled(id);
  });
  const budgets = new ReviewerBudgetRevisions(db, {
    readPod: pods.getOrThrow,
    readConfig: snapshots.get,
    assertSettled,
  });
  const request = (): ReviewerBudgetRevisionRequest => {
    const view = budgets.inspect('subject');
    return {
      requestId: 'owner-approved-150k',
      expectedGeneration: view.generation,
      expectedLimit: view.effectiveLimit!,
      expectedEvidenceHash: view.evidenceHash,
      limit: 150000,
      reason: 'Owner approved a finite increase while retaining all measured usage',
      acknowledgement: 'increase-only-usage-retained',
    };
  };
  const route =
    config.ai.reviewer.mode === 'independent' ? config.ai.reviewer.route : config.ai.main;
  return { db, config, pods, runs, budgets, request, assertSettled, snapshots, services, route };
}

it('raises only the finite admission ceiling, retains all four reviews and binds the next reservation', async () => {
  const f = await fixture();
  const pod = f.pods.getOrThrow('subject');
  const before = f.runs.list('subject');
  const snapshot = f.db.prepare('SELECT * FROM retained_pod_launch_snapshots').all();
  expect(f.budgets.inspect('subject')).toMatchObject({
    recordedTokens: 106959,
    effectiveLimit: 100000,
    unknownUsageRunCount: 0,
    pendingRunCount: 0,
  });
  expect(() => f.runs.reserve('blocked', pod, f.config, f.config.ai.main)).toThrow(
    '100000 exhausted',
  );
  const receipt = f.budgets.revise('subject', f.request(), actor);
  expect(receipt).toMatchObject({
    previousLimit: 100000,
    limit: 150000,
    recordedTokens: 106959,
    actorId: 'operator',
  });
  expect(f.runs.list('subject')).toEqual(before);
  expect(f.db.prepare('SELECT * FROM retained_pod_launch_snapshots').all()).toEqual(snapshot);
  expect(f.budgets.inspect('subject')).toMatchObject({
    recordedTokens: 106959,
    effectiveLimit: 150000,
    frozenLimit: 100000,
  });
  f.runs.reserve('fresh-review', pod, f.config, f.route);
  expect(
    f.db
      .prepare(
        'SELECT reviewer_budget_revision_id AS revision FROM isolated_reviewer_runs WHERE id=?',
      )
      .get('fresh-review'),
  ).toEqual({ revision: receipt.id });
  expect(() => f.runs.reserve('another', pod, f.config, f.route)).toThrow('previous reviewer');
  expect(() =>
    f.db
      .prepare('UPDATE isolated_reviewer_runs SET reviewer_budget_revision_id=NULL WHERE id=?')
      .run('fresh-review'),
  ).toThrow('immutable');
});

it('retains the exact approved reviewer evidence independently of later native accounting updates', async () => {
  const f = await fixture();
  const inspected = f.budgets.inspect('subject');
  expect(configurationDigest(inspected.evidence)).toBe(inspected.evidenceHash);
  const receipt = f.budgets.revise('subject', f.request(), actor);
  expect(receipt.evidenceHash).toBe(inspected.evidenceHash);
  expect(receipt.evidence).toEqual(inspected.evidence);
  expect(receipt.evidence.runs).toHaveLength(4);
  const originalJson = JSON.stringify(receipt.evidence);
  f.runs.finish(receipt.evidence.runs[0]!.id, true, true, {
    inputTokens: 40326,
    outputTokens: 1000,
  });
  const after = f.budgets.inspect('subject');
  expect(after.evidenceHash).not.toBe(inspected.evidenceHash);
  expect(JSON.stringify(after.revision!.evidence)).toBe(originalJson);
  expect(configurationDigest(after.revision!.evidence)).toBe(after.revision!.evidenceHash);
  expect(after.revision!.recordedTokens).toBe(106959);
  expect(after.recordedTokens).toBeGreaterThan(106959);
});

it('never reopens headroom by reducing, clearing, deleting or moving approved measured runs', async () => {
  const f = await fixture();
  f.budgets.revise('subject', f.request(), actor);
  const id = f.runs.list('subject')[0]!.id;
  expect(() => f.runs.finish(id, true, true, { inputTokens: 1, outputTokens: 1 })).toThrow(
    'retained',
  );
  for (const statement of [
    'UPDATE isolated_reviewer_runs SET input_tokens=NULL WHERE id=?',
    "UPDATE isolated_reviewer_runs SET pod_id='other' WHERE id=?",
    'DELETE FROM isolated_reviewer_runs WHERE id=?',
  ])
    expect(() => f.db.prepare(statement).run(id)).toThrow('retained');
  expect(f.budgets.inspect('subject').recordedTokens).toBe(106959);
  f.runs.reserve('next', f.pods.getOrThrow('subject'), f.config, f.route);
  f.runs.attach('next', 'isolated');
  f.runs.running('next');
  f.runs.finish('next', true, true, { inputTokens: 43040, outputTokens: 1 });
  f.runs.cleaned('next', true);
  expect(() => f.runs.finish('next', true, true, { inputTokens: 1, outputTokens: 1 })).toThrow(
    'retained',
  );
  expect(() =>
    f.runs.reserve('over-ceiling', f.pods.getOrThrow('subject'), f.config, f.route),
  ).toThrow('150000 exhausted');
});

it.each([
  'runtime',
  'model',
  'providerAccountId',
] as const)('does not transfer the top-up to a different reservation %s', async (field) => {
  const f = await fixture();
  f.budgets.revise('subject', f.request(), actor);
  const changed = { ...f.route };
  if (field === 'runtime') changed.runtime = f.route.runtime === 'claude' ? 'codex' : 'claude';
  else changed[field] += '-different';
  expect(() =>
    f.runs.reserve('foreign-route', f.pods.getOrThrow('subject'), f.config, changed),
  ).toThrow('100000 exhausted');
  expect(f.runs.list('subject')).toHaveLength(4);
});

it.each([
  'unknown',
  'operator-reported',
] as const)('refuses increased-ceiling consumption when later usage becomes %s', async (basis) => {
  const f = await fixture();
  f.budgets.revise('subject', f.request(), actor);
  const id = 'later-uncertain';
  f.runs.reserve(id, f.pods.getOrThrow('subject'), f.config, f.route);
  f.runs.attach(id, 'isolated');
  f.runs.running(id);
  f.runs.finish(id, true, false, undefined, 'timeout');
  f.runs.cleaned(id, true);
  f.runs.reconcile(
    'subject',
    id,
    'operator',
    'Explicit native owning reconciliation; keep the actual usage basis',
    basis === 'operator-reported' ? { inputTokens: 100, outputTokens: 10 } : undefined,
  );
  expect(f.runs.retryBlocker('subject')).toBeNull();
  expect(() =>
    f.runs.reserve('must-not-start', f.pods.getOrThrow('subject'), f.config, f.route),
  ).toThrow('requires native measured counters');
  expect(f.runs.list('subject')).toHaveLength(5);
  expect(f.budgets.inspect('subject')).toMatchObject({
    effectiveLimit: 150000,
    recordedTokens: basis === 'operator-reported' ? 107069 : 106959,
  });
  if (basis === 'unknown') {
    expect(f.runs.get('subject', id)?.inputTokens).toBeNull();
    // Genuine final SDK telemetry, not top-up or reconciliation backfill.
    f.runs.finish(id, true, true, { inputTokens: 100, outputTokens: 10 });
    f.runs.reserve('after-native-measurement', f.pods.getOrThrow('subject'), f.config, f.route);
    expect(f.runs.list('subject')).toHaveLength(6);
  }
});

it('returns the original receipt on exact replay but refuses conflicting identity/content', async () => {
  const f = await fixture();
  const q = f.request();
  const first = f.budgets.revise('subject', q, actor);
  expect(f.budgets.revise('subject', q, actor)).toEqual(first);
  for (const changed of [
    { ...q, limit: 160000 },
    { ...q, reason: 'A different operator explanation' },
  ])
    expect(() => f.budgets.revise('subject', changed, actor)).toThrow('reused');
  expect(() => f.budgets.revise('subject', q, { type: 'human', userId: 'other' })).toThrow(
    'reused',
  );
  expect(f.db.prepare('SELECT count(*) AS n FROM pod_reviewer_budget_revisions').get()).toEqual({
    n: 1,
  });
  expect(() => f.db.prepare('DELETE FROM pod_reviewer_budget_revisions').run()).toThrow('retained');
  expect(() =>
    f.db.prepare('UPDATE pod_reviewer_budget_revisions SET new_limit=200000').run(),
  ).toThrow('immutable');
});

it.each([
  'generation',
  'hash',
  'limit',
] as const)('rejects stale %s before mutation', async (kind) => {
  const f = await fixture();
  const q = f.request();
  if (kind === 'generation') q.expectedGeneration++;
  if (kind === 'hash') q.expectedEvidenceHash = '0'.repeat(64);
  if (kind === 'limit') q.expectedLimit++;
  expect(() => f.budgets.revise('subject', q, actor)).toThrow('Refresh exact');
  expect(f.budgets.inspect('subject').effectiveLimit).toBe(100000);
});

it.each([
  0,
  100000,
  105000,
  null,
  Infinity,
  1.5,
])('rejects invalid/decreasing/unfunded ceiling %s', async (limit) => {
  const f = await fixture();
  expect(() =>
    f.budgets.revise('subject', { ...f.request(), limit } as ReviewerBudgetRevisionRequest, actor),
  ).toThrow();
  expect(f.db.prepare('SELECT count(*) AS n FROM pod_reviewer_budget_revisions').get()).toEqual({
    n: 0,
  });
});

it('does not replace an accepted unknown amount with zero or remove its history', async () => {
  const f = await fixture(false);
  const pod = f.pods.getOrThrow('subject');
  f.runs.reserve('uncertain', pod, f.config, f.config.ai.main);
  f.runs.attach('uncertain', 'isolated');
  f.runs.running('uncertain');
  f.runs.finish('uncertain', true, false, undefined, 'timeout');
  f.runs.cleaned('uncertain', true);
  f.runs.reconcile('subject', 'uncertain', 'operator', 'Owner accepted unknown usage');
  const before = f.runs.list('subject');
  expect(f.budgets.inspect('subject').unknownUsageRunCount).toBe(1);
  expect(() => f.budgets.revise('subject', f.request(), actor)).toThrow(
    'measured usage is unsettled',
  );
  expect(f.runs.list('subject')).toEqual(before);
  expect(before[0]?.inputTokens).toBeNull();
});

it('retains historical unknown acceptance when genuine late native final measurement arrives', async () => {
  const f = await fixture(false);
  const id = 'late-final-usage';
  f.runs.reserve(id, f.pods.getOrThrow('subject'), f.config, f.route);
  f.runs.attach(id, 'isolated');
  f.runs.running(id);
  f.runs.finish(id, true, false, undefined, 'timeout');
  f.runs.cleaned(id, true);
  f.runs.reconcile(
    'subject',
    id,
    'operator',
    'Accepted unknown final amount without substituting zero',
  );
  expect(f.budgets.inspect('subject').unknownUsageRunCount).toBe(1);
  expect(() => f.budgets.revise('subject', f.request(), actor)).toThrow(
    'measured usage is unsettled',
  );
  // Native provider completion, not budget-control backfill, supplies the final counters.
  f.runs.finish(id, true, true, { inputTokens: 30, outputTokens: 20 });
  expect(f.budgets.inspect('subject')).toMatchObject({
    recordedTokens: 50,
    unknownUsageRunCount: 0,
  });
  const receipt = f.budgets.revise('subject', f.request(), actor);
  expect(receipt.evidence.runs[0]).toMatchObject({
    state: 'completed',
    inputTokens: 30,
    outputTokens: 20,
    usageBasis: 'unknown-accepted',
  });
});

it('preserves known operator-reported accounting without promoting it to native measurement for a top-up', async () => {
  const f = await fixture(false);
  const id = 'operator-known';
  f.runs.reserve(id, f.pods.getOrThrow('subject'), f.config, f.route);
  f.runs.attach(id, 'isolated');
  f.runs.running(id);
  f.runs.finish(id, true, false, undefined, 'timeout');
  f.runs.cleaned(id, true);
  f.runs.reconcile('subject', id, 'operator', 'Known counters reported by the owner', {
    inputTokens: 100,
    outputTokens: 10,
  });
  expect(f.budgets.inspect('subject')).toMatchObject({
    recordedTokens: 110,
    unknownUsageRunCount: 0,
    operatorReportedUsageRunCount: 1,
  });
  expect(() => f.budgets.revise('subject', f.request(), actor)).toThrow('native measured counters');
  expect(f.runs.list('subject')[0]).toMatchObject({
    inputTokens: 100,
    outputTokens: 10,
    usageBasis: 'operator-reported',
  });
  expect(f.budgets.inspect('subject').effectiveLimit).toBe(100000);
});

it('keeps active worker and reviewer holds, and validates evidence again at application', async () => {
  const f = await fixture();
  const q = f.request();
  f.db
    .prepare(
      'INSERT INTO task_agent_runs(id,pod_id,generation,cycle,binding,started_at) VALUES(?,?,?,?,?,?)',
    )
    .run('active-worker', 'subject', 1, 1, '{}', new Date().toISOString());
  expect(() => f.budgets.revise('subject', q, actor)).toThrow('unsettled worker');
  expect(f.db.prepare('SELECT count(*) AS n FROM pod_reviewer_budget_revisions').get()).toEqual({
    n: 0,
  });
  const g = await fixture(false);
  const request = g.request();
  g.runs.reserve('active-review', g.pods.getOrThrow('subject'), g.config, g.config.ai.main);
  expect(() => g.budgets.revise('subject', request, actor)).toThrow('unsettled');
  expect(g.db.prepare('SELECT count(*) AS n FROM pod_reviewer_budget_revisions').get()).toEqual({
    n: 0,
  });
});

it('retains whole-task hard budgets and does not transfer approval to another reviewer policy', async () => {
  const f = await fixture();
  f.budgets.revise('subject', f.request(), actor);
  const pod = f.pods.getOrThrow('subject');
  const summary = f.pods.taskExecutions!.snapshot('subject');
  const hard = new ReviewerRunRepository(f.db, () => ({ ...summary, tokenBudget: 1 }));
  expect(() => hard.reserve('hard-blocked', pod, f.config, f.config.ai.main)).toThrow(
    'Hard task token limit',
  );
  const changed = structuredClone(f.config);
  changed.ai.reviewer = {
    mode: 'independent',
    route: { ...f.config.ai.main, model: 'different-model' },
  };
  expect(effectiveReviewerBudget(f.db, pod, changed).limit).toBe(100000);
  expect(f.db.prepare('SELECT count(*) AS n FROM isolated_reviewer_runs').get()).toEqual({ n: 4 });
});

it('serves strict authenticated inspection/apply without dispatching review or accepting authority fields', async () => {
  const f = await fixture();
  const app = Fastify();
  let oid = 'operator';
  app.setErrorHandler(errorHandler);
  app.addHook('onRequest', async (request) => {
    request.user = { oid } as typeof request.user;
  });
  configurationRoutes(app, {
    db: f.db,
    resolution: f.services,
    capabilities: () => ({}),
    reviewerBudget: f.budgets,
  });
  const url = '/pods/subject/reviewer-budget';
  try {
    const view = await app.inject({ method: 'GET', url });
    expect(view.statusCode).toBe(200);
    expect(view.json().recordedTokens).toBe(106959);
    const q = f.request();
    for (const payload of [
      { ...q, acknowledgement: undefined },
      { ...q, actor: { type: 'human', userId: 'spoof' } },
      { ...q, tokenBudget: null },
      { ...q, limit: null },
    ])
      expect((await app.inject({ method: 'POST', url, payload })).statusCode).toBe(400);
    expect(f.db.prepare('SELECT count(*) AS n FROM pod_reviewer_budget_revisions').get()).toEqual({
      n: 0,
    });
    const result = await app.inject({ method: 'POST', url, payload: q });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({
      limit: 150000,
      recordedTokens: 106959,
      actorId: 'operator',
    });
    expect(f.runs.list('subject')).toHaveLength(4);
    oid = '';
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url, payload: q })).statusCode).toBe(401);
    expect(f.db.prepare('SELECT count(*) AS n FROM pod_reviewer_budget_revisions').get()).toEqual({
      n: 1,
    });
  } finally {
    await app.close();
  }
});

it('does not transfer an allowance or an evidence hash to a different pod', async () => {
  const f = await fixture();
  const q = f.request();
  f.budgets.revise('subject', q, actor);
  f.snapshots.admit({
    config: f.config,
    requestDigest: f.config.digest,
    createPod() {
      insertConfigurationTestPod(f.db, 'other');
      return 'other';
    },
  });
  f.pods.taskExecutions!.register('other');
  f.pods.update('other', { status: 'failed' });
  expect(f.budgets.inspect('other')).toMatchObject({ effectiveLimit: 100000, revision: null });
  expect(() => f.budgets.revise('other', q, actor)).toThrow('Refresh exact');
  expect(f.budgets.inspect('subject').effectiveLimit).toBe(150000);
});

it('rejects nonhuman approvals and archived tasks without altering reviewer usage', async () => {
  const f = await fixture();
  expect(() => f.budgets.revise('subject', f.request(), { type: 'human', userId: '' })).toThrow(
    'human',
  );
  f.pods.fleetArchives!.archive(
    'subject',
    'operator',
    'Preserve this failed task without new execution',
  );
  expect(() => f.budgets.revise('subject', f.request(), actor)).toThrow('settled ordinary');
  expect(f.runs.list('subject')).toHaveLength(4);
});
