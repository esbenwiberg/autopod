import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRetainedCheckpointRepository } from './retained-checkpoint-repository.js';

describe('bounded diagnostic infrastructure needs reader', () => {
  let db: Database.Database;
  let repo: ReturnType<typeof createRetainedCheckpointRepository>;
  const pod = { id: 'pod', lifecycleGeneration: 2 };
  function insert(id: string, payload: unknown, podId = pod.id, type = 'report_blocker') {
    db.prepare('INSERT INTO escalations VALUES(?,?,?,?,?)').run(
      id,
      podId,
      type,
      typeof payload === 'string' ? payload : JSON.stringify(payload),
      '2026-01-01',
    );
  }
  const report = {
    kind: 'infrastructure',
    lifecycleGeneration: 2,
    owner: 'validation',
    phase: 'Build image',
    needs: 'A qualified executor',
  };
  beforeEach(() => {
    db = new Database(':memory:');
    // Deliberately no pods/finalizations/results table: this reader needs no admission evidence.
    db.exec(
      'CREATE TABLE escalations(id TEXT PRIMARY KEY,pod_id TEXT,type TEXT,payload TEXT,created_at TEXT)',
    );
    repo = createRetainedCheckpointRepository(db);
  });
  afterEach(() => db.close());

  it('reads only the exact pod/current generation/infrastructure kind and never writes', () => {
    insert('current', report);
    insert('old', { ...report, lifecycleGeneration: 1 });
    insert('other-pod', report, 'other');
    insert('question', report, pod.id, 'ask_human');
    insert('actionable', { ...report, kind: 'actionable_input' });
    insert('unknown-generation', { ...report, lifecycleGeneration: undefined });
    insert('malformed', '{invalid JSON');
    const changes = db.prepare('SELECT total_changes() AS count').get();
    db.pragma('query_only=ON');
    const expected = {
      truncated: false,
      needs: [
        {
          id: 'current',
          owner: report.owner,
          phase: report.phase,
          needs: report.needs,
          truncated: false,
        },
      ],
    };
    expect(repo.infrastructureNeeds(pod)).toEqual(expected);
    expect(repo.infrastructureNeeds(pod)).toEqual(expected);
    expect(db.prepare('SELECT total_changes() AS count').get()).toEqual(changes);
  });

  it('bounds row count and every projected text field even for very large payloads', () => {
    for (let index = 0; index < 21; index++)
      insert(`${'i'.repeat(300)}-${index}`, {
        ...report,
        owner: 'o'.repeat(300),
        phase: 'p'.repeat(300),
        needs: 'n'.repeat(100000),
      });
    db.pragma('query_only=ON');
    const result = repo.infrastructureNeeds(pod);
    expect(result.truncated).toBe(true);
    expect(result.needs).toHaveLength(20);
    for (const need of result.needs)
      expect(need).toEqual({
        id: 'i'.repeat(256),
        owner: 'o'.repeat(256),
        phase: 'p'.repeat(256),
        needs: 'n'.repeat(1024),
        truncated: true,
      });
    expect(
      db
        .prepare("SELECT length(json_extract(payload,'$.needs')) AS size FROM escalations LIMIT 1")
        .get(),
    ).toEqual({ size: 100000 });
  });

  it('does not invent needs/owner/phase from absent or non-text fields', () => {
    insert('incomplete', {
      kind: 'infrastructure',
      lifecycleGeneration: 2,
      owner: 42,
      phase: {},
      needs: [],
    });
    expect(repo.infrastructureNeeds(pod)).toEqual({
      truncated: false,
      needs: [
        {
          id: 'incomplete',
          owner: undefined,
          phase: undefined,
          needs: undefined,
          truncated: false,
        },
      ],
    });
  });

  it('propagates storage failures instead of returning no reported needs', () => {
    db.exec('DROP TABLE escalations');
    expect(() => repo.infrastructureNeeds(pod)).toThrow('no such table');
  });
});
