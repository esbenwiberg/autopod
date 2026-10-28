import { describe, expect, it } from 'vitest';
import {
  TEST_WAKEUP_ID as ID,
  TEST_WAKEUP_KEY as KEY,
  createSandboxWakeupFixture,
} from '../test-utils/sandbox-wakeup-helpers.js';

describe('immutable sandbox wakeup claims', () => {
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
