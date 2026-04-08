import type {
  ExecutionTarget,
  OutputMode,
  Session,
  SessionStatus,
  TaskSummary,
} from '@autopod/shared';
import { SessionNotFoundError } from '@autopod/shared';
import type Database from 'better-sqlite3';

export interface NewSession {
  id: string;
  profileName: string;
  task: string;
  status: SessionStatus;
  model: string;
  runtime: string;
  executionTarget: ExecutionTarget;
  branch: string;
  userId: string;
  maxValidationAttempts: number;
  skipValidation: boolean;
  acceptanceCriteria?: string[] | null;
  outputMode: OutputMode;
  baseBranch?: string | null;
  acFrom?: string | null;
  linkedSessionId?: string | null;
}

export interface SessionFilters {
  profileName?: string;
  status?: SessionStatus;
  userId?: string;
}

export interface SessionUpdates {
  status?: SessionStatus;
  containerId?: string | null;
  worktreePath?: string | null;
  validationAttempts?: number;
  lastValidationResult?: unknown | null;
  lastCorrectionMessage?: string | null;
  pendingEscalation?: unknown | null;
  escalationCount?: number;
  startedAt?: string | null;
  completedAt?: string | null;
  filesChanged?: number;
  linesAdded?: number;
  linesRemoved?: number;
  previewUrl?: string | null;
  prUrl?: string | null;
  mergeBlockReason?: string | null;
  plan?: { summary: string; steps: string[] } | null;
  progress?: {
    phase: string;
    description: string;
    currentPhase: number;
    totalPhases: number;
  } | null;
  claudeSessionId?: string | null;
  acceptanceCriteria?: string[] | null;
  recoveryWorktreePath?: string | null;
  reworkReason?: string | null;
  lastHeartbeatAt?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  commitCount?: number;
  lastCommitAt?: string | null;
  startCommitSha?: string | null;
  linkedSessionId?: string | null;
  taskSummary?: TaskSummary | null;
}

export interface SessionStats {
  total: number;
  byStatus: Record<SessionStatus, number>;
}

export interface SessionRepository {
  insert(session: NewSession): void;
  getOrThrow(id: string): Session;
  update(id: string, changes: SessionUpdates): void;
  delete(id: string): void;
  list(filters?: SessionFilters): Session[];
  countByStatusAndProfile(status: SessionStatus, profileName: string): number;
  getStats(filters?: { profileName?: string }): SessionStats;
}

/** Map a SQLite row (snake_case) to a Session (camelCase). */
function rowToSession(row: Record<string, unknown>): Session {
  return {
    id: row.id as string,
    profileName: row.profile_name as string,
    task: row.task as string,
    status: row.status as SessionStatus,
    model: row.model as string,
    runtime: row.runtime as Session['runtime'],
    executionTarget: (row.execution_target as Session['executionTarget']) ?? 'local',
    branch: row.branch as string,
    containerId: (row.container_id as string) ?? null,
    worktreePath: (row.worktree_path as string) ?? null,
    validationAttempts: row.validation_attempts as number,
    maxValidationAttempts: row.max_validation_attempts as number,
    lastValidationResult: row.last_validation_result
      ? JSON.parse(row.last_validation_result as string)
      : null,
    lastCorrectionMessage: (row.last_correction_message as string) ?? null,
    pendingEscalation: row.pending_escalation ? JSON.parse(row.pending_escalation as string) : null,
    escalationCount: row.escalation_count as number,
    skipValidation: Boolean(row.skip_validation),
    createdAt: row.created_at as string,
    startedAt: (row.started_at as string) ?? null,
    completedAt: (row.completed_at as string) ?? null,
    updatedAt: row.updated_at as string,
    userId: row.user_id as string,
    filesChanged: row.files_changed as number,
    linesAdded: row.lines_added as number,
    linesRemoved: row.lines_removed as number,
    previewUrl: (row.preview_url as string) ?? null,
    prUrl: (row.pr_url as string) ?? null,
    mergeBlockReason: (row.merge_block_reason as string) ?? null,
    plan: row.plan ? JSON.parse(row.plan as string) : null,
    progress: row.progress ? JSON.parse(row.progress as string) : null,
    acceptanceCriteria: row.acceptance_criteria
      ? JSON.parse(row.acceptance_criteria as string)
      : null,
    claudeSessionId: (row.claude_session_id as string) ?? null,
    outputMode: (row.output_mode as OutputMode) ?? 'pr',
    baseBranch: (row.base_branch as string) ?? null,
    acFrom: (row.ac_from as string) ?? null,
    recoveryWorktreePath: (row.recovery_worktree_path as string) ?? null,
    reworkReason: (row.rework_reason as string) ?? null,
    lastHeartbeatAt: (row.last_heartbeat_at as string) ?? null,
    inputTokens: (row.input_tokens as number) ?? 0,
    outputTokens: (row.output_tokens as number) ?? 0,
    costUsd: (row.cost_usd as number) ?? 0,
    commitCount: (row.commit_count as number) ?? 0,
    lastCommitAt: (row.last_commit_at as string) ?? null,
    startCommitSha: (row.start_commit_sha as string) ?? null,
    linkedSessionId: (row.linked_session_id as string) ?? null,
    taskSummary: row.task_summary ? JSON.parse(row.task_summary as string) : null,
  };
}

export function createSessionRepository(db: Database.Database): SessionRepository {
  return {
    insert(session: NewSession): void {
      db.prepare(`
        INSERT INTO sessions (
          id, profile_name, task, status, model, runtime, execution_target, branch,
          user_id, max_validation_attempts, skip_validation, acceptance_criteria,
          output_mode, base_branch, ac_from, linked_session_id
        ) VALUES (
          @id, @profileName, @task, @status, @model, @runtime, @executionTarget, @branch,
          @userId, @maxValidationAttempts, @skipValidation, @acceptanceCriteria,
          @outputMode, @baseBranch, @acFrom, @linkedSessionId
        )
      `).run({
        id: session.id,
        profileName: session.profileName,
        task: session.task,
        status: session.status,
        model: session.model,
        runtime: session.runtime,
        executionTarget: session.executionTarget,
        branch: session.branch,
        userId: session.userId,
        maxValidationAttempts: session.maxValidationAttempts,
        skipValidation: session.skipValidation ? 1 : 0,
        acceptanceCriteria: session.acceptanceCriteria
          ? JSON.stringify(session.acceptanceCriteria)
          : null,
        outputMode: session.outputMode,
        baseBranch: session.baseBranch ?? null,
        acFrom: session.acFrom ?? null,
        linkedSessionId: session.linkedSessionId ?? null,
      });
    },

    getOrThrow(id: string): Session {
      const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
        | Record<string, unknown>
        | undefined;
      if (!row) throw new SessionNotFoundError(id);
      return rowToSession(row);
    },

    update(id: string, changes: SessionUpdates): void {
      const setClauses: string[] = [];
      const params: Record<string, unknown> = { id };

      if (changes.status !== undefined) {
        setClauses.push('status = @status');
        params.status = changes.status;
      }
      if (changes.containerId !== undefined) {
        setClauses.push('container_id = @containerId');
        params.containerId = changes.containerId;
      }
      if (changes.worktreePath !== undefined) {
        setClauses.push('worktree_path = @worktreePath');
        params.worktreePath = changes.worktreePath;
      }
      if (changes.validationAttempts !== undefined) {
        setClauses.push('validation_attempts = @validationAttempts');
        params.validationAttempts = changes.validationAttempts;
      }
      if (changes.lastValidationResult !== undefined) {
        setClauses.push('last_validation_result = @lastValidationResult');
        params.lastValidationResult =
          changes.lastValidationResult !== null
            ? JSON.stringify(changes.lastValidationResult)
            : null;
      }
      if (changes.lastCorrectionMessage !== undefined) {
        setClauses.push('last_correction_message = @lastCorrectionMessage');
        params.lastCorrectionMessage = changes.lastCorrectionMessage;
      }
      if (changes.pendingEscalation !== undefined) {
        setClauses.push('pending_escalation = @pendingEscalation');
        params.pendingEscalation =
          changes.pendingEscalation !== null ? JSON.stringify(changes.pendingEscalation) : null;
      }
      if (changes.escalationCount !== undefined) {
        setClauses.push('escalation_count = @escalationCount');
        params.escalationCount = changes.escalationCount;
      }
      if (changes.startedAt !== undefined) {
        setClauses.push('started_at = @startedAt');
        params.startedAt = changes.startedAt;
      }
      if (changes.completedAt !== undefined) {
        setClauses.push('completed_at = @completedAt');
        params.completedAt = changes.completedAt;
      }
      if (changes.filesChanged !== undefined) {
        setClauses.push('files_changed = @filesChanged');
        params.filesChanged = changes.filesChanged;
      }
      if (changes.linesAdded !== undefined) {
        setClauses.push('lines_added = @linesAdded');
        params.linesAdded = changes.linesAdded;
      }
      if (changes.linesRemoved !== undefined) {
        setClauses.push('lines_removed = @linesRemoved');
        params.linesRemoved = changes.linesRemoved;
      }
      if (changes.previewUrl !== undefined) {
        setClauses.push('preview_url = @previewUrl');
        params.previewUrl = changes.previewUrl;
      }
      if (changes.prUrl !== undefined) {
        setClauses.push('pr_url = @prUrl');
        params.prUrl = changes.prUrl;
      }
      if (changes.mergeBlockReason !== undefined) {
        setClauses.push('merge_block_reason = @mergeBlockReason');
        params.mergeBlockReason = changes.mergeBlockReason;
      }
      if (changes.plan !== undefined) {
        setClauses.push('plan = @plan');
        params.plan = changes.plan !== null ? JSON.stringify(changes.plan) : null;
      }
      if (changes.progress !== undefined) {
        setClauses.push('progress = @progress');
        params.progress = changes.progress !== null ? JSON.stringify(changes.progress) : null;
      }
      if (changes.claudeSessionId !== undefined) {
        setClauses.push('claude_session_id = @claudeSessionId');
        params.claudeSessionId = changes.claudeSessionId;
      }
      if (changes.acceptanceCriteria !== undefined) {
        setClauses.push('acceptance_criteria = @acceptanceCriteria');
        params.acceptanceCriteria =
          changes.acceptanceCriteria !== null ? JSON.stringify(changes.acceptanceCriteria) : null;
      }
      if (changes.lastHeartbeatAt !== undefined) {
        setClauses.push('last_heartbeat_at = @lastHeartbeatAt');
        params.lastHeartbeatAt = changes.lastHeartbeatAt;
      }
      if (changes.recoveryWorktreePath !== undefined) {
        setClauses.push('recovery_worktree_path = @recoveryWorktreePath');
        params.recoveryWorktreePath = changes.recoveryWorktreePath;
      }
      if (changes.reworkReason !== undefined) {
        setClauses.push('rework_reason = @reworkReason');
        params.reworkReason = changes.reworkReason;
      }
      if (changes.inputTokens !== undefined) {
        setClauses.push('input_tokens = @inputTokens');
        params.inputTokens = changes.inputTokens;
      }
      if (changes.outputTokens !== undefined) {
        setClauses.push('output_tokens = @outputTokens');
        params.outputTokens = changes.outputTokens;
      }
      if (changes.costUsd !== undefined) {
        setClauses.push('cost_usd = @costUsd');
        params.costUsd = changes.costUsd;
      }
      if (changes.commitCount !== undefined) {
        setClauses.push('commit_count = @commitCount');
        params.commitCount = changes.commitCount;
      }
      if (changes.lastCommitAt !== undefined) {
        setClauses.push('last_commit_at = @lastCommitAt');
        params.lastCommitAt = changes.lastCommitAt;
      }
      if (changes.startCommitSha !== undefined) {
        setClauses.push('start_commit_sha = @startCommitSha');
        params.startCommitSha = changes.startCommitSha;
      }
      if (changes.linkedSessionId !== undefined) {
        setClauses.push('linked_session_id = @linkedSessionId');
        params.linkedSessionId = changes.linkedSessionId;
      }
      if (changes.taskSummary !== undefined) {
        setClauses.push('task_summary = @taskSummary');
        params.taskSummary =
          changes.taskSummary !== null ? JSON.stringify(changes.taskSummary) : null;
      }

      if (setClauses.length === 0) return;

      // Always update the timestamp
      setClauses.push('updated_at = @updatedAt');
      params.updatedAt = new Date().toISOString();

      const result = db
        .prepare(`UPDATE sessions SET ${setClauses.join(', ')} WHERE id = @id`)
        .run(params);

      if (result.changes === 0) throw new SessionNotFoundError(id);
    },

    list(filters?: SessionFilters): Session[] {
      const whereClauses: string[] = [];
      const params: Record<string, unknown> = {};

      if (filters?.profileName !== undefined) {
        whereClauses.push('profile_name = @profileName');
        params.profileName = filters.profileName;
      }
      if (filters?.status !== undefined) {
        whereClauses.push('status = @status');
        params.status = filters.status;
      }
      if (filters?.userId !== undefined) {
        whereClauses.push('user_id = @userId');
        params.userId = filters.userId;
      }

      const where = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
      const rows = db
        .prepare(`SELECT * FROM sessions ${where} ORDER BY created_at DESC`)
        .all(params) as Record<string, unknown>[];

      return rows.map(rowToSession);
    },

    delete(id: string): void {
      const result = db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
      if (result.changes === 0) throw new SessionNotFoundError(id);
    },

    countByStatusAndProfile(status: SessionStatus, profileName: string): number {
      const row = db
        .prepare(
          'SELECT COUNT(*) as count FROM sessions WHERE status = @status AND profile_name = @profileName',
        )
        .get({ status, profileName }) as { count: number };
      return row.count;
    },

    getStats(filters?: { profileName?: string }): SessionStats {
      const where = filters?.profileName !== undefined ? 'WHERE profile_name = @profileName' : '';
      const params = filters?.profileName !== undefined ? { profileName: filters.profileName } : {};

      const rows = db
        .prepare(`SELECT status, COUNT(*) as count FROM sessions ${where} GROUP BY status`)
        .all(params) as { status: SessionStatus; count: number }[];

      const allStatuses: SessionStatus[] = [
        'queued',
        'provisioning',
        'running',
        'awaiting_input',
        'validating',
        'validated',
        'failed',
        'approved',
        'merging',
        'merge_pending',
        'complete',
        'paused',
        'killing',
        'killed',
      ];
      const byStatus = Object.fromEntries(allStatuses.map((s) => [s, 0])) as Record<
        SessionStatus,
        number
      >;

      let total = 0;
      for (const row of rows) {
        byStatus[row.status] = row.count;
        total += row.count;
      }

      return { total, byStatus };
    },
  };
}
