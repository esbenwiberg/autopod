import type Database from 'better-sqlite3';
import { subscribeLocalRun } from '../managed/local-run-signals.js';
import type { OrchestrationContinuations } from './continuations.js';

type Pass = ReturnType<OrchestrationContinuations['recover']>;
/** Single local owner. Subscribe BEFORE catch-up. Edges during a pass request one more pass;
 * no timer, concurrent provider calls, recursive callbacks or wait-for-all. */
export function attachLocalController(db: Database.Database, run: string, pass: () => Pass) {
  let dirty = false,
    closed = false;
  let active: Promise<void> | undefined;
  let outcome: Awaited<Pass> = { blocked: [] };
  let failure: { error: unknown } | undefined;
  function enqueue() {
    if (closed) return;
    dirty = true;
    active ??= Promise.resolve().then(async () => {
      try {
        while (dirty && !closed) {
          dirty = false;
          try {
            outcome = await pass();
            failure = undefined;
          } catch (error) {
            failure = { error };
          }
        }
      } finally {
        active = undefined;
      }
    });
  }
  const detach = subscribeLocalRun(db, `native.${run}`, enqueue);
  enqueue();
  return {
    status() {
      const reason = failure?.error instanceof Error ? failure.error.message : '';
      return {
        planning: failure ? 'blocked' : active ? 'active' : 'idle',
        ...(failure
          ? { reason: /^controller-[a-z-]{1,64}$/.test(reason) ? reason : 'controller-pass-failed' }
          : {}),
        blocked: outcome.blocked,
      };
    },
    /** Join work already signaled; does not request another pass. Surfaces blocked intents or failures. */
    async settled() {
      while (active) await active;
      if (failure) throw failure.error;
      return outcome;
    },
    /** Stop listening and join an in-progress pass. Use the run fence, not close, to revoke authority. */
    async close() {
      closed = true;
      detach();
      await active;
    },
  };
}
