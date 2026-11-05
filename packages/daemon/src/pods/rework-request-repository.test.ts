import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createDatabase } from '../db/connection.js';
import { createTestDb, insertTestProfile, logger } from '../test-utils/mock-helpers.js';
import { createNudgeRepository } from './nudge-repository.js';
import { createPodRepository } from './pod-repository.js';
import { createReworkRequestRepository } from './rework-request-repository.js';

const actor = { type: 'human' as const, userId: 'operator' };
function fixture() {
  const db = createTestDb();
  insertTestProfile(db);
  const repo = createPodRepository(db);
  repo.insert({
    id: 'rework-fixture',
    profileName: 'test-profile',
    task: 'Keep work',
    status: 'failed',
    model: 'model',
    runtime: 'codex',
    executionTarget: 'local',
    branch: 'fixture',
    userId: 'operator',
    maxValidationAttempts: 3,
    skipValidation: false,
    outputMode: 'pr',
  });
  return { db, repo, journal: createReworkRequestRepository(db) };
}
it('retains exact guidance and no replay dispatch across response loss and SQLite reopen, then delivers to a fresh worker', () => {
  const f = fixture();
  const dir = mkdtempSync(join(tmpdir(), 'rework-request-'));
  const file = join(dir, 'state.db');
  const input = {
    requestKey: randomUUID(),
    generation: 1,
    guidance: 'Inspect the remaining tests; retain the earlier edits.',
  };
  const admission = vi.fn();
  const accepted = f.journal.accept('rework-fixture', input, actor, admission);
  expect(accepted.fresh).toBe(true);
  expect(createNudgeRepository(f.db).hasPending('rework-fixture')).toBe(true);
  writeFileSync(file, f.db.serialize());
  f.db.close();
  const db = createDatabase(file, logger);
  try {
    const journal = createReworkRequestRepository(db);
    const repeat = journal.accept('rework-fixture', input, actor, admission);
    expect(repeat).toEqual({ receipt: accepted.receipt, fresh: false });
    expect(admission).toHaveBeenCalledTimes(1);
    expect(() =>
      journal.accept('rework-fixture', { ...input, requestKey: randomUUID() }, actor, admission),
    ).toThrow('unresolved');
    const repo = createPodRepository(db);
    repo.incrementLifecycleGeneration('rework-fixture');
    const run = repo.taskExecutions?.beginRun('rework-fixture', 2, 1, {
      runtime: 'codex',
      model: 'model',
      providerAccountId: null,
    });
    expect(run).toBeTruthy();
    const nudges = createNudgeRepository(db);
    const receipt = nudges.readPending('rework-fixture');
    expect(receipt?.messages).toEqual([input.guidance]);
    expect(nudges.readPending('rework-fixture')).toEqual(receipt);
    expect(nudges.hasPending('rework-fixture')).toBe(true);
    if (!receipt) throw new Error('Missing guidance receipt');
    nudges.acknowledgeDelivery('rework-fixture', receipt.deliveryId);
    expect(nudges.hasPending('rework-fixture')).toBe(false);
    journal.settle(input.requestKey, null);
    expect(journal.accept('rework-fixture', input, actor, admission).fresh).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS count FROM nudge_messages').get()).toEqual({ count: 1 });
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
it('rejects changed payloads, actor and lifecycle; rejected admission queues nothing', () => {
  const { db, journal } = fixture();
  try {
    const input = { requestKey: randomUUID(), generation: 1, guidance: 'Saved continuation' };
    expect(() =>
      journal.accept('rework-fixture', input, actor, () => {
        throw new Error('settlement blocked');
      }),
    ).toThrow('settlement blocked');
    expect(journal.read(input.requestKey)).toBeNull();
    expect(createNudgeRepository(db).hasPending('rework-fixture')).toBe(false);
    expect(() =>
      journal.accept('rework-fixture', { ...input, generation: 2 }, actor, () => {}),
    ).toThrow('lifecycle changed');
    journal.accept('rework-fixture', input, actor, () => {});
    for (const changed of [
      { ...input, guidance: 'Changed' },
      { ...input, generation: 2 },
    ])
      expect(() => journal.accept('rework-fixture', changed, actor, () => {})).toThrow(
        'different payload',
      );
    expect(() =>
      journal.accept('rework-fixture', input, { ...actor, userId: 'other' }, () => {}),
    ).toThrow('different payload');
    journal.settle(input.requestKey, 'Preservation failed; original resource retained');
    expect(journal.read(input.requestKey)?.error).toContain('Preservation failed');
    expect(createNudgeRepository(db).hasPending('rework-fixture')).toBe(true);
  } finally {
    db.close();
  }
});
it('keeps empty guidance agent-free until the dispatcher and creates no message', () => {
  const { db, journal } = fixture();
  try {
    journal.accept(
      'rework-fixture',
      { requestKey: randomUUID(), generation: 1, guidance: '' },
      actor,
      () => {},
    );
    expect(createNudgeRepository(db).hasPending('rework-fixture')).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS count FROM task_agent_runs').get()).toEqual({ count: 0 });
  } finally {
    db.close();
  }
});
