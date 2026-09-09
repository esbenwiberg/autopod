import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
let child;
let currentMode;
const modes = new Set([
  'retry',
  'dispatch',
  'duration-evidence',
  'guidance-receipt',
  'approval-preservation',
  'approval-source-missing',
  'reconciliation-ownership',
  'worker-auth',
  'uncollected-guidance',
  'delivery-disposition',
  'archived-task',
  'unverified-termination',
  'foundry-review-unavailable',
  'legacy-delivery-recovery',
  'unverified-exit',
  'host-reviewer-provenance',
]);
const podDefaults = {
  title: 'Local acceptance fixture',
  executionTarget: 'sandbox',
  branch: 'fixture/acceptance',
  hasWebUi: false,
  userId: 'local-fixture',
  filesChanged: 0,
  linesAdded: 0,
  linesRemoved: 0,
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  commitCount: 0,
  outputMode: 'pr',
};
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:31994');
  url.pathname = url.pathname.replace(/^\/session\/[A-Za-z0-9-]+(?=\/)/, '');
  req.url = url.pathname + url.search;
  const finish = (value, status = 200) => {
    console.log(JSON.stringify({ path: url.pathname, status }));
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(value));
  };
  try {
    console.log(
      JSON.stringify({
        method: req.method,
        path: url.pathname,
        stage: url.searchParams.get('stage'),
      }),
    );
    if (req.method === 'POST' && url.pathname === '/__fixture') {
      const mode = url.searchParams.get('mode');
      currentMode = mode;
      if (!modes.has(mode)) return finish({ error: 'invalid fixture mode' }, 400);
      if (child) {
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        await exited;
      }
      child = spawn(
        process.execPath,
        ['docs/analysis/2026-09-07/execution/fixtures/mobile-server.mjs'],
        {
          cwd: '__SOURCE_ROOT__',
          env: { ...process.env, FIXTURE_PORT: '31993', FIXTURE_MODE: mode },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      child.stdout.on('data', (b) => process.stdout.write(b));
      child.stderr.on('data', (b) => process.stderr.write(b));
      await once(child.stdout, 'data');
      return finish({ mode, ready: true });
    }
    if (
      ['/profiles', '/memory', '/memory/candidates', '/scheduled-job-templates'].includes(
        url.pathname,
      )
    )
      return finish([]);
    if (req.method === 'POST' && url.pathname === '/pods/local-fixture/message')
      return finish({ error: 'Reply was not stored' }, 500);
    if (url.pathname === '/pods/local-fixture/cost') {
      const task = await (
        await fetch('http://127.0.0.1:31993/pods/local-fixture/task-execution')
      ).json();
      return finish({
        podId: 'local-fixture',
        model: 'fixture-model',
        totalCostUsd: 1.25,
        inputTokens: 90,
        outputTokens: 10,
        segments: [],
        taskExecution: task,
        costEvidence: task.costEvidence,
      });
    }
    if (url.pathname === '/version') return finish({ version: 'local-acceptance' });
    if (url.pathname === '/pods/stats') return finish({ counts: { awaiting_input: 1 } });
    const body =
      req.method === 'GET' ? undefined : await Array.fromAsync(req).then((a) => Buffer.concat(a));
    const response = await fetch(`http://127.0.0.1:31993${req.url}`, {
      method: req.method,
      body,
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    let data = await response.json();
    if (url.pathname === '/pods' && req.method === 'GET') {
      data = data.map((p) => ({ ...podDefaults, ...p, title: 'Local acceptance fixture' }));
      if (url.searchParams.get('page') === 'true') data = { pods: data, nextCursor: null };
    } else if (url.pathname === '/pods/local-fixture' && req.method === 'GET')
      data = { ...podDefaults, ...data };
    if (url.pathname === '/pods' && req.method === 'POST' && response.ok)
      data = { ...podDefaults, ...data };
    if (url.pathname === '/scheduled-jobs')
      data = data.map((job) => ({
        templateId: 'fixture-template',
        templateName: 'Fixture scan',
        task: 'Collect exact delta',
        nextRunAt: '2026-09-10T09:00:00Z',
        catchupPending: false,
        createdAt: '2026-09-07T09:00:00Z',
        updatedAt: '2026-09-07T09:00:00Z',
        ...job,
      }));
    if (url.pathname === '/pods/local-fixture/retry-authorizations' && response.ok)
      data = { createdAt: '2026-09-09T09:00:00Z', ...data };
    if (url.pathname === '/pods/local-fixture/retry-state') {
      data.authorizations = data.authorizations.map((a) => ({
        createdAt: '2026-09-09T09:00:00Z',
        ...a,
      }));
      if (currentMode === 'retry' && url.searchParams.get('stage') !== 'validation')
        data = { ...data, admissionCount: 0, executedCount: 0, latest: null, authorizations: [] };
    }
    finish(data, response.status);
  } catch {
    finish({ error: 'local_fixture_error' }, 500);
  }
});
server.on('upgrade', (_req, socket) => socket.destroy());
server.listen(31994, '127.0.0.1', () => console.log('Native proxy ready on 31994'));

process.on('SIGTERM', () => {
  child?.kill('SIGTERM');
  server.close(() => process.exit(0));
});
