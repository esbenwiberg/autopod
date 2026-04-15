import type { WatchedIssue, WatchedIssueStatus } from '@autopod/shared';
import type Database from 'better-sqlite3';

export interface IssueWatcherRepository {
  create(issue: Omit<WatchedIssue, 'id' | 'createdAt' | 'updatedAt'>): WatchedIssue;
  exists(provider: string, issueId: string, profileName: string): boolean;
  updateStatus(id: number, status: WatchedIssueStatus): void;
  findBySessionId(sessionId: string): WatchedIssue | null;
  list(filters?: {
    profileName?: string;
    status?: WatchedIssueStatus;
  }): WatchedIssue[];
}

function rowToWatchedIssue(row: Record<string, unknown>): WatchedIssue {
  return {
    id: row.id as number,
    profileName: row.profile_name as string,
    provider: row.provider as 'github' | 'ado',
    issueId: row.issue_id as string,
    issueUrl: row.issue_url as string,
    issueTitle: row.issue_title as string,
    status: row.status as WatchedIssueStatus,
    sessionId: (row.session_id as string) ?? null,
    triggerLabel: row.trigger_label as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function createIssueWatcherRepository(db: Database.Database): IssueWatcherRepository {
  return {
    create(issue) {
      const result = db
        .prepare(
          `INSERT INTO watched_issues (
            profile_name, provider, issue_id, issue_url, issue_title,
            status, session_id, trigger_label
          ) VALUES (
            @profileName, @provider, @issueId, @issueUrl, @issueTitle,
            @status, @sessionId, @triggerLabel
          )`,
        )
        .run({
          profileName: issue.profileName,
          provider: issue.provider,
          issueId: issue.issueId,
          issueUrl: issue.issueUrl,
          issueTitle: issue.issueTitle,
          status: issue.status,
          sessionId: issue.sessionId,
          triggerLabel: issue.triggerLabel,
        });

      const row = db
        .prepare('SELECT * FROM watched_issues WHERE id = ?')
        .get(result.lastInsertRowid) as Record<string, unknown>;
      return rowToWatchedIssue(row);
    },

    exists(provider, issueId, profileName) {
      const row = db
        .prepare(
          'SELECT 1 FROM watched_issues WHERE provider = ? AND issue_id = ? AND profile_name = ?',
        )
        .get(provider, issueId, profileName);
      return row !== undefined;
    },

    updateStatus(id, status) {
      db.prepare(
        "UPDATE watched_issues SET status = ?, updated_at = datetime('now') WHERE id = ?",
      ).run(status, id);
    },

    findBySessionId(sessionId) {
      const row = db.prepare('SELECT * FROM watched_issues WHERE session_id = ?').get(sessionId) as
        | Record<string, unknown>
        | undefined;
      return row ? rowToWatchedIssue(row) : null;
    },

    list(filters) {
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (filters?.profileName) {
        conditions.push('profile_name = ?');
        params.push(filters.profileName);
      }
      if (filters?.status) {
        conditions.push('status = ?');
        params.push(filters.status);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const rows = db
        .prepare(`SELECT * FROM watched_issues ${where} ORDER BY created_at DESC`)
        .all(...params) as Record<string, unknown>[];
      return rows.map(rowToWatchedIssue);
    },
  };
}
