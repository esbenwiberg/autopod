export type GoalState =
  | 'active'
  | 'paused'
  | 'achieved'
  | 'blocked'
  | 'budget-exhausted'
  | 'cancelled'
  | 'failed';
export type GoalControlIntent = 'pause' | 'resume' | 'cancel';
export interface GoalAttemptFence {
  generation: number;
  attemptId: string;
}
/** Backend-issued identity captured durably before a native process can start. */
export interface NativeGoalProcessIdentity {
  backend: 'docker';
  containerId: string;
  execId: string;
  pidPath: string;
}
export interface NativeGoalProcessHooks {
  /** Must persist synchronously before the backend start request. Throwing refuses execution. */
  processCreated(identity: NativeGoalProcessIdentity): void;
  processStarted(identity: NativeGoalProcessIdentity): void;
}
export interface PodGoal {
  podId: string;
  objective: string;
  state: GoalState;
  revision: number;
  runtime: 'codex' | 'claude';
  fence: GoalAttemptFence | null;
  nativeSessionId: string | null;
  nativeStatus: string | null;
  executionStopped: boolean;
  controlIntent: GoalControlIntent | null;
  observedTokens: number;
  observedSeconds: number;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
}
/** Observed provider lifecycle, never inferred from assistant prose or a clean process exit. */
export interface NativeGoalObservation {
  nativeSessionId: string;
  objective: string;
  state: Exclude<GoalState, 'cancelled'>;
  nativeStatus: string;
  sequence: number;
  cumulativeTokens: number;
  cumulativeSeconds: number;
  reason?: string;
}

/** One native session in a pod-owned process. Implementations must not emulate continuation. */
export interface NativeGoalSession {
  readonly runtime: 'codex' | 'claude';
  open(sessionId: string | null): Promise<string>;
  get(): Promise<NativeGoalObservation | null>;
  start(objective: string, remainingTokens: number | null): Promise<NativeGoalObservation>;
  resume(remainingTokens: number | null): Promise<NativeGoalObservation>;
  pause(): Promise<NativeGoalObservation>;
  clear(): Promise<void>;
  /** Resolves only after process termination is confirmed. */
  stop(): Promise<void>;
  observations(): AsyncIterable<NativeGoalObservation>;
}
