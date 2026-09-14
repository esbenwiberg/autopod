import type { GoalAttemptFence, NativeGoalProcessIdentity } from '@autopod/shared';
import type Database from 'better-sqlite3';
import { configurationError } from '../configuration/configuration-store.js';

export interface GoalProcessOwner {
  podId: string;
  fence: GoalAttemptFence;
  configurationDigest: string;
  accountId: string;
  containerId: string;
}
export interface GoalProcessRecord extends NativeGoalProcessIdentity {
  role: 'agent' | 'inspection';
  stoppedAt: string | null;
  startedAt: string | null;
}
export function createGoalProcessRepository(db: Database.Database) {
  function assertOwner(owner: GoalProcessOwner) {
    if (
      !db
        .prepare(`SELECT 1 FROM pods p JOIN pod_goals g ON g.pod_id=p.id
      JOIN task_agent_runs r ON r.id=g.attempt_id AND r.pod_id=p.id
      WHERE p.id=? AND p.lifecycle_generation=? AND p.launch_config_digest=?
      AND p.provider_account_id_snapshot=? AND p.container_id=?
      AND g.generation=? AND g.attempt_id=? AND g.execution_stopped=0
      AND r.generation=? AND r.ended_at IS NULL`)
        .get(
          owner.podId,
          owner.fence.generation,
          owner.configurationDigest,
          owner.accountId,
          owner.containerId,
          owner.fence.generation,
          owner.fence.attemptId,
          owner.fence.generation,
        )
    )
      configurationError('Native Goal process owner changed', 'GOAL_SUPERSEDED', 409);
  }
  return {
    record(
      owner: GoalProcessOwner,
      identity: NativeGoalProcessIdentity,
      role: GoalProcessRecord['role'],
    ) {
      assertOwner(owner);
      if (
        identity.backend !== 'docker' ||
        identity.containerId !== owner.containerId ||
        !/^[a-f0-9]{64}$/.test(identity.execId) ||
        !/^\/tmp\/\.autopod-stream-exec-[a-f0-9-]{36}\.pid$/.test(identity.pidPath)
      )
        configurationError('Native Goal process identity is invalid', 'GOAL_PROCESS_INVALID', 409);
      db.prepare(`INSERT INTO pod_goal_processes(exec_id,pod_id,attempt_id,generation,
        configuration_digest,account_id,backend,container_id,pid_path,role,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
        identity.execId,
        owner.podId,
        owner.fence.attemptId,
        owner.fence.generation,
        owner.configurationDigest,
        owner.accountId,
        identity.backend,
        identity.containerId,
        identity.pidPath,
        role,
        new Date().toISOString(),
      );
    },
    list(owner: GoalProcessOwner): GoalProcessRecord[] {
      assertOwner(owner);
      const rows = db
        .prepare(`SELECT backend,container_id AS containerId,exec_id AS execId,
        pid_path AS pidPath,role,stopped_at AS stoppedAt,started_at AS startedAt,configuration_digest AS digest,account_id AS account
        FROM pod_goal_processes WHERE pod_id=? AND attempt_id=? AND generation=? ORDER BY created_at,exec_id`)
        .all(owner.podId, owner.fence.attemptId, owner.fence.generation) as (GoalProcessRecord & {
        digest: string;
        account: string;
      })[];
      if (
        rows.some(
          (row) =>
            row.containerId !== owner.containerId ||
            row.digest !== owner.configurationDigest ||
            row.account !== owner.accountId,
        )
      )
        configurationError('Native Goal process identity changed', 'GOAL_SUPERSEDED', 409);
      return rows.map(({ digest: _digest, account: _account, ...record }) => record);
    },
    confirmStarted(owner: GoalProcessOwner, execId: string) {
      assertOwner(owner);
      const result = db
        .prepare(`UPDATE pod_goal_processes SET started_at=? WHERE exec_id=?
        AND pod_id=? AND attempt_id=? AND generation=? AND started_at IS NULL AND stopped_at IS NULL`)
        .run(
          new Date().toISOString(),
          execId,
          owner.podId,
          owner.fence.attemptId,
          owner.fence.generation,
        );
      if (result.changes !== 1)
        configurationError('Native process start identity changed', 'GOAL_PROCESS_INVALID', 409);
    },
    confirmStopped(owner: GoalProcessOwner, execId: string, exitCode: number | null) {
      assertOwner(owner);
      if (exitCode !== null && !Number.isSafeInteger(exitCode))
        configurationError(
          'Native process exit is unconfirmed',
          'GOAL_TERMINATION_UNCONFIRMED',
          409,
        );
      db.prepare(`UPDATE pod_goal_processes SET stopped_at=?,exit_code=? WHERE exec_id=?
        AND pod_id=? AND attempt_id=? AND generation=? AND stopped_at IS NULL`).run(
        new Date().toISOString(),
        exitCode,
        execId,
        owner.podId,
        owner.fence.attemptId,
        owner.fence.generation,
      );
    },
  };
}
