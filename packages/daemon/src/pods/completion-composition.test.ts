import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCompletionFixture } from '../test-utils/completion-helpers.js';
const fixtures: ReturnType<typeof createCompletionFixture>[] = [];
function fixture(disk = false) {
  const f = createCompletionFixture(disk);
  fixtures.push(f);
  return f;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const f of fixtures.splice(0).reverse()) f.close();
});

describe('composed completion owners', () => {
  it('constructs the existing owners without executing their service callbacks', () => {
    const f = fixture();
    expect(f.cm.execInContainer).not.toHaveBeenCalled();
    expect(f.captured.cleanupContainer).not.toHaveBeenCalled();
    expect(f.captured.preservePodWorkspace).not.toHaveBeenCalled();
    expect(f.worktreeManager.getDiffStats).not.toHaveBeenCalled();
    expect(f.workflowCaptured.holdCompletionForHumanWork).toBe(f.owners.holdCompletionForHumanWork);
    expect(f.workflowCaptured.prepareSourceForCompletion).toBe(f.owners.prepareSourceForCompletion);
    expect(f.workflowCaptured.applyCompletionDecision).toBe(f.owners.applyCompletionDecision);
  });
  it('uses actual source preparation and decision to invoke the dynamic validation callback', async () => {
    const f = fixture();
    f.running();
    await f.workflow().handleCompletion.call(f.calls, 'prepare');
    expect(f.worktreeManager.commitPendingChangesWithGeneratedMessage).toHaveBeenCalledWith(
      f.directory,
      'Original task',
      expect.anything(),
      'claude-sonnet-4-6',
      { maxDeletions: 0 },
    );
    expect(f.calls.triggerValidation).toHaveBeenCalledExactlyOnceWith('prepare');
    expect(f.pod().filesChanged).toBe(3);
    expect(f.captured.cleanupContainer).not.toHaveBeenCalled();
  });
  it('preserves unchanged-source completion, journal and events through actual file SQLite reopen', async () => {
    const f = fixture(true);
    f.running();
    vi.mocked(f.worktreeManager.getDiffStats).mockResolvedValueOnce({
      filesChanged: 0,
      linesAdded: 0,
      linesRemoved: 0,
    });
    const profile = f.profiles.get('test-profile');
    await f.workflow().handleCompletion.call(f.calls, 'prepare');
    expect(f.pod().status).toBe('complete');
    expect(f.captured.cleanupContainer).toHaveBeenCalledWith(
      expect.anything(),
      'no-changes-complete',
    );
    const pod = f.pod();
    const journal = f.podRepo.completionJournal?.get('prepare', pod.lifecycleGeneration);
    expect(journal?.phase).toBe('finished');
    const eventRows = f.db
      .prepare('SELECT * FROM events WHERE pod_id=? ORDER BY id')
      .all('prepare');
    const next = f.reopen();
    expect(f.db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(f.db.pragma('foreign_key_check')).toEqual([]);
    expect(next.pods.getOrThrow('prepare')).toEqual(pod);
    expect(next.pods.completionJournal?.get('prepare', pod.lifecycleGeneration)).toEqual(journal);
    expect(f.db.prepare('SELECT * FROM events WHERE pod_id=? ORDER BY id').all('prepare')).toEqual(
      eventRows,
    );
    expect(next.profiles.get('test-profile')).toEqual(profile);
  });
  it('holds real queued guidance with source/resources retained through file SQLite reopen', async () => {
    const f = fixture(true);
    f.running();
    f.deps.nudgeRepo.queue('prepare', 'Apply saved correction');
    await f.workflow().handleCompletion.call(f.calls, 'prepare');
    const pod = f.pod();
    expect(pod.status).toBe('failed');
    expect(pod.containerId).toBe('container-123');
    expect(f.captured.preservePodWorkspace).toHaveBeenCalledOnce();
    expect(f.calls.triggerValidation).not.toHaveBeenCalled();
    expect(f.captured.cleanupContainer).not.toHaveBeenCalled();
    const guidance = f.db.prepare('SELECT * FROM nudge_messages WHERE pod_id=?').all('prepare');
    const next = f.reopen();
    expect(f.db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(f.db.pragma('foreign_key_check')).toEqual([]);
    expect(next.pods.getOrThrow('prepare')).toEqual(pod);
    expect(f.db.prepare('SELECT * FROM nudge_messages WHERE pod_id=?').all('prepare')).toEqual(
      guidance,
    );
  });
});
