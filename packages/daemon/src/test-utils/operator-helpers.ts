import { PendingRequests } from '@autopod/escalation-mcp';
import type { EscalationRequest, ExecutionTarget, PodGoal } from '@autopod/shared';
import { afterEach, vi } from 'vitest';
import { createAgentRunRegistry } from '../pods/agent-run-registry.js';
import { persistEscalation } from '../pods/escalation-coordinator.js';
import type {
  OperatorControlsCaptured,
  OperatorKillCaptured,
  OperatorKillLiveDependencies,
  OperatorMessageLiveDependencies,
  OperatorMessagesCaptured,
  OperatorPauseCaptured,
  OperatorPauseLiveDependencies,
  OperatorRejectionCaptured,
  OperatorToolsCaptured,
  OperatorWorkflowCalls,
} from '../pods/operator-contracts.js';
import { createOperatorControls } from '../pods/operator-controls.js';
import { createOperatorKill } from '../pods/operator-kill.js';
import { createOperatorMessages } from '../pods/operator-messages.js';
import { createOperatorPause } from '../pods/operator-pause.js';
import { createOperatorRejection } from '../pods/operator-rejection.js';
import { createOperatorPauseState } from '../pods/operator-state.js';
import { createOperatorTools } from '../pods/operator-tools.js';
import { createFixCycleFixture } from './fix-cycle-helpers.js';

const waiters: PendingRequests[] = [];
afterEach(() => {
  for (const pending of waiters.splice(0)) pending.cancelAll();
});
export function createOperatorFixture(disk = false, target: ExecutionTarget = 'local') {
  const f = createFixCycleFixture(disk);
  if (target !== 'local') {
    const containerId = f.pod().containerId;
    f.podRepo.update('prepare', { containerId: null });
    f.podRepo.update('prepare', { executionTarget: target });
    f.podRepo.update('prepare', { containerId });
  }
  f.podRepo.update('prepare', { status: 'running', prUrl: null });
  const state = createOperatorPauseState();
  const registry = createAgentRunRegistry();
  const live: OperatorMessageLiveDependencies &
    OperatorPauseLiveDependencies &
    OperatorKillLiveDependencies = {};
  const calls = {
    handleCompletion: vi.fn<OperatorWorkflowCalls['handleCompletion']>(async () => {}),
    approveSession: vi.fn<OperatorWorkflowCalls['approveSession']>(async () => {}),
    triggerValidation: vi.fn<OperatorWorkflowCalls['triggerValidation']>(async () => {}),
    consumeAgentEvents: vi.fn<OperatorWorkflowCalls['consumeAgentEvents']>(async () => 'completed'),
    refreshNetworkPolicy: vi.fn<OperatorWorkflowCalls['refreshNetworkPolicy']>(async () => {}),
    killSession: vi.fn<OperatorWorkflowCalls['killSession']>(async () => {}),
  };
  const messagesCaptured = {
    ...f.mainCaptured,
    ...state,
    ...registry,
    escalationRepo: f.deps.escalationRepo,
    nudgeRepo: f.deps.nudgeRepo,
    enqueueSession: vi.fn(),
    prManagerFactory: () => f.provider,
    stopSandboxPreviewProxy: f.captured.stopSandboxPreviewProxy,
    parkOnCredentialFailure: f.credentials().parkOnCredentialFailure,
    completeFixPodAfterPush: f.passCaptured.completeFixPodAfterPush,
    beginGoalTaskRework: vi.fn<OperatorMessagesCaptured['beginGoalTaskRework']>(async () => false),
    mergeOverrides: vi.fn<OperatorMessagesCaptured['mergeOverrides']>((existing, incoming) => [
      ...existing,
      ...incoming,
    ]),
    taskFeedbackEvents: vi.fn<OperatorMessagesCaptured['taskFeedbackEvents']>(async () =>
      (async function* () {})(),
    ),
    persistRuntimeCredentialsForPod: f.captured.persistRuntimeCredentialsForPod,
    getResumeEnv: vi.fn<OperatorMessagesCaptured['getResumeEnv']>(async () => ({})),
    runtimeRegistry: f.ctx.runtimeRegistry,
    recordContinuationProvenance: vi.fn(async () => {}),
    primeRuntimeForResume: vi.fn<OperatorMessagesCaptured['primeRuntimeForResume']>(async () => []),
    buildRecoveryTask: vi.fn(async () => 'Synthetic recovery'),
    resolveEffectiveBoundProfile: f.captured.resolveEffectiveBoundProfile,
  } satisfies OperatorMessagesCaptured;
  const rejectionCaptured = { ...messagesCaptured } satisfies OperatorRejectionCaptured;
  const pauseCaptured = { ...messagesCaptured } satisfies OperatorPauseCaptured;
  const killCaptured = {
    ...messagesCaptured,
    ...f.guards,
    clearPreviewTimer: vi.fn(),
    stopMergePolling: vi.fn(),
    validationAbortControllers: new Map<string, AbortController>(),
    killSidecarsForPod: f.captured.killSidecarsForPod,
    cleanupTestRunBranches: vi.fn<OperatorKillCaptured['cleanupTestRunBranches']>(async () => {}),
    destroyPodNetwork: f.captured.destroyPodNetwork,
    forgetMaxCredentialLineage: vi.fn(),
  } satisfies OperatorKillCaptured;
  const controlsCaptured = {
    ...f.mainCaptured,
    nudgeRepo: f.deps.nudgeRepo,
  } satisfies OperatorControlsCaptured;
  const toolsCaptured = {
    ...f.mainCaptured,
    installGhBinary: vi.fn<OperatorToolsCaptured['installGhBinary']>(async () => {}),
    installAzViaPip: vi.fn<OperatorToolsCaptured['installAzViaPip']>(async () => {}),
  } satisfies OperatorToolsCaptured;
  function awaiting(
    type: EscalationRequest['type'] = 'ask_human',
    payload: EscalationRequest['payload'] = { question: 'Proceed?', context: 'Synthetic context' },
  ) {
    f.podRepo.update('prepare', { status: 'running' });
    const request: EscalationRequest = {
      id: 'operator-decision',
      podId: 'prepare',
      type,
      timestamp: new Date().toISOString(),
      payload,
      response: null,
    };
    persistEscalation(f.podRepo, f.deps.escalationRepo, request, () => {
      f.events.transition(f.pod(), 'awaiting_input', {
        pendingEscalation: request,
        escalationCount: f.pod().escalationCount + 1,
      });
    });
    return request;
  }
  function waiter(detached = false) {
    const pending = new PendingRequests();
    const wait = pending.waitForResponse('operator-decision', 60_000);
    void wait.catch(() => undefined);
    if (detached) pending.markDetached('operator-decision', 'Synthetic closed transport');
    waiters.push(pending);
    live.pendingRequestsByPod = new Map([['prepare', pending]]);
    return { pending, wait };
  }
  async function goal() {
    const native = await f.nativeParent();
    const record: PodGoal = {
      podId: 'prepare',
      objective: 'Synthetic Goal',
      state: 'active',
      revision: 1,
      runtime: 'codex',
      fence: null,
      nativeSessionId: null,
      nativeStatus: null,
      executionStopped: false,
      controlIntent: null,
      observedTokens: 0,
      observedSeconds: 0,
      reason: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const control = vi.fn(async () => record);
    live.launchConfiguration = {
      read: () => ({ ...native.parent.config, intent: 'goal' }),
      goals: { get: vi.fn(() => record), control },
    };
    return { record, control };
  }
  function activeRun() {
    let settle = () => {};
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const token = Symbol('run');
    registry.activeAgentRuns.set('prepare', { token, settled });
    return { token, settled, settle };
  }
  return {
    ...f,
    get db() {
      return f.db;
    },
    state,
    registry,
    live,
    calls,
    messagesCaptured,
    rejectionCaptured,
    pauseCaptured,
    killCaptured,
    controlsCaptured,
    toolsCaptured,
    awaiting,
    waiter,
    goal,
    activeRun,
    messages: () => createOperatorMessages(live, messagesCaptured),
    rejection: () => createOperatorRejection(rejectionCaptured),
    pause: () => createOperatorPause(live, pauseCaptured),
    kill: () => createOperatorKill(live, killCaptured),
    controls: () => createOperatorControls(controlsCaptured),
    tools: () => createOperatorTools(toolsCaptured),
  };
}
