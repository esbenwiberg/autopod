import { describe, expect, it } from 'vitest';
import { createTestDb, insertTestProfile } from '../test-utils/mock-helpers.js';
import { isAgentStageInterrupted } from './agent-stage-interruption.js';
import { createPodRepository } from './pod-repository.js';

function fixture() {
  const db = createTestDb();
  insertTestProfile(db);
  const pods = createPodRepository(db);
  pods.insert({
    id: 'stage',
    profileName: 'test-profile',
    task: 'Task',
    status: 'failed',
    runtime: 'claude',
    model: 'opus',
    executionTarget: 'local',
    branch: 'branch',
    userId: 'operator',
    maxValidationAttempts: 3,
    skipValidation: false,
    outputMode: 'pr',
  });
  const pod = () => pods.getOrThrow('stage');
  const run = (outcome: 'completed' | 'failed' | 'paused' | 'stopped' | null) => {
    pods.completionJournal?.begin(pod());
    const cycle = pods.completionJournal?.get('stage', pod().lifecycleGeneration)?.cycle ?? 1;
    const id = pods.taskExecutions?.beginRun('stage', pod().lifecycleGeneration, cycle, {
      runtime: 'claude',
      model: 'opus',
      providerAccountId: null,
    });
    if (!id) throw new Error('Missing run ledger');
    if (outcome)
      pods.taskExecutions?.finishRun(id, outcome, outcome === 'failed' ? 'unknown' : null);
  };
  return { pods, pod, run };
}

describe('isAgentStageInterrupted (#670)', () => {
  it('is false without any recorded worker run', () => {
    const f = fixture();
    expect(isAgentStageInterrupted(f.pods, f.pod())).toBe(false);
  });
  it.each([
    'failed',
    'paused',
    'stopped',
  ] as const)('is true after a %s run that never reached validation', (outcome) => {
    const f = fixture();
    f.run(outcome);
    expect(isAgentStageInterrupted(f.pods, f.pod())).toBe(true);
    expect(f.pods.taskExecutions?.latestRun?.('stage', f.pod().lifecycleGeneration)).toMatchObject({
      outcome,
      cycle: 1,
    });
  });
  it('is false for a completed run, an unsettled run, or a lifecycle that reached validation', () => {
    const completed = fixture();
    completed.run('completed');
    expect(isAgentStageInterrupted(completed.pods, completed.pod())).toBe(false);
    const unsettled = fixture();
    unsettled.run(null);
    expect(isAgentStageInterrupted(unsettled.pods, unsettled.pod())).toBe(false);
    const validated = fixture();
    validated.run('failed');
    validated.pods.completionJournal?.mark(validated.pod(), 'finalizing');
    expect(isAgentStageInterrupted(validated.pods, validated.pod())).toBe(false);
  });
  it('is false unless the pod is failed', () => {
    const f = fixture();
    f.run('failed');
    f.pods.update('stage', { status: 'review_required' });
    expect(isAgentStageInterrupted(f.pods, f.pod())).toBe(false);
  });
});
