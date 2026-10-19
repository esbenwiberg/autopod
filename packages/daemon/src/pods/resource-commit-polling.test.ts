import { describe, expect, it, vi } from 'vitest';
import { createResourceFixture, deferred, result } from '../test-utils/resource-helpers.js';
describe('resource commit polling ownership', () => {
  it('captures initial SHA once, publishes count/time and survives actual SQLite reopen', async () => {
    vi.useFakeTimers();
    const f = createResourceFixture(true);
    vi.mocked(f.cm.execInContainer).mockImplementation(async (_id, args) =>
      result(
        args[1] === 'rev-parse'
          ? 'initial-sha'
          : args[1] === 'rev-list'
            ? '4'
            : '2026-10-19T06:00:00Z',
      ),
    );
    f.commit.startCommitPolling('prepare');
    await vi.advanceTimersByTimeAsync(0);
    expect(f.pod()).toMatchObject({
      startCommitSha: 'initial-sha',
      commitCount: 4,
      lastCommitAt: '2026-10-19T06:00:00Z',
    });
    await vi.advanceTimersByTimeAsync(60000);
    expect(
      vi.mocked(f.cm.execInContainer).mock.calls.filter(([, args]) => args[1] === 'rev-parse'),
    ).toHaveLength(1);
    f.commit.stopCommitPolling('prepare');
    expect(vi.getTimerCount()).toBe(0);
    const saved = f.pod();
    const profile = f.profiles.get('test-profile');
    const next = f.reopen();
    expect(next.pods.getOrThrow('prepare')).toEqual(saved);
    expect(next.profiles.get('test-profile')).toEqual(profile);
    expect(f.db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(f.db.pragma('foreign_key_check')).toEqual([]);
  });
  it('uses legacy base fallback when initial capture fails and reads checkpoint service live', async () => {
    vi.useFakeTimers();
    const f = createResourceFixture();
    f.sandbox();
    f.podRepo.update('prepare', { startCommitSha: null, baseBranch: 'release' });
    vi.mocked(f.cm.execInContainer).mockImplementation(async (_id, args) =>
      args[1] === 'rev-parse'
        ? result('', 1)
        : result(args[1] === 'rev-list' ? '2' : '2026-10-19T06:00:00Z'),
    );
    const poll = vi.fn(async () => ({ checkpointed: false, degraded: true }));
    f.live.workspaceCheckpointController = { poll };
    f.commit.startCommitPolling('prepare');
    await vi.advanceTimersByTimeAsync(0);
    expect(f.cm.execInContainer).toHaveBeenCalledWith(
      'container-123',
      ['git', 'rev-list', '--count', 'HEAD', '^release'],
      expect.any(Object),
    );
    expect(poll).toHaveBeenCalledWith('prepare');
    expect(f.deps.eventRepo?.getForSession('prepare').map((row) => row.payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'pod.agent_activity',
          event: expect.objectContaining({
            type: 'status',
            message: 'Durability degraded — retaining sandbox until checkpoint succeeds.',
          }),
        }),
      ]),
    );
    f.commit.stopCommitPolling('prepare');
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([
    'generation',
    'container',
    'target',
    'worktree',
    'branch',
    'base',
    'sha',
    'deleted',
  ] as const)('fences a %s replacement while count probe is pending', async (change) => {
    vi.useFakeTimers();
    const f = createResourceFixture();
    f.podRepo.update('prepare', { startCommitSha: 'initial' });
    const gate = deferred<ReturnType<typeof result>>();
    vi.mocked(f.cm.execInContainer).mockImplementation(async (_id, args) =>
      args[1] === 'rev-list' ? gate.promise : result('time'),
    );
    f.commit.startCommitPolling('prepare');
    await vi.advanceTimersByTimeAsync(0);
    expect(f.cm.execInContainer).toHaveBeenCalledTimes(2);
    if (change === 'generation') f.podRepo.incrementLifecycleGeneration('prepare');
    else if (change === 'container') f.podRepo.update('prepare', { containerId: 'replacement' });
    else if (change === 'target') f.sandbox();
    else if (change === 'worktree')
      f.podRepo.update('prepare', { worktreePath: `${f.directory}/replacement` });
    else if (change === 'branch')
      f.db.prepare('UPDATE pods SET branch=? WHERE id=?').run('replacement', 'prepare');
    else if (change === 'base') f.podRepo.update('prepare', { baseBranch: 'replacement' });
    else if (change === 'sha') f.podRepo.update('prepare', { startCommitSha: 'replacement' });
    else {
      f.podRepo.update('prepare', { status: 'killed' });
      f.podRepo.delete('prepare');
    }
    gate.resolve(result('99'));
    await vi.advanceTimersByTimeAsync(0);
    if (change !== 'deleted') expect(f.pod().commitCount).not.toBe(99);
    f.commit.stopCommitPolling('prepare');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('waits for a stopped in-flight owner before a replacement polls once', async () => {
    vi.useFakeTimers();
    const f = createResourceFixture();
    f.podRepo.update('prepare', { startCommitSha: 'initial' });
    const gate = deferred<ReturnType<typeof result>>();
    let counts = 0;
    vi.mocked(f.cm.execInContainer).mockImplementation(async (_id, args) =>
      args[1] === 'rev-list' ? (++counts === 1 ? gate.promise : result('7')) : result('time'),
    );
    f.commit.startCommitPolling('prepare');
    await vi.advanceTimersByTimeAsync(0);
    f.commit.stopCommitPolling('prepare');
    f.commit.startCommitPolling('prepare');
    await vi.advanceTimersByTimeAsync(60000);
    expect(counts).toBe(1);
    gate.resolve(result('99'));
    await vi.advanceTimersByTimeAsync(0);
    expect(counts).toBe(2);
    expect(f.pod().commitCount).toBe(7);
    f.commit.stopCommitPolling('prepare');
    expect(vi.getTimerCount()).toBe(0);
  });
});
