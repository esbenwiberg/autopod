import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STUCK_RUNNING_THRESHOLD_MS,
  resolveStuckRunningThresholdMs,
} from '../util/stuck-running-threshold.js';
import type { ClaudeStreamEvent } from './claude-stream-parser.js';
import {
  BACKGROUND_WAIT_WATCHDOG_MARGIN_MS,
  ClaudeBackgroundTasks,
  DEFAULT_CLAUDE_BACKGROUND_WAIT_MS,
  describeInterruptedClaudeTurn,
  resolveClaudeBackgroundWaitMs,
} from './claude-turn-finality.js';

const system = (subtype: string, fields: Record<string, unknown> = {}): ClaudeStreamEvent => ({
  type: 'system',
  subtype,
  ...fields,
});

describe('ClaudeBackgroundTasks', () => {
  it('tracks started/notification bookends for backgrounded tasks', () => {
    const tasks = new ClaudeBackgroundTasks();
    expect(tasks.observe(system('task_started', { task_id: 'a', is_backgrounded: true }))).toBe(
      true,
    );
    expect(tasks.observe(system('task_started', { task_id: 'b' }))).toBe(true);
    expect(tasks.size).toBe(2);
    expect(tasks.observe(system('task_notification', { task_id: 'a', status: 'completed' }))).toBe(
      true,
    );
    expect(tasks.size).toBe(1);
    expect(tasks.observe(system('task_notification', { task_id: 'a', status: 'completed' }))).toBe(
      false,
    );
  });

  it('excludes ambient and skip_transcript housekeeping tasks', () => {
    const tasks = new ClaudeBackgroundTasks();
    tasks.observe(system('task_started', { task_id: 'watch', ambient: true }));
    tasks.observe(system('task_started', { task_id: 'memo', skip_transcript: true }));
    tasks.observe(system('task_updated', { task_id: 'watch', patch: { is_backgrounded: true } }));
    tasks.observe(
      system('background_tasks_changed', {
        tasks: [
          { task_id: 'watch', task_type: 'monitor' },
          { task_id: 'other', task_type: 'local_bash', ambient: true },
        ],
      }),
    );
    expect(tasks.size).toBe(0);
  });

  it('counts a foreground command only once it moves to the background', () => {
    const tasks = new ClaudeBackgroundTasks();
    tasks.observe(system('task_started', { task_id: 'fg', is_backgrounded: false }));
    expect(tasks.size).toBe(0);
    tasks.observe(system('task_updated', { task_id: 'fg', patch: { is_backgrounded: true } }));
    expect(tasks.size).toBe(1);
    tasks.observe(system('task_updated', { task_id: 'fg', patch: { status: 'killed' } }));
    expect(tasks.size).toBe(0);
  });

  it('replaces the set from the background_tasks_changed level signal', () => {
    const tasks = new ClaudeBackgroundTasks();
    tasks.observe(system('task_started', { task_id: 'stale' }));
    expect(
      tasks.observe(
        system('background_tasks_changed', {
          tasks: [{ task_id: 'x' }, { task_id: 'y' }, 'malformed', { task_id: '' }],
        }),
      ),
    ).toBe(true);
    expect(tasks.size).toBe(2);
    expect(tasks.observe(system('background_tasks_changed', { tasks: [] }))).toBe(true);
    expect(tasks.size).toBe(0);
  });

  it('ignores non-task frames and malformed shapes', () => {
    const tasks = new ClaudeBackgroundTasks();
    expect(tasks.observe({ type: 'assistant' })).toBe(false);
    expect(tasks.observe(system('init'))).toBe(false);
    expect(tasks.observe(system('task_started', {}))).toBe(false);
    expect(tasks.observe(system('task_updated', { task_id: 'a', patch: 'x' }))).toBe(false);
    expect(tasks.observe(system('background_tasks_changed', { tasks: 'x' }))).toBe(false);
    expect(tasks.observe(null as unknown as ClaudeStreamEvent)).toBe(false);
    expect(tasks.size).toBe(0);
  });
});

describe('Claude background wait bounds', () => {
  const MIN = 60_000;

  it('defaults to 25 min, strictly inside the stuck-pod watchdog with settlement headroom', () => {
    expect(DEFAULT_CLAUDE_BACKGROUND_WAIT_MS).toBe(25 * MIN);
    expect(resolveStuckRunningThresholdMs({})).toBe(DEFAULT_STUCK_RUNNING_THRESHOLD_MS);
    expect(resolveClaudeBackgroundWaitMs({})).toBe(25 * MIN);
    // Wait + exit wait + verified kill (≤ ~65 s) must settle before the watchdog fires.
    expect(
      resolveClaudeBackgroundWaitMs({}) + BACKGROUND_WAIT_WATCHDOG_MARGIN_MS,
    ).toBeLessThanOrEqual(resolveStuckRunningThresholdMs({}));
    expect(BACKGROUND_WAIT_WATCHDOG_MARGIN_MS).toBeGreaterThan(65_000);
  });

  it('clamps an override below the configured watchdog threshold', () => {
    expect(
      resolveClaudeBackgroundWaitMs({ AUTOPOD_CLAUDE_BACKGROUND_WAIT_MS: String(60 * MIN) }),
    ).toBe(27 * MIN);
    const env = {
      AUTOPOD_CLAUDE_BACKGROUND_WAIT_MS: String(25 * MIN),
      AUTOPOD_STUCK_RUNNING_THRESHOLD_MS: String(20 * MIN),
    };
    expect(resolveClaudeBackgroundWaitMs(env)).toBe(17 * MIN);
    expect(
      resolveClaudeBackgroundWaitMs(env) + BACKGROUND_WAIT_WATCHDOG_MARGIN_MS,
    ).toBeLessThanOrEqual(resolveStuckRunningThresholdMs(env));
    // A watchdog tighter than the margin disables the wait rather than racing it.
    expect(
      resolveClaudeBackgroundWaitMs({ AUTOPOD_STUCK_RUNNING_THRESHOLD_MS: String(2 * MIN) }),
    ).toBe(0);
  });

  it('honours a shorter override and ignores malformed values', () => {
    expect(
      resolveClaudeBackgroundWaitMs({ AUTOPOD_CLAUDE_BACKGROUND_WAIT_MS: String(5 * MIN) }),
    ).toBe(5 * MIN);
    expect(resolveClaudeBackgroundWaitMs({ AUTOPOD_CLAUDE_BACKGROUND_WAIT_MS: 'soon' })).toBe(
      25 * MIN,
    );
    expect(resolveStuckRunningThresholdMs({ AUTOPOD_STUCK_RUNNING_THRESHOLD_MS: '-1' })).toBe(
      DEFAULT_STUCK_RUNNING_THRESHOLD_MS,
    );
  });
});

describe('describeInterruptedClaudeTurn', () => {
  it('describes only unfinished turns, with counts and the rework path', () => {
    expect(describeInterruptedClaudeTurn({ kind: 'final' }, 143, 'p1')).toBeNull();
    expect(describeInterruptedClaudeTurn({ kind: 'none' }, 1, 'p1')).toBeNull();
    const message = describeInterruptedClaudeTurn(
      { kind: 'background_pending', pendingTasks: 2, reason: 'cap', waitMs: 25 * 60_000 },
      143,
      'p1',
    );
    expect(message).toContain('2 background tasks were still running');
    expect(message).toContain('within 25 min');
    expect(message).toContain('`ap rework p1`');
    expect(message?.length).toBeLessThan(1_000);
  });
});
