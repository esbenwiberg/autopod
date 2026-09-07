import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { RETRY_IDENTITY_PROBE } from './retry-identity.js';

it('uses actual tracked and untracked content; unchanged commits and hidden index changes cannot fool identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'retry-input-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  const capture = () =>
    JSON.parse(
      execFileSync(process.execPath, ['-e', RETRY_IDENTITY_PROBE], { cwd: root, encoding: 'utf8' }),
    ).source;
  try {
    git('init', '-q');
    writeFileSync(join(root, 'source.ts'), 'const value = 1;');
    git('add', '.');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'initial',
    );
    const initial = capture();
    expect(initial).toMatch(/^[a-f0-9]{64}$/);
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--allow-empty',
      '-qm',
      'same content',
    );
    expect(capture()).toBe(initial);
    git('update-index', '--assume-unchanged', 'source.ts');
    writeFileSync(join(root, 'source.ts'), 'const value = 2;');
    expect(capture()).not.toBe(initial);
    writeFileSync(join(root, 'source.ts'), 'const value = 1;');
    expect(capture()).toBe(initial);
    writeFileSync(join(root, 'new.ts'), 'const newValue = 1;');
    expect(capture()).not.toBe(initial);
    rmSync(join(root, 'new.ts'));
    rmSync(join(root, 'source.ts'));
    expect(capture()).not.toBe(initial);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
