import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyArtifactSnapshot } from '../pods/artifact-snapshot-receipt.js';
import { prepareRetainedCheckpointWorkspace } from './retained-checkpoint-workspace.js';

const exec = promisify(execFile);
const roots: string[] = [];
const git = async (cwd: string, ...args: string[]) =>
  (
    await exec(
      'git',
      [
        '-c',
        'user.name=Recovery test',
        '-c',
        'user.email=recovery@example.test',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd },
    )
  ).stdout.trim();
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'checkpoint-recovery-'));
  roots.push(root);
  const source = path.join(root, 'original');
  await mkdir(source);
  await git(source, 'init', '--initial-branch=feature');
  await writeFile(path.join(source, 'app.txt'), 'retained implementation\n');
  await writeFile(path.join(source, '.gitignore'), 'reports/\n');
  await git(source, 'add', '.');
  await git(source, 'commit', '-m', 'retained source');
  await mkdir(path.join(source, 'reports'));
  await writeFile(
    path.join(source, 'reports', 'failed.xml'),
    '<failure>original evidence</failure>',
  );
  const head = await git(source, 'rev-parse', 'HEAD');
  const options = {
    source,
    root: path.join(root, 'recovery'),
    branch: 'feature',
    repository: 'https://example.test/owner/repository.git',
    head,
    generation: 1,
    cycle: 3,
    assertCurrent() {},
  };
  return { root, source, head, options };
}

describe('retained checkpoint workspace', () => {
  it('preserves ignored HOST reports and materializes source with independent refs/objects', async () => {
    const f = await fixture();
    await git(f.source, 'update-ref', 'refs/remotes/origin/ewi/azure-pod-desk', f.head);
    const prepared = await prepareRetainedCheckpointWorkspace(f.options);
    expect(await git(prepared.worktree, 'rev-parse', 'origin/ewi/azure-pod-desk')).toBe(f.head);
    await expect(
      git(prepared.worktree, 'config', '--get', 'remote.origin.mirror'),
    ).rejects.toThrow();
    expect(prepared.head).toBe(f.head);
    expect(await readFile(path.join(prepared.snapshot, 'reports', 'failed.xml'), 'utf8')).toContain(
      'original evidence',
    );
    await verifyArtifactSnapshot(prepared.snapshot, path.join(f.options.root, 'host'), 1, 3);
    await expect(readFile(path.join(prepared.worktree, 'reports', 'failed.xml'))).rejects.toThrow();
    await expect(
      readFile(path.join(prepared.bare, 'objects', 'info', 'alternates')),
    ).rejects.toThrow();
    expect(await git(prepared.worktree, 'remote', 'get-url', 'origin')).toBe(f.options.repository);
    await writeFile(path.join(prepared.worktree, 'app.txt'), 'new execution\n');
    await git(prepared.worktree, 'add', '.');
    await git(prepared.worktree, 'commit', '-m', 'isolated repair');
    expect(await git(f.source, 'rev-parse', 'HEAD')).toBe(f.head);
    expect(await readFile(path.join(f.source, 'app.txt'), 'utf8')).toBe(
      'retained implementation\n',
    );
    // New source remains usable without borrowing the original Git object store.
    await rm(f.source, { recursive: true });
    expect(await git(prepared.worktree, 'show', `${f.head}:app.txt`)).toBe(
      'retained implementation',
    );
  });

  it('ignores only generated evidence in the private clone, never tracked changes or unrelated source', async () => {
    const f = await fixture();
    const originalExclude = await readFile(path.join(f.source, '.git/info/exclude'), 'utf8');
    await mkdir(path.join(f.source, '.autopod/evidence'), { recursive: true });
    await writeFile(path.join(f.source, '.autopod/evidence/tracked.txt'), 'tracked original');
    await git(f.source, 'add', '.');
    await git(f.source, 'commit', '-m', 'tracked evidence remains source');
    f.options.head = await git(f.source, 'rev-parse', 'HEAD');
    const prepared = await prepareRetainedCheckpointWorkspace(f.options);
    for (const folder of ['evidence/fact', 'screenshots']) {
      await mkdir(path.join(prepared.worktree, '.autopod', folder), { recursive: true });
      await writeFile(
        path.join(prepared.worktree, '.autopod', folder, 'report.txt'),
        'fresh report',
      );
    }
    expect(await git(prepared.worktree, 'status', '--porcelain')).toBe('');
    expect(await readFile(path.join(f.source, '.git/info/exclude'), 'utf8')).toBe(originalExclude);
    await expect(
      git(f.source, 'check-ignore', '--no-index', '.autopod/evidence/fact/report.txt'),
    ).rejects.toMatchObject({ code: 1 });
    await writeFile(
      path.join(prepared.worktree, '.autopod/evidence/tracked.txt'),
      'changed source',
    );
    await writeFile(path.join(prepared.worktree, '.autopod/unexpected.ts'), 'unexpected source');
    const dirty = await git(prepared.worktree, 'status', '--porcelain', '--untracked-files=all');
    expect(dirty).toContain('M .autopod/evidence/tracked.txt');
    expect(dirty).toContain('?? .autopod/unexpected.ts');
  });

  it('refuses a different commit or dirty tracked source before preparing a namespace', async () => {
    const f = await fixture();
    await expect(
      prepareRetainedCheckpointWorkspace({ ...f.options, head: 'a'.repeat(40) }),
    ).rejects.toThrow('not the retained');
    await writeFile(path.join(f.source, 'app.txt'), 'uncommitted work');
    await expect(prepareRetainedCheckpointWorkspace(f.options)).rejects.toThrow('cleanliness');
  });

  it('refuses archive paths inside the original, including a symlinked parent', async () => {
    const f = await fixture();
    await expect(
      prepareRetainedCheckpointWorkspace({ ...f.options, root: path.join(f.source, 'archive') }),
    ).rejects.toThrow('disjoint');
    const alias = path.join(f.root, 'alias');
    await symlink(f.source, alias);
    await expect(
      prepareRetainedCheckpointWorkspace({ ...f.options, root: path.join(alias, 'archive') }),
    ).rejects.toThrow('disjoint');
    await expect(readFile(path.join(f.source, 'archive'))).rejects.toThrow();
  });

  it('never reuses an existing or response-lost preparation directory', async () => {
    const f = await fixture();
    await mkdir(f.options.root);
    await writeFile(path.join(f.options.root, 'prior-evidence'), 'retain');
    await expect(prepareRetainedCheckpointWorkspace(f.options)).rejects.toThrow('EEXIST');
    expect(await readFile(path.join(f.options.root, 'prior-evidence'), 'utf8')).toBe('retain');
  });

  it('rejects stored credential URLs and executable filters rather than copying them', async () => {
    const f = await fixture();
    await expect(
      prepareRetainedCheckpointWorkspace({
        ...f.options,
        repository: 'https://secret@example.test/repo',
      }),
    ).rejects.toThrow('credential-free');
    await git(f.source, 'config', 'filter.danger.clean', 'false');
    await expect(prepareRetainedCheckpointWorkspace(f.options)).rejects.toThrow('filters');
  });

  it('checks ownership after asynchronous Git observation, without changing original source', async () => {
    const f = await fixture();
    let checks = 0;
    await expect(
      prepareRetainedCheckpointWorkspace({
        ...f.options,
        assertCurrent() {
          if (++checks === 2) throw new Error('superseded');
        },
      }),
    ).rejects.toThrow('superseded');
    expect(await git(f.source, 'rev-parse', 'HEAD')).toBe(f.head);
    expect(await readFile(path.join(f.source, 'reports', 'failed.xml'), 'utf8')).toContain(
      'original evidence',
    );
  });
});
