import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RequiredFact } from '@autopod/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectContractBase } from './contract-base-preflight.js';
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'autopod-base-'));
  dirs.push(dir);
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Local test');
  git('config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(dir, 'existing.ts'), 'existing');
  git('add', '.');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', base);
  return { dir, git, base };
}
function fact(path: string, change: RequiredFact['artifact']['change']): RequiredFact {
  return {
    id: 'f1',
    proves: ['s1'],
    kind: 'custom-command',
    artifact: { path, change },
    command: 'node check.mjs',
  };
}
describe('fresh actual-base contract declarations', () => {
  it('checks immutable fetched base rather than existing agent work on the start branch', async () => {
    const { dir, git, base } = fixture();
    writeFileSync(join(dir, 'new.ts'), 'work from linked PR');
    git('add', '.');
    git('commit', '-qm', 'start branch');
    expect(
      await inspectContractBase(dir, 'main', [
        fact('new.ts', 'create'),
        fact('existing.ts', 'update'),
      ]),
    ).toEqual({
      baseCommitSha: base,
      artifacts: [
        { path: 'new.ts', exists: false },
        { path: 'existing.ts', exists: true },
      ],
    });
    await expect(
      inspectContractBase(dir, 'main', [fact('existing.ts', 'create')]),
    ).rejects.toMatchObject({ code: 'STALE_CONTRACT' });
    await expect(
      inspectContractBase(dir, 'main', [fact('missing.ts', 'update')]),
    ).rejects.toMatchObject({ code: 'STALE_CONTRACT' });
  });
  it('requires a delete target to exist in the actual base', async () => {
    const { dir } = fixture();
    await expect(
      inspectContractBase(dir, 'main', [fact('existing.ts', 'delete')]),
    ).resolves.toBeDefined();
    await expect(
      inspectContractBase(dir, 'main', [fact('missing.ts', 'delete')]),
    ).rejects.toMatchObject({ code: 'STALE_CONTRACT' });
  });

  it('refuses missing fetched base and pathspec or traversal expansion', async () => {
    const { dir } = fixture();
    await expect(
      inspectContractBase(dir, 'missing', [fact('existing.ts', 'touch')]),
    ).rejects.toThrow();
    for (const path of ['../existing.ts', ':(glob)*', '/tmp/source', 'a\nother'])
      await expect(inspectContractBase(dir, 'main', [fact(path, 'touch')])).rejects.toMatchObject({
        code: 'INVALID_CONTRACT_PATH',
      });
  });
  it('detects newly landed work only after the remote base advances', async () => {
    const { dir, git } = fixture();
    writeFileSync(join(dir, 'new.ts'), 'landed');
    git('add', '.');
    git('commit', '-qm', 'landed');
    await expect(
      inspectContractBase(dir, 'main', [fact('new.ts', 'create')]),
    ).resolves.toBeDefined();
    git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'));
    await expect(
      inspectContractBase(dir, 'main', [fact('new.ts', 'create')]),
    ).rejects.toMatchObject({ code: 'STALE_CONTRACT' });
  });
});
