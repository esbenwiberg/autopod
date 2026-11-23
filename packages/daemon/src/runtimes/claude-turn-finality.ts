import type { ClaudeStreamEvent } from './claude-stream-parser.js';

const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'killed', 'stopped']);

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Pending non-ambient background work of one Claude CLI process, derived from
 * its stream-json task lifecycle frames:
 *
 * - `system/task_started` / `task_notification` edge bookends,
 * - `system/task_updated` (a foreground command moved to the background, or a
 *   terminal status),
 * - `system/background_tasks_changed`, the authoritative level signal (full set,
 *   REPLACE semantics, empty at process start).
 *
 * Ambient/housekeeping tasks (`ambient`, `skip_transcript`) are not agent work
 * and never count as pending. CLIs that emit none of these frames leave the set
 * empty, which preserves the pre-#648 behaviour.
 */
export class ClaudeBackgroundTasks {
  private readonly pending = new Set<string>();
  private readonly ambient = new Set<string>();

  get size(): number {
    return this.pending.size;
  }

  /** Returns true when the pending set changed. */
  observe(raw: ClaudeStreamEvent): boolean {
    if (!isObject(raw) || raw.type !== 'system') return false;
    const before = this.key();
    switch (raw.subtype) {
      case 'task_started': {
        const id = stringField(raw.task_id);
        if (!id) break;
        if (raw.ambient === true || raw.skip_transcript === true) {
          this.ambient.add(id);
          break;
        }
        // A foreground task blocks its tool call; it only becomes pending work
        // once `task_updated` reports it moved to the background.
        if (raw.is_backgrounded !== false) this.pending.add(id);
        break;
      }
      case 'task_updated': {
        const id = stringField(raw.task_id);
        const patch = raw.patch;
        if (!id || !isObject(patch)) break;
        if (typeof patch.status === 'string' && TERMINAL_TASK_STATUSES.has(patch.status)) {
          this.pending.delete(id);
          break;
        }
        if (patch.is_backgrounded === true && !this.ambient.has(id)) this.pending.add(id);
        break;
      }
      case 'task_notification': {
        const id = stringField(raw.task_id);
        if (!id) break;
        this.pending.delete(id);
        break;
      }
      case 'background_tasks_changed': {
        if (!Array.isArray(raw.tasks)) break;
        this.pending.clear();
        for (const task of raw.tasks) {
          if (!isObject(task)) continue;
          const id = stringField(task.task_id);
          if (!id) continue;
          if (task.ambient === true || this.ambient.has(id)) continue;
          this.pending.add(id);
        }
        break;
      }
      default:
        return false;
    }
    return this.key() !== before;
  }

  private key(): string {
    return [...this.pending].sort().join('\u0000');
  }
}
