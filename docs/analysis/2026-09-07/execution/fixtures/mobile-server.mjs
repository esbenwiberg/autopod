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
if (process.env.FIXTURE_MODE === 'foundry-review-unavailable') {
  const reason =
    'Review failed: Foundry tool review unavailable on the selected provider binding; reconcile it before retry.';
  const blocked = {
    ...successfulValidation,
    attempt: 2,
    timestamp: '2026-09-08T09:00:00Z',
    overall: 'fail',
    reviewSkipKind: 'review-failed',
    reviewSkipReason: reason,
    reviewTokenUsage: { inputTokens: 100, outputTokens: 10 },
    taskReview: {
      status: 'fail',
      model: 'local-foundry-fixture',
      reasoning: reason,
      issues: ['Retained initial finding from the completed review'],
      screenshots: [],
      tokenUsage: { inputTokens: 100, outputTokens: 10 },
    },
  };
  pod = {
    ...pod,
    task: '[Local fixture] Inspect unavailable Foundry deep review',
    status: 'review_required',
    pendingEscalation: null,
    recordDiagnostics: [],
    finalization: { ...pod.finalization, phase: 'ready', pendingDecisionId: null },
    lastValidationResult: blocked,
  };
  validationHistory.push({
    id: 'v13',
    podId: pod.id,
    attempt: 2,
    sequence: 13,
    cycle: 1,
    createdAt: blocked.timestamp,
    result: blocked,
  });
}
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
if (process.env.FIXTURE_MODE === 'judgment-unavailable') {
  scanReport.judgment = {
    status: 'unavailable',
    text: 'Judgment output was incomplete or exceeded its bound. Deterministic evidence and human triage remain available. Known response usage is retained; billing is unverified.',
    usage: {
      inputTokens: 25,
      outputTokens: 7,
      costUsd: null,
      durationMs: 14500,
      model: 'fixture-bound-model',
      provider: 'max',
      providerAccountId: null,
    },
  };
}
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
const unverifiedTerminationFixture = process.env.FIXTURE_MODE === 'unverified-termination';
const terminationMessage =
  'A worker in this logical task has unverified process termination. Retain its source and resources; reconcile termination before Resume, Rework, validation or delivery.';
if (unverifiedTerminationFixture) {
  pod = {
    ...pod,
    status: 'failed',
    pendingEscalation: null,
    recordDiagnostics: [],
    finalization: null,
    lastValidationResult: null,
    task: '[Local fixture] Retain unverified worker execution',
    failureReason: terminationMessage,
  };
}
const uncollectedGuidanceFixture = process.env.FIXTURE_MODE === 'uncollected-guidance';
if (uncollectedGuidanceFixture) {
  pod = {
    ...pod,
    status: 'failed',
    pendingEscalation: null,
    lastValidationResult: null,
    task: '[Local fixture] Apply saved human guidance',
    failureReason:
      'Worker settled with uncollected human guidance. Use Rework to collect check_messages and apply the saved guidance before validation or delivery. Original resources and guidance retained.',
    finalization: { ...pod.finalization, phase: 'awaiting_human', pendingDecisionId: null },
  };
}
const workerDeadlineFixture = process.env.FIXTURE_MODE === 'worker-deadline';
const workerTransientFixture =
  process.env.FIXTURE_MODE === 'worker-transient' || workerDeadlineFixture;
const workerUnknownFixture = process.env.FIXTURE_MODE === 'worker-unknown';
const workerAuthFixture =
  process.env.FIXTURE_MODE === 'worker-auth' || workerTransientFixture || workerUnknownFixture;
if (workerAuthFixture) {
  pod = {
    ...pod,
    runtime: 'codex',
    status: 'failed',
    executionTarget: 'local',
    pendingEscalation: null,
    recordDiagnostics: [],
    finalization: null,
    lastValidationResult: null,
    task: '[Local fixture] Retry worker after authentication reconciliation',
    failureReason:
      'Authentication retry initialization failed before worker execution. Record a new permission before another attempt.',
  };
  Object.assign(retryState, {
    stage: 'worker',
    backoffsMs: [],
    admissionCount: 2,
    executedCount: 1,
    transientRetryCount: 0,
    measuredDurationMs: 150,
    interruptedCount: 0,
    authorizationRequired: true,
    latest: { id: 'local-unstarted-retry', outcome: 'unknown', startedAt: null },
  });
}
if (workerUnknownFixture) {
  pod = {
    ...pod,
    task: '[Local fixture] Reconcile an unknown worker failure',
    failureReason:
      'Worker failed without a classified cause. Inspect preserved source and record permission before rework.',
  };
  Object.assign(retryState, {
    retryFailure: 'unknown',
    admissionCount: 1,
    executedCount: 1,
    latest: { id: 'unknown-worker', outcome: 'unknown' },
  });
}
if (workerTransientFixture) {
  pod = {
    ...pod,
    task: '[Local fixture] Retry a throttled worker within the task allowance',
    failureReason:
      'Provider throttled. One recorded task retry remains; Rework waits for its cooldown.',
  };
  Object.assign(retryState, {
    retryFailure: 'transient',
    authorizationRequired: false,
    backoffsMs: [1000],
    admissionCount: 1,
    executedCount: 1,
    transientRetryCount: 0,
    latest: {
      id: 'local-throttled',
      outcome: 'transient',
      providerRetryNotBefore: workerDeadlineFixture
        ? new Date(Date.now() + 3600000).toISOString()
        : null,
    },
  });
}
const codexRecoveryFixture = process.env.FIXTURE_MODE === 'codex-recovery';
if (codexRecoveryFixture) {
  pod = {
    ...pod,
    runtime: 'codex',
    status: 'failed',
    executionTarget: 'local',
    pendingEscalation: null,
    recordDiagnostics: [],
    finalization: null,
    lastValidationResult: null,
    task: '[Local fixture] Inspect task-wide Codex interruption allowance',
    failureReason:
      'Automatic task-wide Codex interruption recovery allowance consumed; inspect retained session/results before another inner recovery.',
  };
  Object.assign(retryState, {
    stage: 'codex_interruption',
    backoffsMs: [],
    admissionCount: 1,
    executedCount: 1,
    transientRetryCount: 0,
    measuredDurationMs: 1875,
    interruptedCount: 0,
    latest: { id: 'local-recovery', outcome: 'pass' },
  });
}
if (process.env.FIXTURE_MODE === 'unverified-exit') {
  pod = {
    ...pod,
    status: 'failed',
    runtime: 'codex',
    pendingEscalation: null,
    finalization: null,
    lastValidationResult: null,
    task: '[Local fixture] Retained completion with unverified termination',
    failureReason:
      'Codex execution termination is unverified; retain completion and source, and reconcile before validation or another execution.',
  };
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
  const json = (value, status = 200) => {
    res.statusCode = status;
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
        await readFile(
          new URL(
            process.env.FIXTURE_MODE === 'host-reviewer-provenance'
              ? './host-reviewer-provenance.json'
              : process.env.FIXTURE_MODE === 'legacy-api-reviewer-provenance'
                ? './legacy-api-reviewer-provenance.json'
                : process.env.FIXTURE_MODE === 'api-reviewer-provenance'
                  ? './api-reviewer-provenance.json'
                  : process.env.FIXTURE_MODE === 'reviewer-provenance'
                    ? './reviewer-provenance.json'
                    : './execution-provenance.json',
            import.meta.url,
          ),
          'utf8',
        ),
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
    if (
      (startupRetryFixture && stage === 'validation') ||
      (codexRecoveryFixture && stage !== 'codex_interruption') ||
      (workerAuthFixture && stage !== 'worker')
    )
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
  if (
    workerTransientFixture &&
    req.method === 'POST' &&
    pathname === '/pods/local-fixture/validate'
  ) {
    if (workerDeadlineFixture) {
      console.log(
        JSON.stringify({ scope: 'local fixture only', action: 'provider-cooldown-blocked' }),
      );
      return json(
        {
          error: 'TASK_RETRY_BACKOFF_PENDING',
          message: `Provider retry cooldown remains until ${retryState.latest.providerRetryNotBefore}. No permission or retry allowance was consumed.`,
        },
        409,
      );
    }
    Object.assign(retryState, {
      admissionCount: 2,
      executedCount: 2,
      transientRetryCount: 1,
      authorizationRequired: true,
      latest: { id: 'local-retry-throttled', outcome: 'transient' },
    });
    pod = {
      ...pod,
      failureReason:
        'Task retry allowance exhausted. Inspect the provider and record one permission to retry again.',
    };
    console.log(
      JSON.stringify({
        scope: 'local fixture only',
        action: 'rework-worker',
        admitted: 2,
        executed: 2,
      }),
    );
    return json({ ok: true, action: 'restart-agent' });
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
  if (
    uncollectedGuidanceFixture &&
    req.method === 'POST' &&
    pathname === '/pods/local-fixture/validate'
  ) {
    pod = { ...pod, status: 'queued', failureReason: null };
    console.log(
      JSON.stringify({
        scope: 'local fixture only',
        action: 'rework-uncollected-guidance',
        endpoint: pathname,
      }),
    );
    return json({ ok: true, accepted: true });
  }
  if (
    unverifiedTerminationFixture &&
    req.method === 'POST' &&
    ['/pods/local-fixture/resume', '/pods/local-fixture/validate'].includes(pathname)
  ) {
    console.log(
      JSON.stringify({
        scope: 'local fixture only',
        action: 'rejected-unverified-termination',
        endpoint: pathname,
        status: 409,
      }),
    );
    res.statusCode = 409;
    return json(
      pathname.endsWith('/resume')
        ? { error: terminationMessage, code: 'TASK_EXECUTION_TERMINATION_UNVERIFIED' }
        : { error: 'TASK_EXECUTION_TERMINATION_UNVERIFIED', message: terminationMessage },
    );
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
  if (pathname === '/scheduled-jobs/scan-fixture/report-page') {
    const older = new URL(req.url, 'http://localhost').searchParams.has('before');
    return json({
      items: [
        {
          id: older ? 'report-old-fixture' : scanReport.id,
          jobId: scanJob.id,
          status: 'incomplete',
          createdAt: older ? '2026-09-06T10:00:00Z' : scanReport.createdAt,
          completedAt: scanReport.completedAt,
          findingCount: older ? null : 1,
          judgmentStatus: older ? null : 'not_requested',
          diagnostics: older ? ['Finding count unavailable; inspect report evidence.'] : [],
        },
      ],
      nextCursor: older ? null : scanReport.id,
    });
  }
  if (pathname === '/scan-reports/report-old-fixture')
    return json({
      report: { ...scanReport, id: 'report-old-fixture' },
      unresolved: [scanFinding],
      decisions: [],
    });
  if (pathname === '/scheduled-jobs/scan-fixture/reports') return json([scanReport]);
  if (pathname === '/scheduled-jobs/scan-fixture/trigger') return json(scanReport);
  if (
    process.env.FIXTURE_MODE === 'unreadable-report' &&
    pathname === '/scan-reports/report-fixture/review'
  ) {
    return json({
      report: {
        ...scanReport,
        status: 'complete',
        policy: null,
        collection: null,
        judgment: null,
        evidenceDiagnostics: [
          'Policy evidence unavailable: malformed stored record. Reconcile original evidence before acting.',
          'Collection evidence unavailable: no clean result can be verified.',
          'Judgment evidence unavailable: malformed stored record.',
        ],
      },
      unresolved: [],
      decisions: [],
      diagnostics: [
        {
          kind: 'report',
          recordId: scanReport.id,
          message: 'Collection scope unavailable. Findings have not been enumerated.',
        },
      ],
    });
  }
  if (
    process.env.FIXTURE_MODE === 'unreadable-triage' &&
    pathname === '/scan-reports/report-fixture/review'
  ) {
    return json({
      report: scanReport,
      unresolved: [],
      decisions: [],
      diagnostics: [
        {
          kind: 'finding',
          recordId: 'unreadable-finding-fixture',
          message:
            'Finding evidence unavailable: malformed stored record. It remains stored and cannot authorize a repair.',
        },
        {
          kind: 'decision',
          recordId: 'unreadable-decision-fixture',
          message:
            'Decision evidence unavailable: malformed stored record. Reconcile the original evidence.',
        },
      ],
      unresolvedNextCursor: 'unreadable-finding-fixture',
      decisionsNextCursor: '00000000-0000-4000-8000-000000000074',
    });
  }
  if (
    pathname === '/scan-reports/report-fixture/review' ||
    pathname === '/scan-reports/report-old-fixture/review'
  ) {
    return json({
      report: pathname.includes('report-old-fixture')
        ? { ...scanReport, id: 'report-old-fixture' }
        : scanReport,
      unresolved: [scanFinding],
      decisions: scanDecisions,
      unresolvedNextCursor: process.env.FIXTURE_MODE === 'paged-triage' ? scanFinding.id : null,
      decisionsNextCursor:
        process.env.FIXTURE_MODE === 'paged-triage' ? '00000000-0000-4000-8000-000000000001' : null,
    });
  }
  if (pathname === '/scan-reports/report-fixture/findings')
    return json({
      items: [
        {
          ...scanFinding,
          id: 'later-finding-fixture',
          file: 'packages/older/package-lock.json',
          summary: 'Earlier unresolved fixture finding, still available for human review.',
        },
      ],
      nextCursor: null,
    });
  if (pathname === '/scan-reports/report-fixture/decisions')
    return json({
      items: [
        {
          id: '00000000-0000-4000-8000-000000000002',
          action: 'defer',
          findingIds: ['later-finding-fixture'],
          reason: 'Earlier human decision remains recorded.',
          actor: { type: 'human', userId: 'fixture-reviewer' },
          createdAt: '2026-09-06T10:00:00Z',
          repairPodId: null,
        },
      ],
      nextCursor: null,
    });
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
      diagnostics:
        process.env.FIXTURE_MODE === 'unsettled-run' || unverifiedTerminationFixture
          ? [
              'Infrastructure cost unavailable',
              '1 unsettled worker run blocks another task run; live execution state unverified.',
              'Oldest unsettled run recorded local container original-container; this reference does not prove process termination or a unique remote instance.',
            ]
          : process.env.FIXTURE_MODE === 'archived-task'
            ? [
                'Infrastructure cost unavailable',
                '1 deleted pod record retains task accounting and execution evidence.',
              ]
            : ['Infrastructure cost unavailable'],
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
