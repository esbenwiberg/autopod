import type { Profile, Pod, SystemEvent } from '@autopod/shared';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEventBus } from '../pods/event-bus.js';
import { createEventRepository } from '../pods/event-repository.js';
import { createTestDb, insertTestProfile, logger } from '../test-utils/mock-helpers.js';
import type { IssueClient, WatchedIssueCandidate } from './issue-client.js';
import { createIssueWatcherRepository } from './issue-watcher-repository.js';
import { createIssueWatcherService } from './issue-watcher-service.js';

function createMockIssueClient(candidates: WatchedIssueCandidate[] = []): IssueClient {
  return {
    listByLabel: vi.fn().mockResolvedValue(candidates),
    addLabel: vi.fn().mockResolvedValue(undefined),
    removeLabel: vi.fn().mockResolvedValue(undefined),
    addComment: vi.fn().mockResolvedValue(undefined),
  };
}

function insertTestSession(db: Database.Database, id: string) {
  db.prepare(
    `INSERT INTO pods (id, profile_name, task, status, model, runtime, branch, user_id)
     VALUES (?, 'test-profile', 'test task', 'queued', 'opus', 'claude', 'test-branch', 'test-user')`,
  ).run(id);
}

function createMockSessionManager(db: Database.Database) {
  let nextId = 1;
  return {
    createSession: vi.fn().mockImplementation(() => {
      const id = `sess-${nextId++}`;
      insertTestSession(db, id);
      return { id, status: 'queued' } as unknown as Pod;
    }),
    refreshNetworkPolicy: vi.fn(),
  };
}

function createMockProfileStore(db: Database.Database) {
  const profiles = new Map<string, Profile>();

  return {
    list: vi.fn(() => {
      const rows = db.prepare('SELECT * FROM profiles').all() as Record<string, unknown>[];
      return rows.map((row) => {
        const cached = profiles.get(row.name as string);
        if (cached) return cached;
        return {
          name: row.name as string,
          repoUrl: row.repo_url as string,
          prProvider: 'github' as const,
          githubPat: 'ghp_test',
          adoPat: null,
          issueWatcherEnabled: !!(row.issue_watcher_enabled as number),
          issueWatcherLabelPrefix: (row.issue_watcher_label_prefix as string) ?? 'autopod',
        } as unknown as Profile;
      });
    }),
    get: vi.fn((name: string) => {
      const cached = profiles.get(name);
      if (cached) return cached;
      const row = db.prepare('SELECT * FROM profiles WHERE name = ?').get(name) as
        | Record<string, unknown>
        | undefined;
      if (!row) throw new Error(`Profile not found: ${name}`);
      return {
        name: row.name as string,
        repoUrl: row.repo_url as string,
        prProvider: 'github' as const,
        githubPat: 'ghp_test',
        adoPat: null,
        issueWatcherEnabled: !!(row.issue_watcher_enabled as number),
        issueWatcherLabelPrefix: (row.issue_watcher_label_prefix as string) ?? 'autopod',
      } as unknown as Profile;
    }),
    exists: vi.fn((name: string) => {
      return !!db.prepare('SELECT 1 FROM profiles WHERE name = ?').get(name);
    }),
    setProfile(name: string, profile: Partial<Profile>) {
      profiles.set(name, { name, ...profile } as Profile);
    },
  };
}

describe('IssueWatcherService', () => {
  let db: Database.Database;
  let mockClient: IssueClient;
  let mockSessionManager: ReturnType<typeof createMockSessionManager>;
  let mockProfileStore: ReturnType<typeof createMockProfileStore>;

  beforeEach(() => {
    db = createTestDb();
    insertTestProfile(db);
    // Enable issue watcher on the test profile
    db.prepare(
      'UPDATE profiles SET issue_watcher_enabled = 1, issue_watcher_label_prefix = ? WHERE name = ?',
    ).run('autopod', 'test-profile');

    mockClient = createMockIssueClient();
    mockSessionManager = createMockSessionManager(db);
    mockProfileStore = createMockProfileStore(db);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createService(clientCandidates: WatchedIssueCandidate[] = []) {
    const client = createMockIssueClient(clientCandidates);
    mockClient = client;

    const eventRepo = createEventRepository(db);
    const eventBus = createEventBus(eventRepo, logger);
    const issueWatcherRepo = createIssueWatcherRepository(db);

    const service = createIssueWatcherService({
      // biome-ignore lint/suspicious/noExplicitAny: mock objects for testing
      profileStore: mockProfileStore as any,
      // biome-ignore lint/suspicious/noExplicitAny: mock objects for testing
      podManager: mockSessionManager as any,
      eventBus,
      issueWatcherRepo,
      logger,
      pollIntervalMs: 999_999, // Don't auto-poll in tests
      issueClientFactory: () => client,
    });

    return { service, eventBus, issueWatcherRepo, client };
  }

  it('picks up an issue and creates a pod', async () => {
    const candidates: WatchedIssueCandidate[] = [
      {
        id: '42',
        title: 'Fix login bug',
        body: 'The login page is broken',
        url: 'https://github.com/org/repo/issues/42',
        labels: ['autopod'],
        triggerLabel: 'autopod',
        acceptanceCriteria: ['Login works'],
      },
    ];

    const { service, issueWatcherRepo, client } = createService(candidates);
    service.start();

    // Wait for the initial poll
    await new Promise((r) => setTimeout(r, 50));
    service.stop();

    // Pod should have been created
    expect(mockSessionManager.createSession).toHaveBeenCalledTimes(1);
    const createCall = mockSessionManager.createSession.mock.calls[0];
    expect(createCall[0].profileName).toBe('test-profile');
    expect(createCall[0].task).toContain('Fix login bug');
    expect(createCall[0].acceptanceCriteria).toEqual(['Login works']);
    expect(createCall[0].branchPrefix).toBe('issue-42/');

    // Should have swapped labels
    expect(client.removeLabel).toHaveBeenCalledWith('42', 'autopod');
    expect(client.addLabel).toHaveBeenCalledWith('42', 'autopod:in-progress');

    // Should have posted a comment
    expect(client.addComment).toHaveBeenCalledWith('42', expect.stringContaining('sess-1'));

    // Should be tracked in the repo
    const tracked = issueWatcherRepo.list();
    expect(tracked).toHaveLength(1);
    expect(tracked[0].podId).toBe('sess-1');
    expect(tracked[0].status).toBe('in_progress');
  });

  it('skips already-tracked issues', async () => {
    const candidates: WatchedIssueCandidate[] = [
      {
        id: '42',
        title: 'Fix login bug',
        body: 'Already tracked',
        url: 'https://github.com/org/repo/issues/42',
        labels: ['autopod'],
        triggerLabel: 'autopod',
      },
    ];

    const { service, issueWatcherRepo } = createService(candidates);

    // Insert a pod row so the FK constraint is satisfied
    insertTestSession(db, 'existing-sess');

    // Pre-insert the tracked issue
    issueWatcherRepo.create({
      profileName: 'test-profile',
      provider: 'github',
      issueId: '42',
      issueUrl: 'https://github.com/org/repo/issues/42',
      issueTitle: 'Fix login bug',
      status: 'in_progress',
      podId: 'existing-sess',
      triggerLabel: 'autopod',
    });

    service.start();
    await new Promise((r) => setTimeout(r, 50));
    service.stop();

    expect(mockSessionManager.createSession).not.toHaveBeenCalled();
  });

  it('skips profiles without issue watcher enabled', async () => {
    // Disable watcher
    db.prepare('UPDATE profiles SET issue_watcher_enabled = 0 WHERE name = ?').run('test-profile');

    const { service } = createService([
      {
        id: '42',
        title: 'Should not be picked up',
        body: '',
        url: 'https://github.com/org/repo/issues/42',
        labels: ['autopod'],
        triggerLabel: 'autopod',
      },
    ]);

    service.start();
    await new Promise((r) => setTimeout(r, 50));
    service.stop();

    expect(mockSessionManager.createSession).not.toHaveBeenCalled();
  });

  it('handles pod completion by swapping labels', async () => {
    const candidates: WatchedIssueCandidate[] = [
      {
        id: '42',
        title: 'Fix bug',
        body: '',
        url: 'https://github.com/org/repo/issues/42',
        labels: ['autopod'],
        triggerLabel: 'autopod',
      },
    ];

    const { service, eventBus, client } = createService(candidates);
    service.start();
    await new Promise((r) => setTimeout(r, 50));

    // Reset mock calls from pickup
    (client.addLabel as ReturnType<typeof vi.fn>).mockClear();
    (client.removeLabel as ReturnType<typeof vi.fn>).mockClear();
    (client.addComment as ReturnType<typeof vi.fn>).mockClear();

    // Simulate pod completion
    eventBus.emit({
      type: 'pod.status_changed',
      timestamp: new Date().toISOString(),
      podId: 'sess-1',
      previousStatus: 'running',
      newStatus: 'complete',
    } as SystemEvent);

    await new Promise((r) => setTimeout(r, 50));
    service.stop();

    expect(client.removeLabel).toHaveBeenCalledWith('42', 'autopod:in-progress');
    expect(client.addLabel).toHaveBeenCalledWith('42', 'autopod:done');
    expect(client.addComment).toHaveBeenCalledWith(
      '42',
      expect.stringContaining('completed successfully'),
    );
  });

  it('handles pod failure by adding failed label', async () => {
    const candidates: WatchedIssueCandidate[] = [
      {
        id: '42',
        title: 'Fix bug',
        body: '',
        url: 'https://github.com/org/repo/issues/42',
        labels: ['autopod'],
        triggerLabel: 'autopod',
      },
    ];

    const { service, eventBus, client } = createService(candidates);
    service.start();
    await new Promise((r) => setTimeout(r, 50));

    (client.addLabel as ReturnType<typeof vi.fn>).mockClear();
    (client.removeLabel as ReturnType<typeof vi.fn>).mockClear();

    eventBus.emit({
      type: 'pod.status_changed',
      timestamp: new Date().toISOString(),
      podId: 'sess-1',
      previousStatus: 'running',
      newStatus: 'failed',
    } as SystemEvent);

    await new Promise((r) => setTimeout(r, 50));
    service.stop();

    expect(client.addLabel).toHaveBeenCalledWith('42', 'autopod:failed');
  });
});
