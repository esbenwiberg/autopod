import type { GoalAttemptFence, NativeGoalObservation, PodGoal } from '@autopod/shared';
import { configurationError } from '../configuration/configuration-store.js';
import type { NativeGoalSession } from '../interfaces/native-goal.js';
import type { GoalRepository } from './goal-repository.js';

export interface GoalControllerHooks {
  /** Synchronous lifecycle/attempt ownership guard, including cancellation and account revocation. */
  assertCurrent(podId: string, fence: GoalAttemptFence): void;
  /** Persist cumulative usage in the whole-pod ledger and return the remaining allowance. */
  account(goal: PodGoal): number | null;
  publish(goal: PodGoal): void;
  confirmProcessStopped?(podId: string, fence: GoalAttemptFence): void;
}
interface Active {
  fence: GoalAttemptFence;
  session: NativeGoalSession;
  control?: Promise<void>;
}

/** Native goal achievement is one input to validation; this controller never publishes source. */
export class GoalController {
  private readonly active = new Map<string, Active>();
  constructor(
    private readonly repository: GoalRepository,
    private readonly hooks: GoalControllerHooks,
  ) {}

  async run(
    podId: string,
    revision: number,
    fence: GoalAttemptFence,
    session: NativeGoalSession,
  ): Promise<PodGoal> {
    if (this.active.has(podId))
      configurationError('Native goal is already executing', 'GOAL_ALREADY_RUNNING', 409);
    this.hooks.assertCurrent(podId, fence);
    const allowance = this.hooks.account(this.read(podId));
    if (allowance !== null && allowance <= 0)
      configurationError('Whole-pod token budget is exhausted', 'GOAL_BUDGET_EXHAUSTED', 409);
    const initial = this.repository.beginAttempt(
      podId,
      revision,
      fence,
      session.runtime,
      session.runtime === 'claude' ? 'reset' : 'preserved',
    );
    const execution: Active = { fence, session };
    this.active.set(podId, execution);
    let stopped = false;
    let budgetExhausted = false;
    try {
      const sessionId = await session.open(initial.nativeSessionId);
      this.check(podId, execution);
      this.repository.bindSession(podId, fence, sessionId);
      const previous = await session.get();
      this.check(podId, execution);
      if (initial.nativeSessionId && !previous)
        configurationError(
          'Saved native goal is missing; automatic replacement is disabled',
          'GOAL_RECONCILIATION_REQUIRED',
          409,
        );
      if (!initial.nativeSessionId && previous)
        configurationError(
          'New native session unexpectedly contains a goal',
          'GOAL_SESSION_MISMATCH',
          409,
        );
      if (previous) this.observe(podId, execution, previous);
      let current = this.read(podId);
      let remaining = this.hooks.account(current);
      if (current.state !== 'achieved' && remaining !== null && remaining <= 0) {
        budgetExhausted = true;
        configurationError('Whole-pod token budget is exhausted', 'GOAL_BUDGET_EXHAUSTED', 409);
      }
      if (current.state !== 'achieved') {
        const started = initial.nativeSessionId
          ? await session.resume(remaining)
          : await session.start(initial.objective, remaining);
        this.observe(podId, execution, started);
        current = this.read(podId);
      }
      if (current.state === 'active') {
        for await (const observation of session.observations()) {
          this.observe(podId, execution, observation);
          current = this.read(podId);
          remaining = this.hooks.account(current);
          budgetExhausted = remaining !== null && remaining <= 0;
          if (
            current.controlIntent ||
            current.state !== 'active' ||
            (remaining !== null && remaining <= 0)
          )
            break;
        }
      }
      if (execution.control) await execution.control;
      else {
        current = this.read(podId);
        if (current.state === 'active') {
          // A clean stream end is neither native achievement nor confirmed cancellation.
          this.repository.attention(
            podId,
            fence,
            'Native execution ended without a terminal Goal observation',
          );
          this.observe(podId, execution, await session.pause());
        }
        await session.stop();
        this.hooks.confirmProcessStopped?.(podId, fence);
        this.repository.confirmStopped(podId, fence);
      }
      if (budgetExhausted) this.repository.exhausted(podId, fence);
      stopped = true;
    } catch (error) {
      // Never retry an uncertain start/resume/clear. A later attempt must reconcile persisted state.
      this.repository.attention(podId, fence, 'Native Goal needs reconciliation before continuing');
      try {
        await session.stop();
        this.hooks.confirmProcessStopped?.(podId, fence);
        this.repository.confirmStopped(podId, fence);
        if (budgetExhausted) this.repository.exhausted(podId, fence);
        stopped = true;
      } catch {
        this.repository.attention(
          podId,
          fence,
          'Native process termination is unconfirmed; resume is blocked',
        );
      }
      throw error;
    } finally {
      // Retain an uncertain active handle so controls can retry termination, never start another process.
      if (stopped) this.active.delete(podId);
      this.hooks.publish(this.read(podId));
    }
    return this.read(podId);
  }

  async control(podId: string, revision: number, intent: 'pause' | 'cancel'): Promise<PodGoal> {
    const pending = this.repository.requestControl(podId, revision, intent);
    this.hooks.publish(pending);
    const execution = this.active.get(podId);
    if (!execution) {
      if (pending.executionStopped) {
        const stopped = this.repository.confirmIdleControl(podId);
        this.hooks.publish(stopped);
        return stopped;
      }
      // A daemon restart must reconcile/terminate the recorded native process first.
      configurationError(
        'Native execution must be reconciled before control is confirmed',
        'GOAL_RECONCILIATION_REQUIRED',
        409,
      );
    }
    if (!execution.control) {
      execution.control = (async () => {
        try {
          const latest = await execution.session.get();
          if (latest) this.repository.observe(podId, execution.fence, latest);
          const current = this.read(podId);
          if (!['achieved', 'cancelled', 'failed'].includes(current.state)) {
            if (current.controlIntent === 'cancel') await execution.session.clear();
            else this.repository.observe(podId, execution.fence, await execution.session.pause());
          }
        } finally {
          // Even a rejected native mutation must stop compute; unconfirmed exit preserves the intent.
          await execution.session.stop();
          this.hooks.confirmProcessStopped?.(podId, execution.fence);
          this.repository.confirmStopped(podId, execution.fence);
          this.active.delete(podId);
        }
      })();
    }
    try {
      await execution.control;
    } finally {
      // A failed stop can be explicitly retried against the same handle; never cache a rejected control forever.
      if (this.active.get(podId) === execution) execution.control = undefined;
    }
    const current = this.read(podId);
    this.hooks.account(current);
    this.hooks.publish(current);
    return current;
  }

  private read(podId: string): PodGoal {
    const goal = this.repository.get(podId);
    if (!goal) configurationError('Pod goal is unavailable', 'GOAL_NOT_FOUND', 404);
    return goal;
  }
  private check(podId: string, execution: Active): void {
    this.hooks.assertCurrent(podId, execution.fence);
    const current = this.read(podId);
    if (current.controlIntent || current.executionStopped)
      configurationError(
        'Native Goal control changed before dispatch',
        'GOAL_CONTROL_PENDING',
        409,
      );
  }
  private observe(podId: string, execution: Active, observation: NativeGoalObservation): void {
    this.hooks.assertCurrent(podId, execution.fence);
    const current = this.repository.observe(podId, execution.fence, observation);
    this.hooks.account(current);
    this.hooks.publish(current);
  }
}
