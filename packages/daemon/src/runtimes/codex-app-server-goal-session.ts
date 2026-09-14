import type { NativeGoalObservation } from '@autopod/shared';
import { z } from 'zod';
import type { NativeGoalSession } from '../interfaces/native-goal.js';
import { type CodexAppServerClient, CodexRpcError } from './codex-app-server-client.js';
import {
  type CodexNativeGoal,
  codexGoalObservation,
  codexNativeGoalSchema,
} from './codex-native-goal.js';

const responseSchema = z.object({ goal: codexNativeGoalSchema.nullable() });
export interface CodexGoalThreadConfig {
  model: string;
  cwd: string;
  developerInstructions: string;
}

/** Native APIs only. Version/backend capability proof is required before constructing for a pod. */
export class CodexAppServerGoalSession implements NativeGoalSession {
  readonly runtime = 'codex' as const;
  private threadId: string | null = null;
  private sequence = 0;
  private latest: CodexNativeGoal | null = null;
  private inspectionOnly = false;
  constructor(
    private readonly client: Pick<CodexAppServerClient, 'request' | 'notify' | 'events' | 'close'>,
    private readonly config: CodexGoalThreadConfig,
  ) {}

  /** Binds stored Goal state without loading a thread or permitting continuation. */
  async openInspection(sessionId: string): Promise<void> {
    if (this.threadId || !sessionId) throw new CodexRpcError('SESSION_ALREADY_OPEN');
    this.inspectionOnly = true;
    await this.client.request('initialize', {
      clientInfo: { name: 'autopod-goal-recovery', version: '1' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    await this.client.notify('initialized');
    this.threadId = sessionId;
  }

  async open(sessionId: string | null): Promise<string> {
    if (this.threadId) throw new CodexRpcError('SESSION_ALREADY_OPEN');
    await this.client.request('initialize', {
      clientInfo: { name: 'autopod', version: '1' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    await this.client.notify('initialized');
    if (sessionId) {
      // Native resume restores active Goals and may start an idle turn immediately.
      // Read and pause the unloaded persisted Goal before loading the thread. These
      // native APIs retain counters and do not require a running thread. Failure
      // must leave resume unissued; the controller will terminate this app-server.
      this.threadId = sessionId;
      const saved = await this.get();
      if (!saved) throw new CodexRpcError('GOAL_RECONCILIATION_REQUIRED');
      if (saved.nativeStatus === 'active') {
        const paused = await this.pause();
        if (paused.nativeStatus !== 'paused') throw new CodexRpcError('GOAL_PAUSE_UNCONFIRMED');
      }
    }
    const params = {
      model: this.config.model,
      allowProviderModelFallback: false,
      cwd: this.config.cwd,
      developerInstructions: this.config.developerInstructions,
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      ...(sessionId ? { threadId: sessionId } : { ephemeral: false }),
    };
    const response = z
      .object({ thread: z.object({ id: z.string().min(1) }) })
      .parse(await this.client.request(sessionId ? 'thread/resume' : 'thread/start', params));
    if (sessionId && response.thread.id !== sessionId) throw new CodexRpcError('SESSION_MISMATCH');
    this.threadId = response.thread.id;
    return this.threadId;
  }
  async get(): Promise<NativeGoalObservation | null> {
    const { goal } = responseSchema.parse(
      await this.client.request('thread/goal/get', { threadId: this.id() }),
    );
    return goal ? this.accept(goal) : null;
  }
  async start(objective: string, remainingTokens: number | null): Promise<NativeGoalObservation> {
    if (this.inspectionOnly) throw new CodexRpcError('INSPECTION_ONLY');
    if (this.latest) throw new CodexRpcError('GOAL_REPLACEMENT_DISABLED');
    return this.set({ objective, status: 'active', tokenBudget: this.budget(remainingTokens, 0) });
  }
  async resume(remainingTokens: number | null): Promise<NativeGoalObservation> {
    if (this.inspectionOnly) throw new CodexRpcError('INSPECTION_ONLY');
    if (!this.latest) throw new CodexRpcError('GOAL_RECONCILIATION_REQUIRED');
    if (this.latest.status === 'complete') throw new CodexRpcError('GOAL_TERMINAL');
    // Omitting objective preserves native counters; the daemon's remaining allowance is additional.
    return this.set({
      status: 'active',
      tokenBudget: this.budget(remainingTokens, this.latest.tokensUsed),
    });
  }
  async pause(): Promise<NativeGoalObservation> {
    return this.set({ status: 'paused' });
  }
  async clear(): Promise<void> {
    const response = z
      .object({ cleared: z.boolean() })
      .parse(await this.client.request('thread/goal/clear', { threadId: this.id() }));
    if (!response.cleared && (await this.get())) throw new CodexRpcError('GOAL_CLEAR_UNCONFIRMED');
  }
  stop(): Promise<void> {
    return this.client.close();
  }
  async *observations(): AsyncIterable<NativeGoalObservation> {
    for await (const notification of this.client.events()) {
      if (notification.method === 'thread/goal/updated') {
        const params = z
          .object({ threadId: z.string(), goal: codexNativeGoalSchema })
          .parse(notification.params);
        if (params.threadId !== this.id()) throw new CodexRpcError('SESSION_MISMATCH');
        if (
          this.latest &&
          params.goal.updatedAt === this.latest.updatedAt &&
          params.goal.tokensUsed === this.latest.tokensUsed &&
          params.goal.timeUsedSeconds === this.latest.timeUsedSeconds &&
          params.goal.status !== this.latest.status
        ) {
          // Timestamp resolution cannot order a queued notification against a completed mutation.
          const previousStatus = this.latest.status;
          const authoritative = await this.get();
          if (!authoritative) throw new CodexRpcError('GOAL_RECONCILIATION_REQUIRED');
          if (authoritative.nativeStatus !== previousStatus) yield authoritative;
          continue;
        }
        // A request response may have already delivered this queued notification's newer state.
        if (
          this.latest &&
          params.goal.updatedAt <= this.latest.updatedAt &&
          params.goal.tokensUsed <= this.latest.tokensUsed &&
          params.goal.timeUsedSeconds <= this.latest.timeUsedSeconds
        ) {
          if (
            params.goal.updatedAt < this.latest.updatedAt ||
            params.goal.tokensUsed < this.latest.tokensUsed ||
            params.goal.timeUsedSeconds < this.latest.timeUsedSeconds ||
            params.goal.status === this.latest.status
          )
            continue;
        }
        yield this.accept(params.goal);
      } else if (
        notification.method === 'thread/goal/cleared' ||
        notification.method === 'thread/closed'
      ) {
        throw new CodexRpcError('GOAL_RECONCILIATION_REQUIRED');
      }
      // In particular, turn/completed and assistant text never mean goal completion.
    }
  }
  private id(): string {
    if (!this.threadId) throw new CodexRpcError('SESSION_NOT_OPEN');
    return this.threadId;
  }
  private accept(goal: CodexNativeGoal): NativeGoalObservation {
    if (goal.threadId !== this.id() || (this.latest && goal.objective !== this.latest.objective))
      throw new CodexRpcError('SESSION_MISMATCH');
    if (
      this.latest &&
      (goal.tokensUsed < this.latest.tokensUsed ||
        goal.timeUsedSeconds < this.latest.timeUsedSeconds)
    )
      throw new CodexRpcError('USAGE_RESET_UNCONFIRMED');
    this.latest = goal;
    return codexGoalObservation(goal, ++this.sequence);
  }
  private async set(params: Record<string, unknown>): Promise<NativeGoalObservation> {
    const response = responseSchema.parse(
      await this.client.request('thread/goal/set', { threadId: this.id(), ...params }),
    );
    if (!response.goal) throw new CodexRpcError('GOAL_MISSING');
    return this.accept(response.goal);
  }
  private budget(remaining: number | null, used: number): number | null {
    if (remaining === null) return null;
    if (
      !Number.isSafeInteger(remaining) ||
      remaining <= 0 ||
      !Number.isSafeInteger(used + remaining)
    )
      throw new CodexRpcError('BUDGET_EXHAUSTED');
    return used + remaining;
  }
}
