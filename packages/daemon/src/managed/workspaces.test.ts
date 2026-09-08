import { execFileSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ManagedPodRequest } from '@autopod/shared';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { ManagedWorkspaces } from './workspaces.js';

it('provisions isolated source copies and preserves attempt work on restart without touching the enrolled mirror', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'managed-workspace-'));
  const mirror = path.join(root, 'mirror');
  const db = new Database(':memory:');
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  try {
    db.exec(
      readFileSync(new URL('../db/migrations/150_managed_workspaces.sql', import.meta.url), 'utf8'),
    );
    git(root, 'init', '-b', 'main', mirror);
    git(mirror, 'config', 'user.name', 'Fixture');
    git(mirror, 'config', 'user.email', 'fixture@example.invalid');
    writeFileSync(path.join(mirror, 'answer.txt'), 'base\n');
    git(mirror, 'add', '.');
    git(mirror, 'commit', '-m', 'base');
    const base = git(mirror, 'rev-parse', 'HEAD');
    const request = JSON.parse(
      readFileSync(
        new URL('../../../../specs/managed-pod/v1/examples.json', import.meta.url),
        'utf8',
      ),
    ).ManagedPodRequest as ManagedPodRequest;
    const scope = request.effectiveGrant.scope.repositories[0]!;
    scope.baseRevision = base;
    scope.access = 'write';
    const mirrors = [
      { enrollmentId: scope.enrollmentId, path: mirror, remote: scope.remote, baseRevision: base },
    ];
    const manager = () => new ManagedWorkspaces(db, path.join(root, 'attempts'), mirrors);
    const volumes = await manager().prepare('managed-one', request);
    const work = volumes[0]!.host;
    expect(lstatSync(path.join(work, '.git')).isDirectory()).toBe(true);
    expect(git(work, 'remote')).toBe('');
    writeFileSync(path.join(work, 'answer.txt'), 'changed\n');
    expect(await manager().prepare('managed-one', request)).toEqual(volumes);
    expect(readFileSync(path.join(work, 'answer.txt'), 'utf8')).toBe('changed\n');
    expect(readFileSync(path.join(mirror, 'answer.txt'), 'utf8')).toBe('base\n');
    expect(git(mirror, 'status', '--porcelain')).toBe('');
    await expect(
      manager().prepare('managed-one', {
        ...request,
        executionSpecDigest: `sha256:${'f'.repeat(64)}`,
      }),
    ).rejects.toThrow('immutable-conflict');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
