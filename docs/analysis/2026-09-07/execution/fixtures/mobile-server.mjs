import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve } from 'node:path';
const dist = resolve('packages/mobile-web/dist');
const successfulValidation = {
  podId: 'local-fixture',
  attempt: 1,
  timestamp: '2026-09-07T10:10:00Z',
  overall: 'pass',
  duration: 100,
  smoke: {
    status: 'pass',
    build: { status: 'pass', output: '', duration: 100 },
    health: { status: 'skip', url: '', responseCode: null, duration: 0 },
    pages: [],
  },
  test: {
    status: 'pass',
    duration: 0,
    output: '',
    reusedEvidence: {
      receiptId: 'local-evidence-1',
      identityHash: 'a'.repeat(64),
      originalPodId: 'local-original',
      originalExecutedAt: '2026-09-07T09:00:00Z',
      originalDurationMs: 1200,
    },
  },
  taskReview: null,
};
const validationHistory = [
  {
    id: 'v11',
    podId: 'local-fixture',
    attempt: 1,
    sequence: 11,
    cycle: 0,
    createdAt: '2026-09-07T09:00:00Z',
    result: {
      ...successfulValidation,
      overall: 'fail',
      timestamp: '2026-09-07T09:00:00Z',
      test: { status: 'fail', duration: 1200, output: 'Seeded defect detected' },
    },
  },
  {
    id: 'v12',
    podId: 'local-fixture',
    attempt: 1,
    sequence: 12,
    cycle: 1,
    createdAt: successfulValidation.timestamp,
    result: successfulValidation,
  },
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
if (['retry', 'dispatch'].includes(process.env.FIXTURE_MODE))
  pod = {
    ...pod,
    status: 'review_required',
    pendingEscalation: null,
    recordDiagnostics: [],
    finalization: { ...pod.finalization, phase: 'ready', pendingDecisionId: null },
    lastValidationResult: { ...successfulValidation, overall: 'fail' },
  };
const scanJob = {
  id: 'scan-fixture',
  name: 'Local dependency and secret scan',
  profileName: 'local-fixture',
  enabled: false,
  cronExpression: '0 9 * * *',
  scan: {
    version: 1,
    baseRef: 'main',
    headRef: 'work',
    scanners: ['secrets', 'dependencies'],
    judgment: 'none',
  },
};
const scanFinding = {
  id: 'fixture-finding-stable-identity',
  scanner: 'dependencies',
  ruleId: 'fixture-advisory',
  file: 'packages/example/package-lock.json',
  severity: 'high',
  summary: 'Synthetic dependency finding for local interaction proof.',
  disposition: 'unresolved',
};
const scanReport = {
  kind: 'scan_report',
  id: 'report-fixture',
  jobId: scanJob.id,
  status: 'incomplete',
  createdAt: '2026-09-07T10:00:00Z',
  completedAt: '2026-09-07T10:01:00Z',
  policy: scanJob.scan,
  collection: {
    version: 1,
    repository: 'https://github.com/example/local-fixture.git',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    files: [{ path: scanFinding.file, change: 'modified' }],
    scanners: [
      {
        scanner: 'secrets',
        version: 'fixture-v1',
        status: 'failed',
        findingCount: null,
        diagnostic: 'Synthetic scanner failure; no clean result available.',
      },
      { scanner: 'dependencies', version: 'fixture-v1', status: 'completed', findingCount: 1 },
    ],
    diagnostics: [],
    findings: [scanFinding],
    stacks: ['node'],
  },
  judgment: { status: 'not_requested' },
};
const scanDecisions = [];
const retryState = {
  taskId: 'local-task',
  stage: 'validation',
  backoffsMs: [1000, 5000],
  admissionCount: 4,
  executedCount: 3,
  transientRetryCount: 2,
  measuredDurationMs: 1875,
  interruptedCount: 1,
  latest: { id: 'local-failure', outcome: 'unknown' },
  authorizations: [],
  telemetry: 'partial',
};
const startupRetryFixture = process.env.FIXTURE_MODE === 'sandbox-startup';
if (startupRetryFixture) {
  pod = {
    ...pod,
    status: 'failed',
    executionTarget: 'sandbox',
    pendingEscalation: null,
    recordDiagnostics: [],
    task: '[Local fixture] Inspect exhausted sandbox startup',
    finalization: null,
    lastValidationResult: null,
  };
  retryState.stage = 'sandbox_startup';
  retryState.backoffsMs = [30000];
  retryState.admissionCount = 2;
  retryState.executedCount = 2;
  retryState.transientRetryCount = 1;
  retryState.interruptedCount = 0;
  retryState.latest = { id: 'local-startup-failure', outcome: 'transient' };
}
const deliveryDispositionFixture = [
  'delivery-disposition',
  'merge-disposition',
  'closed-merge',
].includes(process.env.FIXTURE_MODE);
let deliveryDispositionReads = 0;
const missingSourceFixture = process.env.FIXTURE_MODE === 'approval-source-missing';
const normalDeliveryFixture = process.env.FIXTURE_MODE === 'approval-delivery';
const approvalPreservationFixture =
  process.env.FIXTURE_MODE === 'approval-preservation' ||
  normalDeliveryFixture ||
  missingSourceFixture;
let approvalAttempts = 0;
if (approvalPreservationFixture)
  pod = {
    ...pod,
    status: 'validated',
    pendingEscalation: null,
    recordDiagnostics: [],
    finalization: null,
    task: '[Local fixture] Preserve branch after failed approval push',
    branch: 'local-preserved-branch',
    worktreePath: missingSourceFixture ? null : '/local-fixture/preserved-worktree',
    containerId: 'local-preserved-container',
  };
const legacyDeliveryFixture = process.env.FIXTURE_MODE === 'legacy-delivery-recovery';
if (legacyDeliveryFixture)
  pod = {
    ...pod,
    status: 'failed',
    pendingEscalation: null,
    recordDiagnostics: [],
    finalization: null,
    task: '[Local fixture] Revalidate retained legacy delivery',
    failureReason:
      'Delivery history is unavailable. Original resources retained. Use Resume to revalidate the retained source before approving delivery.',
    mergeBlockReason: null,
  };
const closedMergeFixture = process.env.FIXTURE_MODE === 'closed-merge';
if (closedMergeFixture)
  pod = {
    ...pod,
    status: 'failed',
    pendingEscalation: null,
    task: '[Local fixture] Retained closed PR',
    failureReason:
      'PR closed without merging. Original resources retained. Reopen the existing PR, then use Resume to revalidate retained source before approving delivery.',
  };
const costPayloadLimitFixture = process.env.FIXTURE_MODE === 'cost-payload-limit';
const taskBudgetFixture = process.env.TASK_BUDGET_FIXTURE === '1' || costPayloadLimitFixture;
const savedSnapshotRecovery = process.env.ARTIFACT_SNAPSHOT_FIXTURE === '1';
const artifactRecovery = process.env.ARTIFACT_RECOVERY_FIXTURE === '1' || savedSnapshotRecovery;
let artifactRetryCount = 0;
if (artifactRecovery)
  pod = {
    ...pod,
    status: 'failed',
    task: '[Local fixture] Preserve collected report',
    options: { agentMode: 'auto', output: 'artifact', validate: false, promotable: false },
    pendingEscalation: null,
    recordDiagnostics: [],
    artifactsPath: savedSnapshotRecovery ? '/local-fixture/snapshot' : null,
    finalization: {
      ...pod.finalization,
      phase: 'preserving',
      sourcePreservedAt: savedSnapshotRecovery ? '2026-09-07T10:01:00Z' : null,
      pendingDecisionId: null,
    },
  };
let rerunDecision = null;
let rerunResponseLost = false;
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const json = (value) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(value));
  };
  if (
    approvalPreservationFixture &&
    req.method === 'POST' &&
    pathname === '/pods/local-fixture/approve'
  ) {
    approvalAttempts++;
    console.log(
      JSON.stringify({
        scope: 'local fixture only',
        action: 'approve-preserved-branch',
        attempt: approvalAttempts,
      }),
    );
    if (approvalAttempts === 1) {
      const message = missingSourceFixture
        ? 'Approval delivery failed. Worktree identity is unavailable. Original resources retained; repair delivery and retry approval.'
        : normalDeliveryFixture
          ? 'Approval delivery failed. Branch push did not complete. Original resources retained; repair delivery and retry approval.'
          : 'Branch preservation failed. Original resources retained; repair the branch or remote access and retry approval.';
      pod = { ...pod, failureReason: message };
      res.statusCode = missingSourceFixture ? 409 : 502;
      return json({
        error: missingSourceFixture
          ? 'DELIVERY_RECONCILIATION_REQUIRED'
          : normalDeliveryFixture
            ? 'APPROVAL_DELIVERY_FAILED'
            : 'BRANCH_PRESERVATION_FAILED',
        message,
      });
    }
    pod = {
      ...pod,
      status: 'complete',
      failureReason: null,
      ...(missingSourceFixture ? { worktreePath: '/local-fixture/restored-worktree' } : {}),
    };
    return json({ ok: true });
  }
  if (pathname === '/pods/local-fixture/execution-provenance')
    return json({
      latest: JSON.parse(
        await readFile(new URL('./execution-provenance.json', import.meta.url), 'utf8'),
      ),
    });
  if (pathname === '/pods/local-fixture/dispatch-preflight')
    return json({
      latest: {
        id: 'fixture-receipt',
        executionId: 'fixture-execution',
        taskId: 'fixture-task',
        status: 'review_required',
        repository: 'github.com/example/repo',
        baseBranch: 'main',
        baseCommitSha: 'a'.repeat(40),
        checkedAt: '2026-09-07T15:00:00Z',
        conflicts: [
          {
            podId: 'prior-fixture',
            executionId: 'prior-execution',
            status: 'validated',
            evidence: 'dispatch_receipt',
          },
        ],
        rerun: null,
      },
    });
  if (pathname === '/pods/local-fixture/rerun-template')
    return json({
      profileName: pod.profileName,
      task: pod.task,
      options: pod.options,
      model: pod.model,
      runtime: pod.runtime,
    });
  if (req.method === 'POST' && pathname === '/pods') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    if (rerunDecision && JSON.stringify(rerunDecision) !== JSON.stringify(request)) {
      res.statusCode = 409;
      return json({ message: 'Different request after lost response' });
    }
    rerunDecision = request;
    console.log(
      JSON.stringify({
        action: 'intentional-rerun',
        requestKey: request.intentionalRerun.requestKey,
        reason: request.intentionalRerun.reason,
        simulated: true,
      }),
    );
    if (!rerunResponseLost) {
      rerunResponseLost = true;
      res.statusCode = 503;
      return json({
        message:
          'Response unavailable after recording the simulated rerun. Retry the same request.',
      });
    }
    return json({ ...pod, id: 'same-fixture-rerun', status: 'queued' });
  }
  if (pathname === '/pods/local-fixture/retry-state') {
    const stage = new URL(req.url, 'http://localhost').searchParams.get('stage') ?? 'validation';
    if (startupRetryFixture && stage === 'validation')
      return json({
        ...retryState,
        stage,
        backoffsMs: null,
        admissionCount: 0,
        executedCount: 0,
        transientRetryCount: 0,
        measuredDurationMs: 0,
        latest: null,
        authorizations: [],
      });
    return json(retryState);
  }
  if (req.method === 'POST' && pathname === '/pods/local-fixture/retry-authorizations') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    let grant = retryState.authorizations.find((entry) => entry.requestKey === input.requestKey);
    if (!grant) {
      grant = {
        ...input,
        id: 'local-grant',
        failureId: retryState.latest.id,
        usedByAttemptId: null,
      };
      retryState.authorizations.push(grant);
    }
    console.log(
      JSON.stringify({
        scope: 'local fixture only',
        action: 'retry-authorization',
        stage: input.stage ?? 'validation',
        requestKey: input.requestKey,
      }),
    );
    return json(grant);
  }
  if (req.method === 'POST' && pathname === '/pods/local-fixture/resume') {
    if (legacyDeliveryFixture) {
      pod = {
        ...pod,
        status: 'validated',
        failureReason: null,
        mergeBlockReason: null,
        updatedAt: new Date().toISOString(),
      };
      console.log(
        JSON.stringify({
          scope: 'local fixture only',
          action: 'resume-legacy-validation',
          workerStarts: 0,
          merges: 0,
        }),
      );
      return json({ ok: true, action: 'revalidate' });
    }
    if (artifactRecovery) {
      artifactRetryCount++;
      console.log(
        JSON.stringify({
          scope: 'local fixture only',
          action: 'collect-artifacts',
          attempt: artifactRetryCount,
          workerStarts: 0,
        }),
      );
      if (artifactRetryCount === 1) {
        res.statusCode = savedSnapshotRecovery ? 409 : 502;
        return json({
          error: savedSnapshotRecovery
            ? 'ARTIFACT_SNAPSHOT_UNVERIFIED'
            : 'ARTIFACT_PRESERVATION_FAILED',
          message: savedSnapshotRecovery
            ? 'Saved artifact snapshot could not be verified. Restore its snapshot and receipt before finalizing; the settled worker was not restarted.'
            : 'Artifact preservation failed. Original container retained.',
        });
      }
      pod = {
        ...pod,
        status: 'complete',
        updatedAt: new Date().toISOString(),
        artifactsPath: '/local-fixture/snapshot',
        finalization: {
          ...pod.finalization,
          phase: 'finished',
          sourcePreservedAt: new Date().toISOString(),
        },
      };
      return json({ ok: true, action: 'collect-artifacts' });
    }

    const grant = retryState.authorizations.find((entry) => !entry.usedByAttemptId);
    if (!grant) {
      res.statusCode = 409;
      return json({
        error: 'TASK_RETRY_RECONCILIATION_REQUIRED',
        message: 'Task-wide retry budget exhausted; record an authorized retry with a reason.',
      });
    }
    grant.usedByAttemptId = 'local-new-attempt';
    retryState.admissionCount++;
    retryState.executedCount++;
    retryState.latest = { id: 'local-new-attempt', outcome: 'nonretryable' };
    console.log(
      JSON.stringify({
        scope: 'local fixture only',
        action: startupRetryFixture ? 'resume-sandbox-startup' : 'resume-validation',
        simulated: true,
      }),
    );
    return json({ ok: true, action: startupRetryFixture ? 'retry-agent' : 'revalidate' });
  }
  if (pathname === '/scheduled-jobs') return json([scanJob]);
  if (pathname === '/scheduled-jobs/scan-fixture/reports') return json([scanReport]);
  if (pathname === '/scheduled-jobs/scan-fixture/trigger') return json(scanReport);
  if (pathname === '/scan-reports/report-fixture')
    return json({ report: scanReport, unresolved: [scanFinding], decisions: scanDecisions });
  if (req.method === 'POST' && pathname === '/scan-reports/report-fixture/triage') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    let decision = scanDecisions.find((item) => item.requestKey === input.requestKey);
    if (!decision) {
      decision = {
        ...input,
        id: 'fixture-selection',
        actor: { type: 'human', userId: 'local-fixture' },
        createdAt: new Date().toISOString(),
        repairPodId: null,
      };
      scanDecisions.push(decision);
    }
    console.log(
      JSON.stringify({
        scope: 'local fixture only',
        action: 'scan-triage',
        requestKey: input.requestKey,
        actionType: input.action,
        findingIds: input.findingIds,
      }),
    );
    return json(decision);
  }
  if (req.method === 'POST' && pathname === '/scan-reports/report-fixture/repairs') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    const decision = scanDecisions.find(
      (item) => item.id === input.selectionId && item.action === 'select_repair',
    );
    if (!decision) {
      res.statusCode = 409;
      return json({ error: 'Recorded selection required' });
    }
    decision.repairPodId = 'local-fixture';
    console.log(
      JSON.stringify({
        scope: 'local fixture only',
        action: 'scan-repair-dispatch',
        selectionId: decision.id,
        simulated: true,
      }),
    );
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
  if (
    deliveryDispositionFixture &&
    req.method === 'GET' &&
    pathname === '/pods/local-fixture/task-execution'
  ) {
    deliveryDispositionReads++;
    console.log(
      JSON.stringify({
        scope: 'local fixture only',
        action: 'read-delivery-disposition',
        request: deliveryDispositionReads,
      }),
    );
  }
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
      budgetCheck: taskBudgetFixture
        ? {
            status: 'unavailable',
            reason:
              'Task token accounting incomplete; reconcile prior execution and phase telemetry before starting more budgeted work.',
          }
        : {
            status: 'exhausted',
            reason: 'Recorded task tokens have reached the configured limit.',
          },
      recordedInputTokens: taskBudgetFixture ? 10 : 90,
      recordedOutputTokens: taskBudgetFixture ? 5 : 10,
      recordedCostUsd: costPayloadLimitFixture ? 1 : 1.25,
      costEvidence: costPayloadLimitFixture
        ? {
            basis: 'stored_subtotal',
            billingVerified: false,
            knownEstimatedCostUsd: 0,
            unavailablePhaseCount: 0,
            conflictingPodCount: 0,
            omittedDiagnosticCount: 0,
            diagnostics: [
              {
                podId: 'local-original',
                code: 'PHASE_PAYLOAD_LIMIT',
                message:
                  'Phase telemetry exceeds the 64 KiB read limit; its cost is unavailable and the stored source is preserved.',
              },
            ],
          }
        : {
            basis: 'stored_subtotal',
            billingVerified: false,
            knownEstimatedCostUsd: 0.5,
            unavailablePhaseCount: 1,
            conflictingPodCount: 1,
            omittedDiagnosticCount: 2,
            diagnostics: [
              {
                podId: 'local-original',
                code: 'PHASE_COST_CONFLICT',
                message: 'Stored phase costs conflict; no proportional allocation applied.',
              },
            ],
          },
      ...(closedMergeFixture && deliveryDispositionReads > 1
        ? {
            merge: {
              prCount: 1,
              requestCount: 0,
              mergedPrCount: 0,
              closedPrCount: 1,
              mergedWithoutRecordedRequestCount: 0,
              unresolvedPrCount: 0,
              scope: 'source-bound-journal-only',
              basis: 'last-recorded',
              liveVerified: false,
            },
          }
        : {}),
      infrastructureCostUsd: null,
      ...(process.env.FIXTURE_MODE === 'merge-disposition' && deliveryDispositionReads > 1
        ? {
            merge: {
              prCount: 2,
              requestCount: 3,
              mergedPrCount: 1,
              mergedWithoutRecordedRequestCount: 1,
              unresolvedPrCount: 1,
              scope: 'source-bound-journal-only',
              basis: 'last-recorded',
              liveVerified: false,
            },
          }
        : {}),
      telemetry: 'partial',
      delivery: {
        intentCount: 2,
        receiptCount: 1,
        unresolvedCount: 1,
        scope: 'durable-receipts-only',
        ...(deliveryDispositionFixture && deliveryDispositionReads > 1
          ? {
              disposition: {
                openCount: 0,
                mergedCount: closedMergeFixture ? 0 : 1,
                closedCount: closedMergeFixture ? 1 : 0,
                unavailableCount: 0,
                basis: 'last-recorded',
                liveVerified: false,
              },
            }
          : {}),
      },
      diagnostics: ['Infrastructure cost unavailable'],
    });
  if (req.method === 'GET' && pathname === '/pods') return json([pod]);
  if (req.method === 'GET' && pathname === '/pods/local-fixture') return json(pod);
  if (req.method === 'GET' && pathname === '/pods/local-fixture/validations')
    return json(validationHistory);
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
server.listen(Number(process.env.FIXTURE_PORT ?? 0), '127.0.0.1', () =>
  console.log(`http://127.0.0.1:${server.address().port}/mobile/`),
);
