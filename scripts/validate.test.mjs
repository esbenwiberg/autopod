import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const validationScript = readFileSync(new URL('./validate.sh', import.meta.url));

function runFixture(frozenExit, regularExit) {
  const root = mkdtempSync(join(tmpdir(), 'autopod-install-diagnostics-'));
  try {
    for (const name of ['scripts', 'bin', 'tmp']) mkdirSync(join(root, name));
    writeFileSync(join(root, 'scripts/validate.sh'), validationScript);
    writeFileSync(
      join(root, 'bin/npx'),
      `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$FIXTURE_CALLS"
if [ "$1" = pnpm ] && [ "$2" = install ]; then
  if [ "\u0024{3-}" = --frozen-lockfile ]; then
    echo FROZEN_ROOT_CAUSE >&2
    status="$FIXTURE_FROZEN_EXIT"
  else
    echo REGULAR_ROOT_CAUSE >&2
    status="$FIXTURE_REGULAR_EXIT"
  fi
  for number in {1..15}; do echo "trace line $number" >&2; done
  exit "$status"
fi
exit 0
`,
      { mode: 0o700 },
    );
    const callsPath = join(root, 'calls.txt');
    const result = spawnSync('bash', ['scripts/validate.sh'], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${join(root, 'bin')}:${process.env.PATH}`,
        TMPDIR: join(root, 'tmp'),
        FIXTURE_CALLS: callsPath,
        FIXTURE_FROZEN_EXIT: String(frozenExit),
        FIXTURE_REGULAR_EXIT: String(regularExit),
      },
      encoding: 'utf8',
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    return {
      status: result.status,
      output: result.stdout + result.stderr,
      calls: readFileSync(callsPath, 'utf8').trim().split('\n'),
      temporaryFiles: readdirSync(join(root, 'tmp')),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('failed frozen and fallback installs retain their causal diagnostics and terminal exit', () => {
  const result = runFixture(17, 42);
  assert.equal(result.status, 42);
  assert.match(result.output, /FROZEN_ROOT_CAUSE/);
  assert.match(result.output, /REGULAR_ROOT_CAUSE/);
  assert.deepEqual(result.calls, ['pnpm install --frozen-lockfile', 'pnpm install']);
  assert.doesNotMatch(result.output, /Linting|All checks passed/);
  assert.deepEqual(result.temporaryFiles, []);
});

test('successful fallback retains frozen failure diagnostics and still runs all required gates', () => {
  const result = runFixture(17, 0);
  assert.equal(result.status, 0);
  assert.match(result.output, /FROZEN_ROOT_CAUSE/);
  assert.match(result.output, /All checks passed/);
  assert.deepEqual(result.calls, [
    'pnpm install --frozen-lockfile',
    'pnpm install',
    'pnpm lint',
    'pnpm build',
    'pnpm typecheck',
    'pnpm test',
    'pnpm audit --audit-level high',
    'pnpm secret-scan',
  ]);
  assert.deepEqual(result.temporaryFiles, []);
});

test('successful frozen installs retain concise output and avoid fallback', () => {
  const result = runFixture(0, 42);
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.output, /FROZEN_ROOT_CAUSE|REGULAR_ROOT_CAUSE|trace line 1\n/);
  assert.match(result.output, /trace line 15/);
  assert.equal(result.calls.includes('pnpm install'), false);
  assert.match(result.output, /All checks passed/);
  assert.deepEqual(result.temporaryFiles, []);
});
