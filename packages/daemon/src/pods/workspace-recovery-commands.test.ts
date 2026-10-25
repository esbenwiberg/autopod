import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createWorkspaceFixture, result } from '../test-utils/workspace-recovery-helpers.js';
describe('workspace recovery commands', () => {
  it('preserves with original default reason and strictly cleans sidecars before network', async () => {
    const f = createWorkspaceFixture();
    await f.recovery().preserveWorkspace('prepare');
    expect(f.common.preservePodWorkspace).toHaveBeenCalledWith(f.pod(), 'operator recovery');
    const order: string[] = [];
    f.common.killSidecarsForPod.mockImplementationOnce(async () => {
      order.push('sidecars');
    });
    f.common.destroyPodNetwork.mockImplementationOnce(async () => {
      order.push('network');
    });
    await f.recovery().cleanupPodResourcesForRecovery('prepare');
    expect(order).toEqual(['sidecars', 'network']);
    expect(f.common.killSidecarsForPod).toHaveBeenCalledWith('prepare', true);
    expect(f.common.destroyPodNetwork).toHaveBeenCalledWith('prepare', true);
  });
  it('runs the exact sandbox PID termination script only for running attached sandboxes and reports failure', async () => {
    const f = createWorkspaceFixture();
    await f.recovery().quiesceSandboxAgent('prepare');
    expect(f.cm.execInContainer).not.toHaveBeenCalled();
    f.sandbox();
    vi.mocked(f.cm.execInContainer).mockResolvedValueOnce(result('', 70));
    await expect(f.recovery().quiesceSandboxAgent('prepare')).rejects.toThrow('exit 70');
    expect(f.cm.execInContainer).toHaveBeenCalledWith(
      'container-123',
      ['sh', '-c', expect.stringContaining('pid_file=/run/autopod/agent.pid')],
      { timeout: 5000 },
    );
    await f.recovery().suspendSandboxForRecovery('prepare');
    expect(f.cm.stop).toHaveBeenCalledWith('container-123');
  });
  it
    .skipIf(process.platform === 'win32' || process.getuid?.() === 0)
    .each(['worker', 'empty', 'invalid'])(
    'clears a %s PID without directory write access or permission changes',
    async (contents) => {
      const f = createWorkspaceFixture();
      f.sandbox();
      const directory = await mkdtemp(join(tmpdir(), 'autopod-quiesce-'));
      const pidFile = join(directory, 'agent.pid');
      const worker =
        contents === 'worker'
          ? spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
          : undefined;
      const exited = worker ? once(worker, 'exit') : undefined;
      try {
        if (worker) await once(worker, 'spawn');
        await writeFile(
          pidFile,
          worker ? String(worker.pid) : contents === 'empty' ? '' : 'invalid',
          {
            mode: 0o600,
          },
        );
        // Models the agent's access to root:root 0755 /run/autopod: it can write
        // its existing 0600 PID file, but cannot unlink entries in the directory.
        await chmod(directory, 0o555);
        const before = await stat(pidFile);
        vi.mocked(f.cm.execInContainer).mockImplementation(async (_id, command) => {
          const script = command[2]?.replace(
            'pid_file=/run/autopod/agent.pid',
            `pid_file='${pidFile.replaceAll("'", "'\\''")}'`,
          );
          if (!script) throw new Error('Missing recovery script');
          return new Promise((resolve, reject) => {
            execFile('sh', ['-c', script], { timeout: 5_000 }, (error, stdout, stderr) => {
              if (error && typeof error.code !== 'number') return reject(error);
              resolve({ stdout, stderr, exitCode: error?.code ?? 0 });
            });
          });
        });

        await expect(f.recovery().quiesceSandboxAgent('prepare')).resolves.toBeUndefined();
        if (exited) await exited;
        expect(await readFile(pidFile, 'utf8')).toBe('');
        const after = await stat(pidFile);
        expect([after.ino, after.uid, after.gid, after.mode]).toEqual([
          before.ino,
          before.uid,
          before.gid,
          before.mode,
        ]);
        expect(after.mode & 0o777).toBe(0o600);
        expect((await stat(directory)).mode & 0o777).toBe(0o555);
        await expect(f.recovery().quiesceSandboxAgent('prepare')).resolves.toBeUndefined();
        expect(await readFile(pidFile, 'utf8')).toBe('');
      } finally {
        if (worker && worker.exitCode === null && worker.signalCode === null)
          worker.kill('SIGKILL');
        if (exited) await exited;
        await chmod(directory, 0o755);
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
  it('requires complete sandbox checkpoint proof before clearing compromise', async () => {
    const f = createWorkspaceFixture();
    f.sandbox();
    f.podRepo.update('prepare', { worktreeCompromised: true });
    const full = await f.common.checkpointSandboxWorkspaceForPod(f.pod());
    f.common.checkpointSandboxWorkspaceForPod.mockResolvedValueOnce({
      ...full,
      materialized: false,
    });
    await expect(f.recovery().recoverWorktree('prepare')).resolves.toMatchObject({
      recovered: false,
    });
    expect(f.pod().worktreeCompromised).toBe(true);
    await expect(f.recovery().recoverWorktree('prepare')).resolves.toMatchObject({
      recovered: true,
    });
    expect(f.pod().worktreeCompromised).toBe(false);
  });
  it('recovers local container source before guarded commit and preserves blockers on failed restore', async () => {
    const f = createWorkspaceFixture();
    f.podRepo.update('prepare', { worktreeCompromised: true });
    f.common.recoverWorktreeFromContainer.mockResolvedValueOnce(true);
    await expect(f.recovery().recoverWorktree('prepare')).resolves.toMatchObject({
      recovered: true,
      message: 'Worktree recovered and committed',
    });
    expect(f.worktreeManager.commitPendingChangesWithGeneratedMessage).toHaveBeenCalledWith(
      f.directory,
      f.pod().task,
      expect.any(Object),
      f.pod().model,
      { maxDeletions: 100 },
    );
    f.podRepo.update('prepare', { worktreeCompromised: true });
    vi.mocked(f.worktreeManager.restoreFromHead).mockResolvedValueOnce({
      restored: false,
      restoredCount: 0,
      reason: 'Unrelated work',
      blockers: [{ status: '??', path: 'retained.txt' }],
    });
    await expect(f.recovery().recoverWorktree('prepare')).resolves.toMatchObject({
      recovered: false,
      blockers: [{ status: '??', path: 'retained.txt' }],
    });
    expect(f.pod().worktreeCompromised).toBe(true);
  });
});
