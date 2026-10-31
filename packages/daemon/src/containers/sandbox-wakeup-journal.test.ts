import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  TEST_WAKEUP_ID as ID,
  TEST_WAKEUP_KEY as KEY,
  createSandboxWakeupFixture,
} from '../test-utils/sandbox-wakeup-helpers.js';
import { createSandboxWakeupJournal } from './sandbox-wakeup-journal.js';

describe('immutable sandbox wakeup claims', () => {
  it('upgrades original pending and settled intents without fabricating response evidence', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    try {
      db.exec(
        readFileSync(
          new URL('../db/migrations/218_sandbox_wakeup_intents.sql', import.meta.url),
          'utf8',
        ),
      );
      const old = createSandboxWakeupJournal(db);
      old.observeRunning(KEY, ID);
      const settled = old.claim(KEY, ID, 'pod');
      old.beginDispatch(settled.id);
      old.observeRunning(KEY, ID);
      const pending = old.claim(KEY, ID, 'pod');
      old.beginDispatch(pending.id);
      const before = db.prepare('SELECT * FROM sandbox_wakeup_intents ORDER BY id').all();
      db.exec(
        readFileSync(
          new URL('../db/migrations/226_sandbox_wakeup_evidence.sql', import.meta.url),
          'utf8',
        ),
      );
      expect(db.prepare('SELECT * FROM sandbox_wakeup_intents ORDER BY id').all()).toEqual(before);
      const upgraded = createSandboxWakeupJournal(db);
      expect(upgraded.claim(KEY, ID)).toEqual({ id: pending.id, acquired: false });
      expect(upgraded.retains(ID)).toBe(true);
      expect(upgraded.listForPod('pod').every((intent) => intent.evidence.length === 0)).toBe(true);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(() =>
        db.prepare('DELETE FROM sandbox_wakeup_intents WHERE id=?').run(pending.id),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('requires recorded 429 proof and keeps sanitized response evidence immutable across reopen', () => {
    const f = createSandboxWakeupFixture(true, true);
    const intent = f.journal.claim(KEY, ID, 'pod');
    f.journal.beginDispatch(intent.id);
    expect(() => f.journal.rejectRateLimited(intent.id)).toThrow();
    f.journal.recordEvidence(intent.id, {
      kind: 'response',
      status: 429,
      diagnostics: {
        'x-ms-request-id': 'x'.repeat(300),
        authorization: 'Bearer secret',
        'set-cookie': 'private',
      },
    });
    const next = f.reopen();
    expect(next.retains(ID)).toBe(false);
    expect(next.listForPod('pod')[0]).toMatchObject({
      settledBy: 'rate-limited',
      evidence: [
        { kind: 'response', status: 429, diagnostics: { 'x-ms-request-id': 'x'.repeat(256) } },
      ],
    });
    expect(JSON.stringify(next.listForPod('pod'))).not.toContain('secret');
    expect(() => f.db.prepare('DELETE FROM sandbox_wakeup_evidence').run()).toThrow();
    expect(() => f.db.prepare('UPDATE sandbox_wakeup_evidence SET status=202').run()).toThrow();
    next.recordEvidence(intent.id, { kind: 'transport-error', errorCode: 'LATE_ERROR' });
    expect(next.listForPod('pod')[0]?.evidence).toHaveLength(1);
    expect(next.claim(KEY, ID).acquired).toBe(true);
  });

  it('retains one unresolved claim across a reopen and never expires it by elapsed time', () => {
    const f = createSandboxWakeupFixture(true, true);
    const first = f.journal.claim(KEY, ID);
    expect(first.acquired).toBe(true);
    const reopened = f.reopen();
    expect(reopened.claim(KEY, ID)).toEqual({ id: first.id, acquired: false });
    expect(reopened.retains(ID)).toBe(true);
    expect(reopened.pendingSandboxIds()).toEqual([ID]);
  });
  it('only a confirmed ResourceLocked rejection releases a claim for another admission', () => {
    const f = createSandboxWakeupFixture(true);
    const first = f.journal.claim(KEY, ID);
    f.journal.beginDispatch(first.id);
    f.journal.rejectLocked(first.id);
    expect(f.journal.retains(ID)).toBe(false);
    const next = f.journal.claim(KEY, ID);
    expect(next.acquired).toBe(true);
    expect(next.id).not.toBe(first.id);
    expect(() => f.journal.beginDispatch(first.id)).toThrow();
  });
  it('a Running observation settles the wake, not task execution, and allows a later stop episode', () => {
    const f = createSandboxWakeupFixture(true);
    const first = f.journal.claim(KEY, ID);
    f.journal.observeRunning(KEY, ID);
    expect(f.journal.retains(ID)).toBe(false);
    expect(f.journal.claim(KEY, ID).acquired).toBe(true);
    const receipt = f.db
      .prepare('SELECT settled_by FROM sandbox_wakeup_intents WHERE id=?')
      .get(first.id);
    expect(receipt).toEqual({ settled_by: 'observed-running' });
    f.journal.rejectLocked(first.id);
    expect(f.journal.retains(ID)).toBe(true);
  });
  it('revokes only unsent work and atomically fences its delayed transport', () => {
    const f = createSandboxWakeupFixture(true);
    const unsent = f.journal.claim(KEY, ID);
    f.journal.revokeUnsent(unsent.id);
    expect(() => f.journal.beginDispatch(unsent.id)).toThrow();
    const dispatched = f.journal.claim(KEY, ID);
    f.journal.beginDispatch(dispatched.id);
    expect(() => f.journal.beginDispatch(dispatched.id)).toThrow();
    f.journal.revokeUnsent(dispatched.id);
    expect(f.journal.retains(ID)).toBe(true);
    expect(() => f.journal.assertReleasable(ID)).toThrow();
  });
  it('cannot settle an original claim using a different resource binding', () => {
    const f = createSandboxWakeupFixture(true);
    const original = f.journal.claim(KEY, ID);
    f.journal.beginDispatch(original.id);
    expect(() => f.journal.observeRunning(KEY, 'replacement')).toThrow();
    expect(f.journal.retains(ID)).toBe(true);
  });
  it('refuses to erase or reinterpret recorded dispatch and settlement', () => {
    const f = createSandboxWakeupFixture(true);
    const first = f.journal.claim(KEY, ID);
    expect(() =>
      f.db.prepare('DELETE FROM sandbox_wakeup_intents WHERE id=?').run(first.id),
    ).toThrow();
    expect(() =>
      f.db.prepare("UPDATE sandbox_wakeup_intents SET sandbox_id='other' WHERE id=?").run(first.id),
    ).toThrow();
    f.journal.observeRunning(KEY, ID);
    expect(() =>
      f.db
        .prepare("UPDATE sandbox_wakeup_intents SET settled_by='resource-locked' WHERE id=?")
        .run(first.id),
    ).toThrow();
    expect(() => f.db.prepare('DELETE FROM sandbox_wakeup_baselines').run()).toThrow();
  });
});
