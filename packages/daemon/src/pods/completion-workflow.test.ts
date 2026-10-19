import type { EffectiveLaunchConfig } from '@autopod/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCompletionFixture } from '../test-utils/completion-helpers.js';
import { createCompletionWorkflow } from './completion-workflow.js';
import { createGoalRepository } from './goal-repository.js';
const fixtures: ReturnType<typeof createCompletionFixture>[] = [];
function fixture(disk = false) {
  const f = createCompletionFixture(disk);
  fixtures.push(f);
  return f;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const f of fixtures.splice(0).reverse()) f.close();
});

describe('completion entry', () => {
  it.each([
    'complete',
    'killed',
    'killing',
    'paused',
    'validating',
    'validated',
    'failed',
    'review_required',
  ] as const)('returns before source work for %s', async (status) => {
    const f = fixture();
    f.podRepo.update('prepare', { status });
    const source = vi.spyOn(f.workflowCaptured, 'prepareSourceForCompletion');
    await f.workflow().handleCompletion.call(f.calls, 'prepare');
    expect(source).not.toHaveBeenCalled();
    expect(f.calls.triggerValidation).not.toHaveBeenCalled();
  });
  it('keeps an unanswered human question ahead of source and output decisions', async () => {
    const f = fixture();
    f.running();
    f.podRepo.update('prepare', {
      status: 'awaiting_input',
      pendingEscalation: {
        id: 'question',
        podId: 'prepare',
        type: 'ask_human',
        timestamp: new Date().toISOString(),
        payload: { question: 'Continue?' },
        response: null,
      },
    });
    await f.workflow().handleCompletion.call(f.calls, 'prepare');
    expect(f.pod().status).toBe('awaiting_input');
    expect(f.pod().pendingEscalation?.id).toBe('question');
    expect(f.captured.preservePodWorkspace).toHaveBeenCalledOnce();
    expect(f.worktreeManager.getDiffStats).not.toHaveBeenCalled();
    expect(f.captured.cleanupContainer).not.toHaveBeenCalled();
  });
  it('returns without applying a decision when source proof is unavailable', async () => {
    const f = fixture();
    f.running();
    vi.spyOn(f.workflowCaptured, 'prepareSourceForCompletion').mockResolvedValueOnce(undefined);
    const decide = vi.spyOn(f.workflowCaptured, 'applyCompletionDecision');
    await f.workflow().handleCompletion.call(f.calls, 'prepare');
    expect(decide).not.toHaveBeenCalled();
  });
  it('coalesces the same artifact cycle and clears only its matching promise', async () => {
    const f = fixture();
    f.running();
    f.podRepo.update('prepare', { options: { ...f.pod().options, output: 'artifact' } });
    let finish: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    f.workflowCaptured.finalizeArtifactPod.mockReturnValueOnce(pending);
    const owner = f.workflow();
    const first = owner.handleCompletion.call(f.calls, 'prepare');
    const second = owner.handleCompletion.call(f.calls, 'prepare');
    await Promise.resolve();
    expect(f.workflowCaptured.finalizeArtifactPod).toHaveBeenCalledOnce();
    expect(f.workflowCaptured.artifactCompletionRuns.size).toBe(1);
    const key = [...f.workflowCaptured.artifactCompletionRuns.keys()][0];
    if (!key) throw new Error('Missing artifact key');
    const replacement = Promise.resolve();
    f.workflowCaptured.artifactCompletionRuns.set(key, replacement);
    finish();
    await Promise.all([first, second]);
    expect(f.workflowCaptured.artifactCompletionRuns.get(key)).toBe(replacement);
    expect(f.calls.triggerValidation).not.toHaveBeenCalled();
  });
  it('rethrows artifact rejection by identity and removes its own map entry', async () => {
    const f = fixture();
    f.running();
    f.podRepo.update('prepare', { options: { ...f.pod().options, output: 'artifact' } });
    const failure = new Error('Synthetic artifact transport failure');
    f.workflowCaptured.finalizeArtifactPod.mockRejectedValueOnce(failure);
    await expect(f.workflow().handleCompletion.call(f.calls, 'prepare')).rejects.toBe(failure);
    expect(f.workflowCaptured.artifactCompletionRuns.size).toBe(0);
  });
});

describe('completion Goal and artifact boundaries', () => {
  it.each([
    { state: 'achieved', stopped: 0, allowed: false },
    { state: 'achieved', stopped: 1, allowed: true },
    { state: 'failed', stopped: 1, allowed: false },
  ])(
    'requires persisted Goal achievement and confirmed stop: $state/$stopped',
    async ({ state, stopped, allowed }) => {
      const f = fixture();
      f.running();
      const goals = createGoalRepository(f.db);
      goals.create('prepare', 'Synthetic native objective', 'claude');
      f.db
        .prepare('UPDATE pod_goals SET state=?, execution_stopped=? WHERE pod_id=?')
        .run(state, stopped, 'prepare');
      // This controlled launch callback supplies only the intent read by this entry.
      const intent = { intent: 'goal' } as EffectiveLaunchConfig;
      const owner = createCompletionWorkflow(
        { launchConfiguration: { read: () => intent, goals } },
        f.workflowCaptured,
      );
      if (allowed) {
        await owner.handleCompletion.call(f.calls, 'prepare');
        expect(f.calls.triggerValidation).toHaveBeenCalledExactlyOnceWith('prepare');
      } else {
        await expect(owner.handleCompletion.call(f.calls, 'prepare')).rejects.toMatchObject({
          code: 'GOAL_NOT_ACHIEVED',
        });
        expect(f.worktreeManager.getDiffStats).not.toHaveBeenCalled();
        expect(f.calls.triggerValidation).not.toHaveBeenCalled();
      }
    },
  );
  it('does not coalesce separate artifact generations or clear unrelated entries', async () => {
    const f = fixture();
    f.running();
    f.podRepo.update('prepare', { options: { ...f.pod().options, output: 'artifact' } });
    let finish: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    f.workflowCaptured.finalizeArtifactPod.mockReturnValue(pending);
    const unrelated = Promise.resolve();
    f.workflowCaptured.artifactCompletionRuns.set('unrelated', unrelated);
    const owner = f.workflow();
    const first = owner.handleCompletion.call(f.calls, 'prepare');
    f.podRepo.incrementLifecycleGeneration('prepare');
    const second = owner.handleCompletion.call(f.calls, 'prepare');
    await Promise.resolve();
    expect(f.workflowCaptured.finalizeArtifactPod).toHaveBeenCalledTimes(2);
    expect(f.workflowCaptured.artifactCompletionRuns.size).toBe(3);
    finish();
    await Promise.all([first, second]);
    expect([...f.workflowCaptured.artifactCompletionRuns.entries()]).toEqual([
      ['unrelated', unrelated],
    ]);
  });
});
