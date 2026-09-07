import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve } from 'node:path';
const dist = resolve('packages/mobile-web/dist');
let pod = {
  id: 'local-fixture',
  profileName: 'local-fixture',
  task: '[Local fixture] Review findings after settlement',
  status: 'awaiting_input',
  runtime: 'codex',
  model: 'fixture-model',
  options: { agentMode: 'auto', output: 'pr', validationSuite: 'full', validate: true },
  createdAt: '2026-09-07T10:00:00Z',
  updatedAt: '2026-09-07T10:10:00Z',
  validationAttempts: 0,
  maxValidationAttempts: 3,
  lastValidationResult: null,
  skipValidation: false,
  escalationCount: 1,
  recordDiagnostics: [{ field: 'lastValidationResult', code: 'invalid_json' }],
  finalization: {
    phase: 'awaiting_human',
    cycle: 1,
    agentSettledAt: '2026-09-07T10:09:00Z',
    sourcePreservedAt: '2026-09-07T10:10:00Z',
    pendingDecisionId: 'fixture-decision',
  },
  pendingEscalation: {
    id: 'fixture-decision',
    podId: 'local-fixture',
    type: 'ask_human',
    timestamp: '2026-09-07T10:09:00Z',
    payload: {
      question: 'Which finding should be repaired?',
      options: ['Repair finding A', 'Keep report only'],
    },
    response: null,
  },
};
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const json = (value) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(value));
  };
  if (pathname === '/health')
    return json({
      status: 'ok',
      version: '0.0.1',
      timestamp: new Date().toISOString(),
      requestDurationMs: 1,
      release: { commitSha: 'LOCAL-FIXTURE', dirty: true },
      backup: { state: 'stale', lastCompletedAt: '2026-09-01T00:00:00Z' },
    });
  if (req.method === 'GET' && pathname === '/pods/local-fixture/task-execution')
    return json({
      taskId: 'task:local-original',
      executionId: 'execution:local-fixture',
      rootPodId: 'local-original',
      podCount: 2,
      agentRunCount: 3,
      failedRunCount: 1,
      transientFailureCount: 0,
      providerAttemptCount: 4,
      validationExecutionCount: 5,
      tokenBudget: 100,
      recordedInputTokens: 90,
      recordedOutputTokens: 10,
      recordedCostUsd: 1.25,
      infrastructureCostUsd: null,
      telemetry: 'partial',
      diagnostics: ['Infrastructure cost unavailable'],
    });
  if (req.method === 'GET' && pathname === '/pods') return json([pod]);
  if (req.method === 'GET' && pathname === '/pods/local-fixture') return json(pod);
  if (req.method === 'GET' && /\/pods\/local-fixture\/(events|validations)$/.test(pathname))
    return json([]);
  if (req.method === 'POST' && pathname === '/pods/local-fixture/message') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    console.log(JSON.stringify({ scope: 'local fixture only', action: 'message', payload }));
    pod = {
      ...pod,
      status: 'running',
      pendingEscalation: null,
      finalization: { ...pod.finalization, phase: 'running', pendingDecisionId: null },
    };
    return json(pod);
  }
  if (req.method !== 'GET' || !pathname.startsWith('/mobile/')) {
    res.statusCode = 404;
    return json({ error: 'Fixture route unavailable' });
  }
  const file = resolve(dist, pathname.slice('/mobile/'.length) || 'index.html');
  if (!file.startsWith(`${dist}/`)) {
    res.statusCode = 403;
    return res.end();
  }
  try {
    const data = await readFile(file);
    res.setHeader(
      'content-type',
      {
        '.html': 'text/html',
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.svg': 'image/svg+xml',
      }[extname(file)] ?? 'application/octet-stream',
    );
    res.end(data);
  } catch {
    res.statusCode = 404;
    res.end();
  }
});
server.on('upgrade', (_req, socket) => socket.destroy());
server.listen(0, '127.0.0.1', () =>
  console.log(`http://127.0.0.1:${server.address().port}/mobile/`),
);
