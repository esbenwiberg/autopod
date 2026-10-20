import { describe, expect, it } from 'vitest';
import { codexGoalRolloutPath, codexGoalRolloutTokens } from './codex-goal-usage.js';

const meta = JSON.stringify({ type: 'session_meta', payload: { id: 'native' } });
const usage = (total: number) =>
  JSON.stringify({
    type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: { total_tokens: total } } },
  });

describe('durable native Goal full-thread usage', () => {
  it('counts cached input and the final response from the captured live request totals', () => {
    // Real 0.160.1 canary: the Goal ended at 21,886 while the complete rollout reached 75,330.
    const rollout = [meta, ...[13230, 27955, 42784, 59006, 75330].map(usage), ''].join('\n');
    expect(codexGoalRolloutTokens(rollout, 'native')).toBe(75330);
    expect(codexGoalRolloutTokens(rollout, 'native')).toBe(75330);
  });
  it('ignores an unfinished append while retaining the last complete cumulative counter', () => {
    expect(codexGoalRolloutTokens(`${meta}\n${usage(13230)}\n{"type":`, 'native')).toBe(13230);
  });
  it('rejects another session, missing identity, counter resets and malformed complete frames', () => {
    expect(() => codexGoalRolloutTokens(`${meta}\n${usage(20)}`, 'other')).toThrow(
      'SESSION_MISMATCH',
    );
    expect(() => codexGoalRolloutTokens(usage(20), 'native')).toThrow('SESSION_MISMATCH');
    expect(() => codexGoalRolloutTokens(`${meta}\n${usage(20)}\n${usage(1)}\n`, 'native')).toThrow(
      'USAGE_RESET_UNCONFIRMED',
    );
    expect(() => codexGoalRolloutTokens(`${meta}\ninvalid\n`, 'native')).toThrow(
      'USAGE_ROLLOUT_INVALID',
    );
  });
  it('restricts container reads to native session rollout files', () => {
    const path = '/home/autopod/.codex/sessions/2026/10/20/rollout-native.jsonl';
    expect(codexGoalRolloutPath(path)).toBe(path);
    for (const invalid of [
      '/home/autopod/.codex/auth.json',
      '/home/autopod/.codex/sessions/../../auth.json',
      '/workspace/rollout-native.jsonl',
      '/home/autopod/.codex/sessions/2026/10/20/rollout-../auth.json',
    ])
      expect(() => codexGoalRolloutPath(invalid)).toThrow('USAGE_ROLLOUT_PATH_INVALID');
  });
});
