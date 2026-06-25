import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { createSafetyEventsRepository } from '../safety/safety-events-repository.js';
import { createTestDb, insertTestProfile } from '../test-utils/mock-helpers.js';
import { computeSafetyAnalytics } from './safety-aggregator.js';

let db: Database.Database;

function insertPod(id: string, worktreeCompromised = false): void {
  db.prepare(`
    INSERT INTO pods (
      id, profile_name, task, status, model, runtime, execution_target, branch,
      user_id, max_validation_attempts, skip_validation,
      output_mode, agent_mode, output_target, validate, promotable,
      completed_at, worktree_compromised
    ) VALUES (
      @id, 'test-profile', 'task', 'complete', 'claude-opus-4-7', 'claude', 'local', 'branch-1',
      'user-1', 3, 0,
      'pr', 'auto', 'pr', 1, 0,
      datetime('now'), @worktreeCompromised
    )
  `).run({ id, worktreeCompromised: worktreeCompromised ? 1 : 0 });
}

function insertEvent(
  podId: string,
  type: 'pod.firewall_denied' | 'pod.worktree_compromised',
  payload: Record<string, unknown>,
): void {
  db.prepare(`
    INSERT INTO events (pod_id, type, payload, created_at)
    VALUES (@podId, @type, @payload, datetime('now'))
  `).run({
    podId,
    type,
    payload: JSON.stringify({
      type,
      timestamp: '2026-05-28T11:27:48Z',
      podId,
      ...payload,
    }),
  });
}

describe('computeSafetyAnalytics security stats', () => {
  beforeEach(() => {
    db = createTestDb();
    insertTestProfile(db);
  });

  it('aggregates firewall denials from persisted events', () => {
    insertPod('pod-1');
    insertPod('pod-2');
    insertEvent('pod-1', 'pod.firewall_denied', {
      sni: 'blocked.example.com',
      src: '127.0.0.1',
    });
    insertEvent('pod-1', 'pod.firewall_denied', {
      sni: 'blocked.example.com',
      src: '127.0.0.1',
    });
    insertEvent('pod-2', 'pod.firewall_denied', {
      sni: 'other.example.com',
      src: '127.0.0.1',
    });

    const response = computeSafetyAnalytics(db, createSafetyEventsRepository(db), 30);

    expect(response.firewallDenials.total).toBe(3);
    expect(response.firewallDenials.affectedPods).toBe(2);
    expect(response.firewallDenials.topHosts[0]).toMatchObject({
      sni: 'blocked.example.com',
      count: 2,
    });
    expect(response.firewallDenials.recent).toHaveLength(3);
  });

  it('aggregates worktree safety from compromised flags and deletion guard events', () => {
    insertPod('pod-1', true);
    insertPod('pod-2', false);
    insertEvent('pod-1', 'pod.worktree_compromised', {
      deletionCount: 42,
      threshold: 10,
    });

    const response = computeSafetyAnalytics(db, createSafetyEventsRepository(db), 30);

    expect(response.worktreeSafety.currentCompromisedPods).toBe(1);
    expect(response.worktreeSafety.totalIncidents).toBe(1);
    expect(response.worktreeSafety.recentIncidents[0]).toMatchObject({
      podId: 'pod-1',
      deletionCount: 42,
      threshold: 10,
    });
  });

  it('returns empty security stats when no events are present', () => {
    const response = computeSafetyAnalytics(db, createSafetyEventsRepository(db), 30);

    expect(response.firewallDenials).toEqual({
      total: 0,
      affectedPods: 0,
      topHosts: [],
      recent: [],
    });
    expect(response.worktreeSafety).toEqual({
      currentCompromisedPods: 0,
      totalIncidents: 0,
      recentIncidents: [],
    });
  });
});
