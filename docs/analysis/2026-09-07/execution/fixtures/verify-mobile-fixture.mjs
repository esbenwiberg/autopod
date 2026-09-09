import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';

// Check the fault injector itself before using its UI results as evidence.
// These are synthetic loopback requests; no daemon, provider or cloud is used.
async function withFixture(mode, check) {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(
    process.execPath,
    [new URL('./mobile-server.mjs', import.meta.url).pathname],
    {
      env: { ...process.env, FIXTURE_MODE: mode, FIXTURE_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const exited = once(child, 'exit');
  const startup = setTimeout(() => child.kill('SIGTERM'), 10000);
  try {
    await Promise.race([
      once(child.stdout, 'data'),
      exited.then(() => {
        throw new Error('Fixture exited before readiness');
      }),
    ]);
    clearTimeout(startup);
    const post = async (path, body = {}, method = 'POST') => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: method === 'GET' ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
      return { status: response.status, body: await response.json() };
    };
    await check(post);
    console.log(JSON.stringify({ mode, result: 'pass', scope: 'synthetic fixture integrity' }));
  } finally {
    clearTimeout(startup);
    child.kill('SIGTERM');
    await exited;
  }
}

await withFixture('retry', async (post) => {
  const denied = await post('/pods/local-fixture/resume');
  assert.equal(denied.status, 409);
  assert.equal(denied.body.error, 'TASK_RETRY_RECONCILIATION_REQUIRED');
});
await withFixture('dispatch', async (post) => {
  const request = {
    profileName: 'local-fixture',
    intentionalRerun: { ofPodId: 'local-fixture', reason: 'fixture check', requestKey: 'same-key' },
  };
  assert.equal((await post('/pods', request)).status, 503);
  const retry = await post('/pods', {
    intentionalRerun: { requestKey: 'same-key', reason: 'fixture check', ofPodId: 'local-fixture' },
    profileName: 'local-fixture',
  });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.id, 'same-fixture-rerun');
  assert.equal((await post('/pods', { ...request, profileName: 'different' })).status, 409);
});
await withFixture('approval-preservation', async (post) => {
  assert.equal((await post('/pods/local-fixture/approve')).status, 502);
  assert.equal((await post('/pods/local-fixture/approve')).status, 200);
});
await withFixture('unverified-termination', async (post) => {
  assert.equal((await post('/pods/local-fixture/resume')).status, 409);
});
await withFixture('worker-deadline', async (post) => {
  assert.equal((await post('/pods/local-fixture/validate')).status, 409);
});
await withFixture('dispatch', async (request) => {
  const scan = {
    version: 1,
    baseRef: 'main',
    headRef: 'main',
    scanners: ['secrets'],
    judgment: 'none',
    windowHours: 24,
  };
  const saved = await request('/scheduled-jobs/scan-fixture', { scan }, 'PUT');
  assert.equal(saved.status, 200);
  assert.equal(saved.body.enabled, false);
  const jobs = await request('/scheduled-jobs', {}, 'GET');
  assert.deepEqual(jobs.body[0].scan, scan);
  const old = await request('/scan-reports/report-old-fixture', {}, 'GET');
  assert.equal(old.body.report.policy.headRef, 'work');
  assert.equal(
    (await request('/scheduled-jobs/scan-fixture', { scan, enabled: true }, 'PUT')).status,
    400,
  );
});

await withFixture('worker-auth', async (post) => {
  assert.equal((await post('/pods/local-fixture/validate')).status, 409);
  const grant = await post('/pods/local-fixture/retry-authorizations', {
    stage: 'worker',
    reason: 'Synthetic original binding reconciled',
    requestKey: 'worker-one',
  });
  assert.equal(grant.status, 200);
  assert.equal((await post('/pods/local-fixture/validate')).status, 200);
  const state = await post('/pods/local-fixture/retry-state?stage=worker', {}, 'GET');
  assert.equal(state.body.authorizations[0].usedByAttemptId, 'local-worker-authorized');
  assert.equal(state.body.executedCount, 2);
  assert.equal((await post('/pods/local-fixture/validate')).status, 409);
});
await withFixture('empty-scan', async (post) => {
  const detail = (await post('/scan-reports/report-fixture/review', {}, 'GET')).body;
  assert.equal(detail.report.status, 'empty_delta');
  assert.deepEqual(detail.report.collection.files, []);
  assert.equal(detail.report.collection.baseSha, detail.report.collection.headSha);
  assert.deepEqual(detail.unresolved, []);
  assert.equal(detail.report.judgment.status, 'skipped_empty');
  assert.equal(
    (await post('/scheduled-jobs/scan-fixture/report-page', {}, 'GET')).body.items[0].findingCount,
    0,
  );
});
await withFixture('historical-waiver', async (post) => {
  const pod = (await post('/pods/local-fixture', {}, 'GET')).body;
  assert.ok(pod.validationWaiver.reason);
  assert.equal(pod.lastValidationResult.test.status, 'fail');
  const history = (await post('/pods/local-fixture/validations', {}, 'GET')).body;
  assert.equal(history[0].result.test.status, 'fail');
});
