import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve } from 'node:path';
const dist = resolve('packages/mobile-web/dist');
const successfulValidation = {
  podId: 'local-fixture', attempt: 1, timestamp: '2026-09-07T10:10:00Z', overall: 'pass', duration: 100,
  smoke: { status: 'pass', build: { status: 'pass', output: '', duration: 100 }, health: { status: 'skip', url: '', responseCode: null, duration: 0 }, pages: [] },
  test: { status: 'pass', duration: 0, output: '', reusedEvidence: { receiptId: 'local-evidence-1', identityHash: 'a'.repeat(64), originalPodId: 'local-original', originalExecutedAt: '2026-09-07T09:00:00Z', originalDurationMs: 1200 } }, taskReview: null,
};
const validationHistory = [
  { id: 'v11', podId: 'local-fixture', attempt: 1, sequence: 11, cycle: 0, createdAt: '2026-09-07T09:00:00Z', result: { ...successfulValidation, overall: 'fail', timestamp: '2026-09-07T09:00:00Z', test: { status: 'fail', duration: 1200, output: 'Seeded defect detected' } } },
  { id: 'v12', podId: 'local-fixture', attempt: 1, sequence: 12, cycle: 1, createdAt: successfulValidation.timestamp, result: successfulValidation },
];
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
  lastValidationResult: successfulValidation,
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
if (process.env.FIXTURE_MODE === 'retry') pod = { ...pod, status: 'review_required', pendingEscalation: null, recordDiagnostics: [], finalization: { ...pod.finalization, phase: 'ready', pendingDecisionId: null }, lastValidationResult: { ...successfulValidation, overall: 'fail' } };
const scanJob = { id: 'scan-fixture', name: 'Local dependency and secret scan', profileName: 'local-fixture', enabled: false, cronExpression: '0 9 * * *', scan: { version: 1, baseRef: 'main', headRef: 'work', scanners: ['secrets', 'dependencies'], judgment: 'none' } };
const scanFinding = { id: 'fixture-finding-stable-identity', scanner: 'dependencies', ruleId: 'fixture-advisory', file: 'packages/example/package-lock.json', severity: 'high', summary: 'Synthetic dependency finding for local interaction proof.', disposition: 'unresolved' };
const scanReport = { kind: 'scan_report', id: 'report-fixture', jobId: scanJob.id, status: 'incomplete', createdAt: '2026-09-07T10:00:00Z', completedAt: '2026-09-07T10:01:00Z', policy: scanJob.scan, collection: { version: 1, repository: 'https://github.com/example/local-fixture.git', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), files: [{ path: scanFinding.file, change: 'modified' }], scanners: [{ scanner: 'secrets', version: 'fixture-v1', status: 'failed', findingCount: null, diagnostic: 'Synthetic scanner failure; no clean result available.' }, { scanner: 'dependencies', version: 'fixture-v1', status: 'completed', findingCount: 1 }], diagnostics: [], findings: [scanFinding], stacks: ['node'] }, judgment: { status: 'not_requested' } };
let scanDecisions = [];
const retryState = { taskId: 'local-task', stage: 'validation', backoffsMs: [1000, 5000], admissionCount: 4, executedCount: 3, transientRetryCount: 2, measuredDurationMs: 1875, interruptedCount: 1, latest: { id: 'local-failure', outcome: 'unknown' }, authorizations: [], telemetry: 'partial' };
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const json = (value) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(value));
  };
  if (pathname === '/pods/local-fixture/retry-state') return json(retryState);
  if (req.method === 'POST' && pathname === '/pods/local-fixture/retry-authorizations') {
    let body = ''; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    let grant = retryState.authorizations.find((entry) => entry.requestKey === input.requestKey);
    if (!grant) { grant = { ...input, id: 'local-grant', failureId: retryState.latest.id, usedByAttemptId: null }; retryState.authorizations.push(grant); }
    console.log(JSON.stringify({ scope: 'local fixture only', action: 'retry-authorization', requestKey: input.requestKey }));
    return json(grant);
  }
  if (req.method === 'POST' && pathname === '/pods/local-fixture/resume') {
    const grant = retryState.authorizations.find((entry) => !entry.usedByAttemptId);
    if (!grant) { res.statusCode = 409; return json({ error: 'Task-wide retry budget exhausted' }); }
    grant.usedByAttemptId = 'local-new-attempt'; retryState.admissionCount++; retryState.executedCount++;
    retryState.latest = { id: 'local-new-attempt', outcome: 'nonretryable' };
    console.log(JSON.stringify({ scope: 'local fixture only', action: 'resume-validation', simulated: true }));
    return json({ ok: true, action: 'revalidate' });
  }
  if (pathname === '/scheduled-jobs') return json([scanJob]);
  if (pathname === '/scheduled-jobs/scan-fixture/reports') return json([scanReport]);
  if (pathname === '/scheduled-jobs/scan-fixture/trigger') return json(scanReport);
  if (pathname === '/scan-reports/report-fixture') return json({ report: scanReport, unresolved: [scanFinding], decisions: scanDecisions });
  if (req.method === 'POST' && pathname === '/scan-reports/report-fixture/triage') {
    let body = ''; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    let decision = scanDecisions.find((item) => item.requestKey === input.requestKey);
    if (!decision) { decision = { ...input, id: 'fixture-selection', actor: { type: 'human', userId: 'local-fixture' }, createdAt: new Date().toISOString(), repairPodId: null }; scanDecisions.push(decision); }
    console.log(JSON.stringify({ scope: 'local fixture only', action: 'scan-triage', requestKey: input.requestKey, actionType: input.action, findingIds: input.findingIds }));
    return json(decision);
  }
  if (req.method === 'POST' && pathname === '/scan-reports/report-fixture/repairs') {
    let body = ''; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body); const decision = scanDecisions.find((item) => item.id === input.selectionId && item.action === 'select_repair');
    if (!decision) { res.statusCode = 409; return json({ error: 'Recorded selection required' }); }
    decision.repairPodId = 'local-fixture';
    console.log(JSON.stringify({ scope: 'local fixture only', action: 'scan-repair-dispatch', selectionId: decision.id, simulated: true }));
    return json({ kind: 'repair_dispatch', podId: decision.repairPodId, selectionId: decision.id });
  }
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
      delivery: { intentCount: 2, receiptCount: 1, unresolvedCount: 1, scope: 'durable-receipts-only' },
      diagnostics: ['Infrastructure cost unavailable'],
    });
  if (req.method === 'GET' && pathname === '/pods') return json([pod]);
  if (req.method === 'GET' && pathname === '/pods/local-fixture') return json(pod);
  if (req.method === 'GET' && pathname === '/pods/local-fixture/validations') return json(validationHistory);
  if (req.method === 'GET' && pathname === '/pods/local-fixture/events') return json([]);
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
