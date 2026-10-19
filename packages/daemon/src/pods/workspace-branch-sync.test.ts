import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { createWorkspaceFixture } from '../test-utils/workspace-recovery-helpers.js';
import { LocalWorktreeManager } from '../worktrees/local-worktree-manager.js';
const exec = promisify(execFile);
describe('workspace document branch sync', () => {
  it('uses actual Git path discovery and commitFiles while preserving unrelated staged code', async () => {
    const f = createWorkspaceFixture();
    f.interactive();
    const work = path.join(f.directory, 'sync');
    mkdirSync(work);
    await exec('git', ['init', '-b', 'branch', work]);
    await exec('git', ['-C', work, 'config', 'user.name', 'Fixture']);
    await exec('git', ['-C', work, 'config', 'user.email', 'fixture@invalid.example']);
    writeFileSync(path.join(work, 'code.ts'), 'old');
    await exec('git', ['-C', work, 'add', '.']);
    await exec('git', ['-C', work, 'commit', '-m', 'initial']);
    await exec('git', ['-C', work, 'update-ref', 'refs/remotes/origin/branch', 'HEAD']);
    writeFileSync(path.join(work, 'code.ts'), 'changed');
    await exec('git', ['-C', work, 'add', 'code.ts']);
    writeFileSync(path.join(work, 'brief.md'), 'handoff');
    writeFileSync(path.join(work, 'contract.yaml'), 'version: 1');
    writeFileSync(path.join(work, 'unrelated.txt'), 'retained');
    f.podRepo.update('prepare', { worktreePath: work });
    const real = new LocalWorktreeManager({
      logger: f.deps.logger,
      cacheDir: path.join(f.directory, 'cache'),
      worktreeDir: path.join(f.directory, 'worktrees'),
    });
    vi.mocked(f.worktreeManager.commitFiles).mockImplementation(real.commitFiles.bind(real));
    vi.mocked(f.worktreeManager.getCommitLog).mockImplementation(real.getCommitLog.bind(real));
    await expect(f.branchSync().syncWorkspaceBranch('prepare')).resolves.toEqual({
      committed: true,
      pushed: true,
    });
    expect(f.worktreeManager.commitFiles).toHaveBeenCalledWith(
      work,
      expect.arrayContaining(['brief.md', 'contract.yaml']),
      'chore: sync workspace for series handoff',
    );
    const committed = (
      await exec('git', ['-C', work, 'show', '--format=', '--name-only', 'HEAD'])
    ).stdout
      .trim()
      .split('\n')
      .sort();
    expect(committed).toEqual(['brief.md', 'contract.yaml']);
    expect((await exec('git', ['-C', work, 'diff', '--cached', '--name-only'])).stdout.trim()).toBe(
      'code.ts',
    );
    expect(f.worktreeManager.pushBranch).toHaveBeenCalledWith(work, 'branch', {
      pat: 'synthetic-git-key',
    });
    expect(f.cm.kill).not.toHaveBeenCalled();
    expect(f.worktreeManager.cleanup).not.toHaveBeenCalled();
  });
  it('does not publish or complete after failed sync and reports transport failure as a result', async () => {
    const f = createWorkspaceFixture();
    f.interactive();
    f.common.syncWorkspaceBack.mockRejectedValueOnce(new Error('Synthetic sync'));
    await expect(f.branchSync().syncWorkspaceBranch('prepare')).resolves.toMatchObject({
      committed: false,
      pushed: false,
      error: expect.stringContaining('retained'),
    });
    expect(f.worktreeManager.pushBranch).not.toHaveBeenCalled();
    expect(f.pod().status).toBe('running');
  });
});
