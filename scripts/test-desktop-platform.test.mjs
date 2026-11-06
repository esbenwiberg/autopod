import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const script = path.resolve(import.meta.dirname, 'test-desktop.sh');
function run(platform, swiftExit = 0) {
  const root = mkdtempSync(path.join(tmpdir(), 'desktop-platform-'));
  const calls = path.join(root, 'calls');
  writeFileSync(path.join(root, 'uname'), `#!/bin/sh\nprintf '%s\\n' '${platform}'\n`, {
    mode: 0o755,
  });
  writeFileSync(
    path.join(root, 'swift'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "$CALLS"\nif [ "$4" = list ]; then printf 'AutopodClientTests.Suite.test\\n'; fi\nexit ${swiftExit}\n`,
    { mode: 0o755 },
  );
  try {
    const result = spawnSync('/bin/bash', [script], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${root}:/usr/bin:/bin`, CALLS: calls },
    });
    let invocations = '';
    try {
      invocations = readFileSync(calls, 'utf8');
    } catch {}
    return { ...result, invocations };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('Linux refuses native desktop tests before invoking Swift, without manufacturing a pass', () => {
  const result = run('Linux');
  assert.equal(result.status, 2);
  assert.equal(result.invocations, '');
  assert.match(result.stderr, /DEFERRED_NATIVE_CHECKS/);
  assert.match(result.stderr, /macOS/);
  assert.match(result.stderr, /not run/i);
});

test('unknown/non-Darwin hosts fail closed too', () => {
  const result = run('Unknown');
  assert.equal(result.status, 2);
  assert.equal(result.invocations, '');
});

test('Darwin still executes inventory and the target in separate Swift processes', () => {
  const result = run('Darwin');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.invocations.trim().split('\n').length, 2);
  assert.match(result.invocations, /--filter \^AutopodClientTests/);
});

test('a real native tool failure remains nonzero, never converted to a platform deferral', () => {
  const result = run('Darwin', 7);
  assert.equal(result.status, 7);
  assert.doesNotMatch(result.stderr, /DEFERRED_NATIVE_CHECKS/);
});
