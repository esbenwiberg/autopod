import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  agentEvents,
  createAgentExecutionFixture,
  syntheticComplete,
} from '../test-utils/agent-execution-helpers.js';
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
