import type Database from 'better-sqlite3';
import { subscribeLocalRun } from '../managed/local-run-signals.js';
import type { OrchestrationContinuations } from './continuations.js';
import { ControllerPassFailure } from './controller-turns.js';

type Pass = ReturnType<OrchestrationContinuations['recover']>;

// A hint during an awaited operation requests one trailing pass on this lane.
function lane(pass: () => Promise<void>) {
  let dirty = false,
    closed = false,
    active: Promise<void> | undefined;
  let failure: { error: unknown } | undefined;
  return {
    enqueue() {
      if (closed) return;
      dirty = true;
      active ??= Promise.resolve().then(async () => {
        try {
          while (dirty && !closed) {
            dirty = false;
            try {
              await pass();
              failure = undefined;
            } catch (error) {
              failure = { error };
            }
          }
        } finally {
          active = undefined;
        }
      });
    },
    stop() {
      closed = true;
    },
    get active() {
      return active;
    },
    get failure() {
      return failure;
    },
  };
}
/** Subscribe before catch-up. Only one pass per lane; no timer, overlap of two model
 * calls, or concurrent recovery passes. Observing a ready report never waits for Azure
 * allocation when the optional independent planner is used. */
export function attachLocalController(
  db: Database.Database,
  run: string,
  recover: () => Pass,
  plan?: () => Promise<void>,
) {
  let outcome: Awaited<Pass> = { blocked: [] };
  const execution = lane(async () => {
    try {
      outcome = await recover();
    } catch (error) {
      if (error instanceof ControllerPassFailure) outcome = error.recovery;
      throw error;
    }
  });
  const planner = plan ? lane(plan) : undefined;
  const enqueue = () => {
    planner?.enqueue();
    execution.enqueue();
  };
  const detach = subscribeLocalRun(db, `native.${run}`, enqueue);
  enqueue();
  const failure = () => planner?.failure ?? execution.failure;
  const join = async () => {
    while (planner?.active || execution.active)
      await Promise.all([planner?.active, execution.active]);
  };
  return {
    status() {
      const err = failure()?.error;
      const reason = err instanceof Error ? err.message : '';
      return {
        planning: failure() ? 'blocked' : (planner ?? execution).active ? 'active' : 'idle',
        ...(failure()
          ? {
              reason: /^(?:controller-[a-z-]{1,64}|controller-provider-http-[3-5][0-9]{2})$/.test(
                reason,
              )
                ? reason
                : 'controller-pass-failed',
            }
          : {}),
        blocked: outcome.blocked,
      };
    },
    async settled() {
      await join();
      const f = failure();
      if (f) throw f.error;
      return outcome;
    },
    async close() {
      detach();
      planner?.stop();
      execution.stop();
      await join();
    },
  };
}
