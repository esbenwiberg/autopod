import { describe, expect, it } from 'vitest';
import {
  createAgentExecutionFixture,
  syntheticComplete,
} from '../test-utils/agent-execution-helpers.js';
import {
  agentCompleteEventKey,
  agentPhaseBucketKey,
  deriveAgentAttempt,
  hasAlreadyCountedCompleteEvent,
  hasLatestPersistedAgentTerminalEventComplete,
  persistedAgentCompleteEventKeys,
} from './agent-execution-policy.js';
describe('agent execution accounting policy', () => {
  it.each([
    { usage: null, expected: 0 },
    { usage: { agent_initial: { inputTokens: 1, outputTokens: 0 } }, expected: 1 },
    {
      usage: {
        agent_initial: { inputTokens: 1, outputTokens: 0 },
        agent_rework_3: { inputTokens: 1, outputTokens: 0 },
      },
      expected: 4,
    },
  ])('derives the original phase sequence $expected', ({ usage, expected }) => {
    expect(deriveAgentAttempt(usage)).toBe(expected);
    expect(agentPhaseBucketKey(expected)).toBe(
      expected === 0 ? 'agent_initial' : `agent_rework_${expected}`,
    );
  });
  it('hashes every completion accounting field consistently', () => {
    const key = agentCompleteEventKey(syntheticComplete);
    expect(agentCompleteEventKey({ ...syntheticComplete })).toBe(key);
    for (const event of [
      { ...syntheticComplete, result: 'changed' },
      { ...syntheticComplete, cachedInputTokens: 1 },
      { ...syntheticComplete, cacheCreationInputTokens: 1 },
      { ...syntheticComplete, costUsd: 2 },
    ])
      expect(agentCompleteEventKey(event)).not.toBe(key);
  });
  it('reads persisted terminal order, watermark and replay hashes from actual SQLite events', () => {
    const f = createAgentExecutionFixture();
    try {
      expect(hasLatestPersistedAgentTerminalEventComplete(undefined, 'prepare')).toBe(false);
      f.deps.eventBus.emit({
        type: 'pod.agent_activity',
        timestamp: syntheticComplete.timestamp,
        podId: 'prepare',
        event: syntheticComplete,
      });
      expect(hasLatestPersistedAgentTerminalEventComplete(f.deps.eventRepo, 'prepare')).toBe(true);
      const rows = f.deps.eventRepo.getForSession('prepare');
      expect(
        hasLatestPersistedAgentTerminalEventComplete(f.deps.eventRepo, 'prepare', rows.at(-1)?.id),
      ).toBe(false);
      expect(persistedAgentCompleteEventKeys(f.deps.eventRepo, 'prepare')).toEqual(
        new Set([agentCompleteEventKey(syntheticComplete)]),
      );
      f.deps.eventBus.emit({
        type: 'pod.agent_activity',
        timestamp: syntheticComplete.timestamp,
        podId: 'prepare',
        event: {
          type: 'error',
          timestamp: syntheticComplete.timestamp,
          message: 'Synthetic fatal',
          fatal: true,
        },
      });
      expect(hasLatestPersistedAgentTerminalEventComplete(f.deps.eventRepo, 'prepare')).toBe(false);
    } finally {
      f.close();
    }
  });
  it('requires the existing phase bucket and cost to cover the replay telemetry', () => {
    const f = createAgentExecutionFixture();
    try {
      expect(hasAlreadyCountedCompleteEvent(f.pod(), 0, syntheticComplete)).toBe(false);
      f.podRepo.update('prepare', {
        phaseTokenUsage: { agent_initial: { inputTokens: 2, outputTokens: 3 } },
        costUsd: 0.01,
      });
      expect(hasAlreadyCountedCompleteEvent(f.pod(), 0, syntheticComplete)).toBe(true);
      expect(hasAlreadyCountedCompleteEvent(f.pod(), 1, syntheticComplete)).toBe(false);
    } finally {
      f.close();
    }
  });
});
