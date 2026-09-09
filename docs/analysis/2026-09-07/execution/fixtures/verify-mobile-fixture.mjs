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
    const post = async (path, body = {}) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
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
