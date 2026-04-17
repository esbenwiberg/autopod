import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, insertTestProfile } from '../test-utils/mock-helpers.js';
import { createIssueWatcherRepository } from './issue-watcher-repository.js';
import type { IssueWatcherRepository } from './issue-watcher-repository.js';

function insertTestSession(db: Database.Database, id: string) {
  db.prepare(
    `INSERT INTO pods (id, profile_name, task, status, model, runtime, branch, user_id)
     VALUES (?, 'test-profile', 'test task', 'queued', 'opus', 'claude', 'test-branch', 'test-user')`,
  ).run(id);
}

describe('IssueWatcherRepository', () => {
  let db: Database.Database;
  let repo: IssueWatcherRepository;

  beforeEach(() => {
    db = createTestDb();
    insertTestProfile(db);
    repo = createIssueWatcherRepository(db);
  });

  it('creates a watched issue and returns it with id and timestamps', () => {
    const issue = repo.create({
      profileName: 'test-profile',
      provider: 'github',
      issueId: '42',
      issueUrl: 'https://github.com/org/repo/issues/42',
      issueTitle: 'Fix login bug',
      status: 'in_progress',
      podId: null,
      triggerLabel: 'autopod',
    });

    expect(issue.id).toBeGreaterThan(0);
    expect(issue.profileName).toBe('test-profile');
    expect(issue.provider).toBe('github');
    expect(issue.issueId).toBe('42');
    expect(issue.status).toBe('in_progress');
    expect(issue.createdAt).toBeTruthy();
    expect(issue.updatedAt).toBeTruthy();
  });

  it('exists() returns true for tracked issues', () => {
    repo.create({
      profileName: 'test-profile',
      provider: 'github',
      issueId: '42',
      issueUrl: 'https://github.com/org/repo/issues/42',
      issueTitle: 'Fix login bug',
      status: 'in_progress',
      podId: null,
      triggerLabel: 'autopod',
    });

    expect(repo.exists('github', '42', 'test-profile')).toBe(true);
    expect(repo.exists('github', '99', 'test-profile')).toBe(false);
    expect(repo.exists('ado', '42', 'test-profile')).toBe(false);
  });

  it('rejects duplicate (provider, issueId, profileName)', () => {
    repo.create({
      profileName: 'test-profile',
      provider: 'github',
      issueId: '42',
      issueUrl: 'https://github.com/org/repo/issues/42',
      issueTitle: 'Fix login bug',
      status: 'in_progress',
      podId: null,
      triggerLabel: 'autopod',
    });

    expect(() =>
      repo.create({
        profileName: 'test-profile',
        provider: 'github',
        issueId: '42',
        issueUrl: 'https://github.com/org/repo/issues/42',
        issueTitle: 'Duplicate',
        status: 'in_progress',
        podId: null,
        triggerLabel: 'autopod',
      }),
    ).toThrow();
  });

  it('updates status', () => {
    insertTestSession(db, 'sess-123');
    const issue = repo.create({
      profileName: 'test-profile',
      provider: 'github',
      issueId: '42',
      issueUrl: 'https://github.com/org/repo/issues/42',
      issueTitle: 'Fix login bug',
      status: 'in_progress',
      podId: 'sess-123',
      triggerLabel: 'autopod',
    });

    repo.updateStatus(issue.id, 'done');
    const found = repo.findBySessionId('sess-123');
    expect(found?.status).toBe('done');
  });

  it('findBySessionId returns null when not found', () => {
    expect(repo.findBySessionId('nonexistent')).toBeNull();
  });

  it('findBySessionId returns the tracked issue', () => {
    insertTestSession(db, 'sess-abc');
    repo.create({
      profileName: 'test-profile',
      provider: 'github',
      issueId: '42',
      issueUrl: 'https://github.com/org/repo/issues/42',
      issueTitle: 'Fix login bug',
      status: 'in_progress',
      podId: 'sess-abc',
      triggerLabel: 'autopod',
    });

    const found = repo.findBySessionId('sess-abc');
    expect(found).not.toBeNull();
    expect(found?.issueId).toBe('42');
  });

  it('list() returns all issues', () => {
    repo.create({
      profileName: 'test-profile',
      provider: 'github',
      issueId: '1',
      issueUrl: 'https://github.com/org/repo/issues/1',
      issueTitle: 'Issue 1',
      status: 'in_progress',
      podId: null,
      triggerLabel: 'autopod',
    });
    repo.create({
      profileName: 'test-profile',
      provider: 'github',
      issueId: '2',
      issueUrl: 'https://github.com/org/repo/issues/2',
      issueTitle: 'Issue 2',
      status: 'done',
      podId: null,
      triggerLabel: 'autopod',
    });

    expect(repo.list()).toHaveLength(2);
    expect(repo.list({ status: 'done' })).toHaveLength(1);
    expect(repo.list({ profileName: 'test-profile' })).toHaveLength(2);
    expect(repo.list({ profileName: 'other' })).toHaveLength(0);
  });

  it('cascading delete when profile is deleted', () => {
    repo.create({
      profileName: 'test-profile',
      provider: 'github',
      issueId: '42',
      issueUrl: 'https://github.com/org/repo/issues/42',
      issueTitle: 'Fix login bug',
      status: 'in_progress',
      podId: null,
      triggerLabel: 'autopod',
    });

    expect(repo.list()).toHaveLength(1);
    db.prepare('DELETE FROM profiles WHERE name = ?').run('test-profile');
    expect(repo.list()).toHaveLength(0);
  });
});
