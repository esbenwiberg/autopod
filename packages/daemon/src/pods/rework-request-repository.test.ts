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
  expect(createNudgeRepository(f.db).hasPending('rework-fixture')).toBe(false);
  f.repo.atomically?.(() => {
    f.repo.incrementLifecycleGeneration('rework-fixture');
    f.repo.update('rework-fixture', { status: 'queued' });
    f.journal.queueForGeneration('rework-fixture', input.requestKey, 2);
  });
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
    const run = repo.taskExecutions?.beginRun('rework-fixture', 2, 1, {
      runtime: 'codex',
      model: 'model',
      providerAccountId: null,
    });
    expect(run).toBeTruthy();
    const nudges = createNudgeRepository(db);
    const receipt = nudges.readPending('rework-fixture');
    expect(receipt?.messages).toHaveLength(1);
    expect(receipt?.messages[0]).toContain(input.guidance);
    expect(receipt?.messages[0]).toContain(`request ${input.requestKey}, lifecycle 2`);
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
    expect(createNudgeRepository(db).hasPending('rework-fixture')).toBe(false);
    expect(journal.read(input.requestKey)?.guidance).toBe(input.guidance);
    expect(() => journal.queueForGeneration('rework-fixture', input.requestKey, 2)).toThrow(
      'different request or lifecycle',
    );
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

it('retains failed-preservation guidance in its request without delivering it to a later continuation', () => {
  const { db, repo, journal } = fixture();
  try {
    const first = {
      requestKey: randomUUID(),
      generation: 1,
      guidance: 'Earlier continuation guidance',
    };
    journal.accept('rework-fixture', first, actor, () => {});
    repo.incrementLifecycleGeneration('rework-fixture');
    journal.settle(first.requestKey, 'Workspace preservation failed');
    const later = {
      requestKey: randomUUID(),
      generation: 2,
      guidance: 'Later reviewed continuation guidance',
    };
    journal.accept('rework-fixture', later, actor, () => {});
    repo.atomically?.(() => {
      repo.incrementLifecycleGeneration('rework-fixture');
      repo.update('rework-fixture', { status: 'queued' });
      expect(() => journal.queueForGeneration('rework-fixture', first.requestKey, 3)).toThrow(
        'different request or lifecycle',
      );
      journal.queueForGeneration('rework-fixture', later.requestKey, 3);
      journal.queueForGeneration('rework-fixture', later.requestKey, 3);
    });
    const pending = createNudgeRepository(db).listPending('rework-fixture');
    expect(pending).toHaveLength(1);
    expect(pending[0]?.message).toContain(later.guidance);
    expect(pending[0]?.message).not.toContain(first.guidance);
    expect(journal.read(first.requestKey)?.guidance).toBe(first.guidance);
  } finally {
    db.close();
  }
});
