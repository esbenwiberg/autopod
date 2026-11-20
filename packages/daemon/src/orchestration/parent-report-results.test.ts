import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { ArtifactExports } from '../managed/artifact-exports.js';
import { MemoryArtifactStore } from '../managed/artifact-store.js';
import { signalLocalRun, subscribeLocalRun } from '../managed/local-run-signals.js';
import { resign } from '../test-utils/managed-fixture.js';
import { setupOrchestrationRun } from '../test-utils/orchestration-run-fixture.js';
import { ParentReportResults } from './parent-report-results.js';

async function fixture(run = 'parent-report-fixture') {
  const source = await setupOrchestrationRun(2, 1, run);
  const startKey = 'parent-child';
  const request = structuredClone(source.request);
  request.startKey = startKey;
  resign(request);
  const attempt = 'parent-attempt';
  source.f.db
    .prepare(
      `INSERT INTO parent_managed_runs(run_id,pod_id,launch_digest,policy_digest,policy_json,current_attempt)
       VALUES(?,?,?,?,?,?)`,
    )
    .run(run, 'parent-pod', 'launch', 'policy', '{}', attempt);
  source.f.db
    .prepare(
      'INSERT INTO parent_managed_sessions(attempt,run_id,generation,container_id) VALUES(?,?,?,?)',
    )
    .run(attempt, run, 1, 'parent-container');
  await source.host().ledger.kickoff(source.cp, { inspect: request });
  await source.host().ledger.spawnWave(source.cp, [request], () => {
    source.f.db
      .prepare(
        `INSERT INTO parent_managed_requests(run_id,start_key,request_key,parent_attempt,input_digest)
         VALUES(?,?,?,?,?)`,
      )
      .run(run, startKey, 'requested-child', attempt, 'input');
  });
  await source.host().ledger.recover(run);
  const child = source.f.db
    .prepare('SELECT pod_id FROM orchestration_continuations WHERE run_id=? AND start_key=?')
    .pluck()
    .get(run, startKey) as string;
  const reports = new ParentReportResults(source.f.db);
  const authenticate = () => run;
  const finish = (state = 'complete', exitCode: number | null = 0) => {
    source.f.db
      .prepare('UPDATE managed_pods SET observed_exit=1,state=?,exit_code=? WHERE pod_id=?')
      .run(state, exitCode, child);
  };
  return { ...source, run, child, reports, authenticate, finish };
}

it('returns durable parent request results with verified report custody and restart-safe cursors', async () => {
  const f = await fixture();
  const root = path.join(f.root, 'report-staging');
  await mkdir(root);
  await writeFile(path.join(root, 'report.md'), 'Fixture finding.\n');
  const binding = f.f.db
    .prepare(
      'SELECT pod_id AS podId, dispatcher_attempt_id AS dispatcherAttemptId, execution_spec_digest AS executionSpecDigest FROM managed_pods WHERE pod_id=?',
    )
    .get(f.child) as { podId: string; dispatcherAttemptId: string; executionSpecDigest: string };
  // Runtime exit alone and recoverable export holds do not consume a result cursor.
  for (const holding of ['validating', 'review_required']) {
    f.finish(holding);
    expect(await f.reports.results({}, f.authenticate)).toEqual({ nextCursor: 0, results: [] });
  }
  await new ArtifactExports(f.f.db, new MemoryArtifactStore()).export(
    binding,
    root,
    {
      ...f.request.outputs.artifacts,
      mode: 'required',
      include: ['report.md'],
      requiredPaths: ['report.md'],
    },
    true,
  );
  f.finish();
  const first = await f.reports.results({}, f.authenticate);
  expect(first).toEqual({
    nextCursor: expect.any(Number),
    results: [
      {
        cursor: expect.any(Number),
        requestKey: 'requested-child',
        childId: f.child,
        exitCode: 0,
        report: { status: 'excerpt', text: 'Fixture finding.\n', truncated: false },
      },
    ],
  });
  expect(await f.reports.results({ after: first.nextCursor }, f.authenticate)).toEqual({
    nextCursor: first.nextCursor,
    results: [],
  });
  f.f.restart();
  const restarted = new ParentReportResults(f.f.db);
  expect(await restarted.results({ after: 0 }, f.authenticate)).toEqual(first);
  f.f.db
    .prepare('UPDATE artifact_exports SET bundle_bytes=? WHERE pod_id=?')
    .run(Buffer.from('damaged fixture'), f.child);
  await expect(restarted.results({ after: 0 }, f.authenticate)).rejects.toThrow(
    'artifact-integrity-failure',
  );
});

it('never presents a terminal failure as a successful report', async () => {
  const f = await fixture('parent-report-failure');
  f.finish('failed', 23);
  expect((await f.reports.results({}, f.authenticate)).results[0]).toEqual({
    cursor: expect.any(Number),
    requestKey: 'requested-child',
    childId: f.child,
    exitCode: 23,
    report: { status: 'failed' },
  });
});

it('subscribes before reading, wakes from a local signal, and bounds timeout without polling', async () => {
  const f = await fixture('parent-report-wait');
  let wakes = 0;
  const detachScheduler = subscribeLocalRun(f.f.db, `native.${f.run}`, () => {
    wakes++;
  });
  const waiting = f.reports.wait({ timeoutMs: 500 }, f.authenticate);
  setTimeout(() => {
    f.finish();
    signalLocalRun(f.f.db, `native.${f.run}`);
  }, 10);
  const result = await waiting;
  detachScheduler();
  expect(wakes).toBe(1);
  expect(result.timedOut).toBe(false);
  expect(result.results[0]).toMatchObject({ childId: f.child, report: { status: 'no-report' } });

  const cursor = result.nextCursor;
  const started = Date.now();
  const timedOut = await f.reports.wait({ after: cursor, timeoutMs: 20 }, f.authenticate);
  expect(timedOut).toEqual({ nextCursor: cursor, results: [], timedOut: true });
  expect(Date.now() - started).toBeGreaterThanOrEqual(10);
});

it('rejects unowned cursors and reauthenticates after asynchronous report reads', async () => {
  const f = await fixture('parent-report-auth');
  f.finish();
  const owned = await f.reports.results({}, f.authenticate);
  await expect(f.reports.results({ after: owned.nextCursor + 1 }, f.authenticate)).rejects.toThrow(
    'parent-result-cursor-refused',
  );
  let checks = 0;
  await expect(
    f.reports.results({}, () => {
      checks++;
      if (checks > 1) throw new Error('parent-session-stale');
      return f.run;
    }),
  ).rejects.toThrow('parent-session-stale');
});

it('validates bounded strict inputs', async () => {
  const f = await fixture('parent-report-inputs');
  await expect(f.reports.results({ after: -1 }, f.authenticate)).rejects.toThrow();
  await expect(f.reports.results({ after: 0, extra: true }, f.authenticate)).rejects.toThrow();
  await expect(f.reports.wait({ timeoutMs: 15_001 }, f.authenticate)).rejects.toThrow();
});
