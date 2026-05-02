/**
 * Per-key sequential promise queue.
 *
 * `run(key, fn)` calls with the same `key` are serialized; calls with
 * different keys run independently. The slot for a key is removed once its
 * tail task drains, so the Map size tracks "currently active" rather than
 * leaking forever.
 *
 * This is the shared primitive behind {@link MergeQueue} (per `repo+base`
 * merge serialization) and {@link LocalWorktreeManager} (per-bare-repo git
 * lock contention avoidance). They use different keys but the same algorithm.
 *
 * In-process only — the daemon is single-process today. If that ever changes
 * this needs to grow into a row in SQLite or similar.
 */
export class KeyedPromiseQueue {
  private locks = new Map<string, Promise<unknown>>();

  /**
   * Run `fn` while holding the lock for `key`. If `fn` throws, the rejection
   * propagates to the caller but the queue still advances — a failure on one
   * task must never block subsequent tasks on the same key.
   */
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.locks.get(key) ?? Promise.resolve();
    const next: Promise<T> = existing.then(fn, fn);
    this.locks.set(key, next);
    try {
      return await next;
    } finally {
      // Only clear the slot if we're still the head — a later run() may have
      // already chained on top of `next` and we mustn't drop their lock.
      if (this.locks.get(key) === next) {
        this.locks.delete(key);
      }
    }
  }

  /** Test/observability hook: how many keys currently have a queued task. */
  size(): number {
    return this.locks.size;
  }
}
