import { describe, expect, it } from 'vitest';
import type { ClaudeStreamEvent } from './claude-stream-parser.js';
import { ClaudeBackgroundTasks } from './claude-turn-finality.js';

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
