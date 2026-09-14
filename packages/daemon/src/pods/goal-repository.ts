import type {
  GoalAttemptFence,
  GoalControlIntent,
  GoalState,
  NativeGoalObservation,
  PodGoal,
} from '@autopod/shared';
import type Database from 'better-sqlite3';
import { configurationError } from '../configuration/configuration-store.js';

interface Row {
  pod_id: string;
  objective: string;
  state: GoalState;
  revision: number;
  runtime: PodGoal['runtime'];
  generation: number | null;
  attempt_id: string | null;
  native_session_id: string | null;
  native_status: string | null;
  execution_stopped: number;
  control_intent: GoalControlIntent | null;
  last_sequence: number;
  native_tokens_seen: number;
  native_seconds_seen: number;
  observed_tokens: number;
  observed_seconds: number;
  reason: string | null;
  created_at: string;
  updated_at: string;
}
function project(row: Row): PodGoal {
  return {
    podId: row.pod_id,
    objective: row.objective,
    state: row.state,
    revision: row.revision,
    runtime: row.runtime,
    fence:
      row.attempt_id && row.generation !== null
        ? { generation: row.generation, attemptId: row.attempt_id }
        : null,
    nativeSessionId: row.native_session_id,
    nativeStatus: row.native_status,
    executionStopped: !!row.execution_stopped,
    controlIntent: row.control_intent,
    observedTokens: row.observed_tokens,
    observedSeconds: row.observed_seconds,
    reason: row.reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
const terminal = new Set<GoalState>(['achieved', 'cancelled', 'failed']);

export interface GoalRepository {
  get(podId: string): PodGoal | null;
  create(podId: string, objective: string, runtime: PodGoal['runtime']): PodGoal;
  beginAttempt(
    podId: string,
    revision: number,
    fence: GoalAttemptFence,
    runtime: PodGoal['runtime'],
    counterMode?: 'preserved' | 'reset',
  ): PodGoal;
  bindSession(podId: string, fence: GoalAttemptFence, nativeSessionId: string): PodGoal;
  observe(podId: string, fence: GoalAttemptFence, observation: NativeGoalObservation): PodGoal;
  reconcileObservation(
    podId: string,
    fence: GoalAttemptFence,
    observation: NativeGoalObservation,
  ): PodGoal;
  requestControl(podId: string, revision: number, intent: GoalControlIntent): PodGoal;
  confirmIdleControl(podId: string): PodGoal;
  confirmStopped(podId: string, fence: GoalAttemptFence): PodGoal;
  canComplete(podId: string): boolean;
  exhausted(podId: string, fence: GoalAttemptFence): PodGoal;
  attention(podId: string, fence: GoalAttemptFence, reason: string): PodGoal;
}
export function createGoalRepository(db: Database.Database): GoalRepository {
  function current(podId: string): Row {
    const row = db.prepare('SELECT * FROM pod_goals WHERE pod_id=?').get(podId) as Row | undefined;
    if (!row) configurationError('Pod goal is unavailable', 'GOAL_NOT_FOUND', 404);
    return row;
  }
  function matches(row: Row, fence: GoalAttemptFence): boolean {
    return row.generation === fence.generation && row.attempt_id === fence.attemptId;
  }
  function update(row: Row, fields: Partial<Row>): PodGoal {
    const entries = Object.entries({
      ...fields,
      revision: row.revision + 1,
      updated_at: new Date().toISOString(),
    });
    const result = db
      .prepare(
        `UPDATE pod_goals SET ${entries.map(([key]) => `${key}=?`).join(',')} WHERE pod_id=? AND revision=?`,
      )
      .run(...entries.map(([, value]) => value), row.pod_id, row.revision);
    if (result.changes !== 1) configurationError('Goal changed concurrently', 'GOAL_CHANGED', 409);
    return project(current(row.pod_id));
  }
  return {
    get(podId: string): PodGoal | null {
      const row = db.prepare('SELECT * FROM retained_pod_goals WHERE pod_id=?').get(podId) as
        | Row
        | undefined;
      return row ? project(row) : null;
    },
    create(podId: string, objective: string, runtime: PodGoal['runtime']): PodGoal {
      if (!objective.trim() || objective.length > 4000)
        configurationError('Goal objective must contain 1 to 4000 characters', 'INVALID_GOAL');
      const now = new Date().toISOString();
      db.prepare(
        "INSERT INTO pod_goals(pod_id,objective,state,runtime,created_at,updated_at) VALUES(?,?,'active',?,?,?)",
      ).run(podId, objective, runtime, now, now);
      return project(current(podId));
    },
    beginAttempt: db.transaction(
      (
        podId: string,
        revision: number,
        fence: GoalAttemptFence,
        runtime: PodGoal['runtime'],
        counterMode: 'preserved' | 'reset' = 'preserved',
      ): PodGoal => {
        const row = current(podId);
        if (matches(row, fence)) {
          if (runtime !== row.runtime || row.execution_stopped)
            configurationError(
              'Native goal attempt cannot be reused',
              'GOAL_ATTEMPT_SUPERSEDED',
              409,
            );
          return project(row);
        }
        if (row.revision !== revision)
          configurationError('Goal changed before native launch', 'GOAL_CHANGED', 409);
        if (!row.execution_stopped)
          configurationError(
            'Confirm the previous native process stopped before resuming',
            'GOAL_TERMINATION_UNCONFIRMED',
            409,
          );
        if (terminal.has(row.state) || row.control_intent === 'cancel')
          configurationError('This goal cannot start another native attempt', 'GOAL_TERMINAL', 409);
        if (row.attempt_id && row.control_intent !== 'resume')
          configurationError(
            'Resume the saved Goal explicitly before another attempt',
            'GOAL_RESUME_REQUIRED',
            409,
          );
        if (runtime !== row.runtime)
          configurationError(
            'Cross-runtime native goal continuity is unavailable',
            'GOAL_HANDOFF_REQUIRED',
            409,
          );
        if (!Number.isSafeInteger(fence.generation) || fence.generation < 0 || !fence.attemptId)
          configurationError('Invalid native goal attempt identity', 'INVALID_GOAL_ATTEMPT');
        return update(row, {
          generation: fence.generation,
          attempt_id: fence.attemptId,
          execution_stopped: 0,
          state: 'active',
          control_intent: null,
          last_sequence: -1,
          ...(counterMode === 'reset' ? { native_tokens_seen: 0, native_seconds_seen: 0 } : {}),
        });
      },
    ),
    bindSession: db.transaction(
      (podId: string, fence: GoalAttemptFence, nativeSessionId: string): PodGoal => {
        const row = current(podId);
        if (!matches(row, fence) || row.execution_stopped)
          configurationError('Native goal attempt was superseded', 'GOAL_ATTEMPT_SUPERSEDED', 409);
        if (
          !nativeSessionId ||
          (row.native_session_id && row.native_session_id !== nativeSessionId)
        )
          configurationError('Native goal session identity changed', 'GOAL_SESSION_MISMATCH', 409);
        return row.native_session_id
          ? project(row)
          : update(row, { native_session_id: nativeSessionId });
      },
    ),
    observe: db.transaction(
      (podId: string, fence: GoalAttemptFence, observation: NativeGoalObservation): PodGoal => {
        const row = current(podId);
        if (!matches(row, fence) || row.execution_stopped) return project(row);
        if (
          observation.nativeSessionId !== row.native_session_id ||
          observation.objective !== row.objective
        )
          configurationError(
            'Native goal identity differs from the saved objective/session',
            'GOAL_SESSION_MISMATCH',
            409,
          );
        if (
          !Number.isSafeInteger(observation.sequence) ||
          observation.sequence < 0 ||
          !Number.isSafeInteger(observation.cumulativeTokens) ||
          observation.cumulativeTokens < 0 ||
          !Number.isFinite(observation.cumulativeSeconds) ||
          observation.cumulativeSeconds < 0
        )
          configurationError('Native goal usage evidence is invalid', 'GOAL_USAGE_UNAVAILABLE');
        if (observation.sequence <= row.last_sequence) return project(row);
        if (
          observation.cumulativeTokens < row.native_tokens_seen ||
          observation.cumulativeSeconds < row.native_seconds_seen
        )
          configurationError(
            'Native counters reset without a new confirmed attempt',
            'GOAL_USAGE_RESET_UNCONFIRMED',
            409,
          );
        if (terminal.has(row.state) && observation.state !== row.state)
          configurationError('Native goal cannot reopen a terminal result', 'GOAL_TERMINAL', 409);
        const controlPending = row.control_intent === 'pause' || row.control_intent === 'cancel';
        return update(row, {
          state:
            row.control_intent !== 'cancel' && terminal.has(observation.state)
              ? observation.state
              : controlPending
                ? row.state
                : observation.state,
          native_status: observation.nativeStatus,
          last_sequence: observation.sequence,
          native_tokens_seen: observation.cumulativeTokens,
          native_seconds_seen: observation.cumulativeSeconds,
          observed_tokens:
            row.observed_tokens + observation.cumulativeTokens - row.native_tokens_seen,
          observed_seconds:
            row.observed_seconds + observation.cumulativeSeconds - row.native_seconds_seen,
          reason: observation.reason ?? null,
        });
      },
    ),
    reconcileObservation: db.transaction((podId, fence, observation) => {
      const row = current(podId);
      if (!matches(row, fence) || row.execution_stopped)
        configurationError('Native Goal recovery was superseded', 'GOAL_SUPERSEDED', 409);
      // A newly attached inspection transport has its own sequence. Preserve the
      // durable sequence and compare native cumulative counters, charging only deltas.
      return createGoalRepository(db).observe(podId, fence, {
        ...observation,
        sequence: row.last_sequence + 1,
      });
    }),
    requestControl: db.transaction(
      (podId: string, revision: number, intent: GoalControlIntent): PodGoal => {
        const row = current(podId);
        if (row.revision !== revision)
          configurationError('Goal changed before the control request', 'GOAL_CHANGED', 409);
        if (terminal.has(row.state) && (row.execution_stopped || intent === 'resume'))
          configurationError('Goal is already terminal', 'GOAL_TERMINAL', 409);
        if (intent === 'resume' && !row.execution_stopped)
          configurationError(
            'Previous native execution has not stopped',
            'GOAL_TERMINATION_UNCONFIRMED',
            409,
          );
        return update(row, { control_intent: intent });
      },
    ),
    confirmIdleControl(podId: string): PodGoal {
      const row = current(podId);
      if (!row.execution_stopped)
        configurationError(
          'Native process termination is unconfirmed',
          'GOAL_TERMINATION_UNCONFIRMED',
          409,
        );
      return update(row, {
        state: terminal.has(row.state)
          ? row.state
          : row.control_intent === 'cancel'
            ? 'cancelled'
            : row.control_intent === 'pause'
              ? 'paused'
              : row.state,
        control_intent: null,
      });
    },
    confirmStopped: db.transaction((podId: string, fence: GoalAttemptFence): PodGoal => {
      const row = current(podId);
      if (!matches(row, fence)) return project(row);
      const state = terminal.has(row.state)
        ? row.state
        : row.control_intent === 'cancel'
          ? 'cancelled'
          : row.control_intent === 'pause'
            ? 'paused'
            : row.state;
      return update(row, { execution_stopped: 1, state, control_intent: null });
    }),
    canComplete(podId: string): boolean {
      const row = current(podId);
      return row.state === 'achieved' && !!row.execution_stopped && row.control_intent === null;
    },
    exhausted(podId: string, fence: GoalAttemptFence): PodGoal {
      const row = current(podId);
      if (!matches(row, fence)) return project(row);
      if (!row.execution_stopped)
        configurationError(
          'Stop native execution before confirming budget exhaustion',
          'GOAL_TERMINATION_UNCONFIRMED',
          409,
        );
      if (terminal.has(row.state)) return project(row);
      return update(row, { state: 'budget-exhausted', reason: 'Whole-pod token budget exhausted' });
    },
    attention: db.transaction((podId: string, fence: GoalAttemptFence, reason: string): PodGoal => {
      const row = current(podId);
      if (!matches(row, fence)) return project(row);
      return update(row, { state: terminal.has(row.state) ? row.state : 'paused', reason });
    }),
  };
}
