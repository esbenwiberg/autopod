import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  agentEvents,
  createAgentExecutionFixture,
  syntheticComplete,
} from '../test-utils/agent-execution-helpers.js';
import { createContinuationContext } from './continuation-context.js';
import { createSessionBridge } from './pod-bridge-impl.js';
import { createPodManager } from './pod-manager.js';

const fixtures: ReturnType<typeof createAgentExecutionFixture>[] = [];
function fixture(disk = false) {
  const f = createAgentExecutionFixture(disk);
  fixtures.push(f);
  return f;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const f of fixtures.splice(0).reverse()) f.close();
});

describe('complete agent process owner', () => {
  it('does not pull a coding iterator after an accepted report during recovery preparation', async () => {
    const f = fixture();
    f.podRepo.update('prepare', { recoveryWorktreePath: f.directory });
    const bridge = createSessionBridge({ ...f.ctx.deps, podManager: createPodManager(f.ctx.deps) });
    f.processCaptured.buildRecoveryTask.mockImplementationOnce(async () => {
      expect(f.pod().status).toBe('running');
      bridge.createEscalation({
        id: 'late-report',
        podId: 'prepare',
        type: 'report_blocker',
        timestamp: new Date().toISOString(),
        response: null,
        payload: {
          kind: 'infrastructure',
          requiresResponse: false,
          description: 'Execution remains blocked',
          attempted: [],
          needs: 'Qualified execution',
        },
      });
      expect(f.podRepo.hasInfrastructureBlocker?.('prepare')).toBe(true);
      return 'Preserve work';
    });
    let pulled = false;
    vi.mocked(f.ctx.runtime.spawn).mockImplementationOnce(async function* () {
      pulled = true;
      yield syntheticComplete;
    });
    await f.process().processPod.call(f.calls, 'prepare');
    expect(f.processCaptured.buildRecoveryTask).toHaveBeenCalledOnce();
    expect(pulled).toBe(false);
    expect(f.podRepo.taskExecutions?.snapshot('prepare').agentRunCount).toBe(0);
  });
  it('dispatches the prepared context through the invocation receiver and completes once', async () => {
    const f = fixture();
    vi.mocked(f.ctx.runtime.spawn).mockReturnValueOnce(agentEvents(syntheticComplete));
    await f.process().processPod.call(f.calls, 'prepare');
    expect(f.ctx.runtime.spawn).toHaveBeenCalledOnce();
    expect(f.calls.consumeAgentEvents).toHaveBeenCalledWith('prepare', expect.anything(), 0, {
      generation: 1,
      containerId: 'container-123',
      nativeGoal: false,
    });
    expect(f.calls.handleCompletion).toHaveBeenCalledExactlyOnceWith('prepare');
    expect(f.registry.activeAgentRuns.size).toBe(0);
  });
  it('starts valid v2 work without bypassing configured validation', async () => {
    const f = fixture();
    f.podRepo.update('prepare', {
      contract: {
        contractVersion: 1,
        title: 'Strict task',
        dependsOn: [],
        scenarios: [],
        requiredFacts: [],
        humanReview: [],
        executionRequirements: { version: 2, executables: ['node'] },
      },
    });
    vi.mocked(f.ctx.runtime.spawn).mockReturnValueOnce(agentEvents(syntheticComplete));
    await f.process().processPod.call(f.calls, 'prepare');
    expect(f.ctx.runtime.spawn).toHaveBeenCalledOnce();
    expect(f.pod().skipValidation).toBe(false);
    expect(f.podRepo.executionProvenance?.latest('prepare')?.status).toBe('checked');
  });
  it.each([
    [false, false],
    [false, null],
    [true, false],
    [true, null],
  ] as const)('never starts or resumes strict work with a missing/unknown launcher (recovery=%s available=%s)', async (recovery, available) => {
    const f = fixture();
    f.podRepo.update('prepare', {
      ...(recovery
        ? { recoveryWorktreePath: f.directory, claudeSessionId: 'retained-session' }
        : {}),
      contract: {
        contractVersion: 1,
        title: 'Strict task',
        dependsOn: [],
        scenarios: [],
        requiredFacts: [],
        humanReview: [],
        executionRequirements: { version: 2, executables: ['required-tool'] },
      },
    });
    const original = f.cm.execInContainer;
    f.cm.execInContainer = vi.fn(async (id, args, options) => {
      if (args[2]?.includes('autopod-command-preflight-v1'))
        return {
          exitCode: 0,
          stdout: JSON.stringify(
            (JSON.parse(args[3] ?? '[]') as string[]).map((executable) => ({
              executable,
              available: executable === 'required-tool' ? available : true,
            })),
          ),
          stderr: '',
        };
      return original(id, args, options);
    });
    let pulled = false;
    vi.mocked(f.ctx.runtime.spawn).mockImplementationOnce(async function* () {
      pulled = true;
      yield syntheticComplete;
    });
    await f.process().processPod.call(f.calls, 'prepare');
    expect(f.ctx.runtime.spawn).not.toHaveBeenCalled();
    expect(f.ctx.runtime.resume).not.toHaveBeenCalled();
    expect(pulled).toBe(false);
    expect(f.podRepo.taskExecutions?.snapshot('prepare').agentRunCount).toBe(0);
    expect(f.podRepo.executionProvenance?.latest('prepare')).toMatchObject({
      status: 'blocked',
      generation: f.pod().lifecycleGeneration,
      commands: {
        requirements: expect.arrayContaining([
          { source: 'contract.executionRequirements', executable: 'required-tool', available },
        ]),
      },
    });
    expect(f.calls.consumeAgentEvents).not.toHaveBeenCalled();
    expect(f.calls.handleCompletion).not.toHaveBeenCalled();
  });
  it.each([
    false,
    null,
  ])('blocks ordinary retained resume on a strict unavailable launcher (%s)', async (available) => {
    const f = fixture();
    f.running();
    f.podRepo.update('prepare', {
      contract: {
        contractVersion: 1,
        title: 'Strict retained task',
        dependsOn: [],
        scenarios: [],
        requiredFacts: [],
        humanReview: [],
        executionRequirements: { version: 2, executables: ['required-tool'] },
      },
    });
    const original = f.cm.execInContainer;
    f.cm.execInContainer = vi.fn(async (id, args, options) => {
      if (args[2]?.includes('autopod-command-preflight-v1'))
        return {
          exitCode: 0,
          stdout: JSON.stringify(
            (JSON.parse(args[3] ?? '[]') as string[]).map((executable) => ({
              executable,
              available: executable === 'required-tool' ? available : true,
            })),
          ),
          stderr: '',
        };
      return original(id, args, options);
    });
    const context = createContinuationContext(
      {},
      {
        podRepo: f.podRepo,
        nudgeRepo: f.deps.nudgeRepo,
        containerManagerFactory: f.deps.containerManagerFactory,
        runtimeRegistry: f.deps.runtimeRegistry,
        mcpBaseUrl: f.deps.mcpBaseUrl,
        executionForPod: () => f.profiles.get('test-profile'),
        resolveEffectiveBoundProfile: f.processCaptured.resolveEffectiveBoundProfile,
        getResumeEnv: vi.fn(async () => ({})),
        primeRuntimeForResume: vi.fn(async () => []),
        emitActivityStatus: vi.fn(),
      },
    );
    await expect(context.taskFeedbackEvents('prepare', 'Continue', false)).rejects.toMatchObject({
      code: available === false ? 'PREFLIGHT_COMMAND_UNAVAILABLE' : 'PREFLIGHT_COMMAND_UNVERIFIED',
    });
    expect(f.ctx.runtime.resume).not.toHaveBeenCalled();
    expect(f.ctx.runtime.spawn).not.toHaveBeenCalled();
    expect(f.podRepo.taskExecutions?.snapshot('prepare').agentRunCount).toBe(0);
    expect(f.podRepo.executionProvenance?.latest('prepare')?.status).toBe('blocked');
  });
  it('does not provision or dispatch an already running pod', async () => {
    const f = fixture();
    f.running();
    await f.process().processPod.call(f.calls, 'prepare');
    expect(f.cm.spawn).not.toHaveBeenCalled();
    expect(f.ctx.runtime.spawn).not.toHaveBeenCalled();
  });
  it('routes skip-agent to the dynamic completion override after clearing the one-shot flag', async () => {
    const f = fixture();
    f.podRepo.update('prepare', { skipAgent: true });
    await f.process().processPod.call(f.calls, 'prepare');
    expect(f.pod().skipAgent).toBe(false);
    expect(f.ctx.runtime.spawn).not.toHaveBeenCalled();
    expect(f.calls.handleCompletion).toHaveBeenCalledExactlyOnceWith('prepare');
    expect(f.calls.consumeAgentEvents).not.toHaveBeenCalled();
  });
  it('always removes the same staged archive set on halted preparation', async () => {
    const f = fixture();
    const archive = join(f.directory, 'staged-reference.tgz');
    writeFileSync(archive, 'private synthetic archive');
    vi.spyOn(f.processCaptured.provisioningWorkflow, 'preparePodExecution').mockImplementation(
      async (input) => {
        input.run.stagedReferenceArchivePaths.add(archive);
        return { kind: 'halted' };
      },
    );
    await f.process().processPod.call(f.calls, 'prepare');
    expect(existsSync(archive)).toBe(false);
    expect(f.ctx.runtime.spawn).not.toHaveBeenCalled();
  });
  it('persists failed sandbox startup admission through the extracted catch/finally and private file reopen', async () => {
    const f = fixture(true);
    f.profiles.update('test-profile', {
      executionTarget: 'sandbox',
      warmImageTag: 'example.azurecr.io/test:latest',
    });
    f.podRepo.update('prepare', { executionTarget: 'sandbox' });
    vi.mocked(f.cm.spawn).mockRejectedValueOnce(new Error('Synthetic spawn failure'));
    await f.process().processPod.call(f.calls, 'prepare');
    expect(f.pod().status).toBe('failed');
    const state = f.podRepo.sandboxStartupRetries?.state('prepare');
    expect(state).toMatchObject({ executedCount: 1, latest: { outcome: 'nonretryable' } });
    const pod = f.pod();
    const next = f.reopen();
    expect(f.db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(f.db.pragma('foreign_key_check')).toEqual([]);
    expect(next.pods.getOrThrow('prepare')).toEqual(pod);
    expect(next.pods.sandboxStartupRetries?.state('prepare')).toEqual(state);
    expect(f.ctx.runtime.spawn).not.toHaveBeenCalled();
  });
});
