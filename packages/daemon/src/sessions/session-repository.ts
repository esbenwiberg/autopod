import type Database from 'better-sqlite3';
import type { Session, SessionStatus } from '@autopod/shared';
import { SessionNotFoundError } from '@autopod/shared';

export interface NewSession {
  id: string;
  profileName: string;
  task: string;
  status: SessionStatus;
  model: string;
  runtime: string;
  branch: string;
  userId: string;
  maxValidationAttempts: number;
  skipValidation: boolean;
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
  pendingEscalation?: unknown | null;
  escalationCount?: number;
  startedAt?: string | null;
  completedAt?: string | null;
  filesChanged?: number;
  linesAdded?: number;
  linesRemoved?: number;
  previewUrl?: string | null;
}

export interface SessionRepository {
  insert(session: NewSession): void;
  getOrThrow(id: string): Session;
  update(id: string, changes: SessionUpdates): void;
  list(filters?: SessionFilters): Session[];
  countByStatusAndProfile(status: SessionStatus, profileName: string): number;
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
    branch: row.branch as string,
    containerId: (row.container_id as string) ?? null,
    worktreePath: (row.worktree_path as string) ?? null,
    validationAttempts: row.validation_attempts as number,
    maxValidationAttempts: row.max_validation_attempts as number,
    lastValidationResult: row.last_validation_result
      ? JSON.parse(row.last_validation_result as string)
      : null,
    pendingEscalation: row.pending_escalation
      ? JSON.parse(row.pending_escalation as string)
      : null,
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
  };
}

export function createSessionRepository(db: Database.Database): SessionRepository {
  return {
    insert(session: NewSession): void {
      db.prepare(`
        INSERT INTO sessions (
          id, profile_name, task, status, model, runtime, branch,
          user_id, max_validation_attempts, skip_validation
        ) VALUES (
          @id, @profileName, @task, @status, @model, @runtime, @branch,
          @userId, @maxValidationAttempts, @skipValidation
        )
      `).run({
        id: session.id,
        profileName: session.profileName,
        task: session.task,
        status: session.status,
        model: session.model,
        runtime: session.runtime,
        branch: session.branch,
        userId: session.userId,
        maxValidationAttempts: session.maxValidationAttempts,
        skipValidation: session.skipValidation ? 1 : 0,
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
      if (changes.pendingEscalation !== undefined) {
        setClauses.push('pending_escalation = @pendingEscalation');
        params.pendingEscalation =
          changes.pendingEscalation !== null
            ? JSON.stringify(changes.pendingEscalation)
            : null;
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

    countByStatusAndProfile(status: SessionStatus, profileName: string): number {
      const row = db
        .prepare(
          'SELECT COUNT(*) as count FROM sessions WHERE status = @status AND profile_name = @profileName',
        )
        .get({ status, profileName }) as { count: number };
      return row.count;
    },
  };
}
