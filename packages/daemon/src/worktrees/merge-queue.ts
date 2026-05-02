/**
 * Per-key sequential lock for merge operations.
 *
 * When several pods finish at the same time, allowing them to rebase + push +
 * merge in parallel produces avoidable conflicts: pod A pushes a clean rebase
 * → pod B's "clean" rebase is now stale before its push. Serializing the
 * "rebase + push + merge attempt" critical section on a `repo+baseBranch` key
 * eliminates that race — the next pod always rebases against the freshly-merged
 * base.
 *
 * The lock is in-process only. The daemon is single-process today; if that ever
 * changes, this needs to grow into a row in SQLite.
 */
export class MergeQueue {
  private locks = new Map<string, Promise<unknown>>();

  /**
   * Build the lock key. Two pods conflict only if they target the same base
   * branch on the same repository — different repos and different base
   * branches are independent.
   */
  static keyFor(repoUrl: string | null | undefined, baseBranch: string): string {
    return `${repoUrl ?? '<no-repo>'}::${baseBranch}`;
  }

  /**
   * Run `fn` while holding the lock for `key`. Concurrent calls with the same
   * key serialize; calls with different keys run independently.
   *
   * If `fn` throws, the rejection propagates to the caller but the queue still
   * advances — a failure on pod A must not block pod B forever.
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
