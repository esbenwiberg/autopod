import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const daemon = JSON.parse(
  readFileSync(new URL('../packages/daemon/package.json', import.meta.url), 'utf8'),
);
const script = daemon.scripts.typecheck;

function probe(nodeOptions, exitCode = 0) {
  const directory = mkdtempSync(join(tmpdir(), 'autopod-typecheck-heap-'));
  const env = {
    ...process.env,
    PATH: `${directory}:${process.env.PATH}`,
    FIXTURE_EXIT: String(exitCode),
    NODE_OPTIONS: nodeOptions,
  };
  try {
    // Exercise the actual package script without loading tsup or compiling twice.
    writeFileSync(
      join(directory, 'tsup'),
      '#!/bin/sh\nprintf "%s\\n" "$NODE_OPTIONS" "$AUTOPOD_TYPECHECK" "$@"\nexit "$FIXTURE_EXIT"\n',
      { mode: 0o755 },
    );
    return spawnSync('sh', ['-c', script], { env, encoding: 'utf8' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const supplied of [undefined, '']) {
  test(`full declaration typecheck defaults to a bounded 4 GiB heap when NODE_OPTIONS is ${supplied === undefined ? 'absent' : 'empty'}`, () => {
    const result = probe(supplied);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trimEnd().split('\n'), [
      '--max-old-space-size=4096',
      '1',
      '--dts-only',
      '--out-dir',
      '.turbo/typecheck',
    ]);
  });
}

for (const supplied of [
  '--max-old-space-size=2048',
  '--enable-source-maps --max_old_space_size=3072',
  '--enable-source-maps',
]) {
  test(`full declaration typecheck preserves caller NODE_OPTIONS: ${supplied}`, () => {
    const result = probe(supplied);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.split('\n')[0], supplied);
  });
}

test('declaration compiler failure remains a failed typecheck', () => {
  assert.equal(probe(undefined, 23).status, 23);
});

test('the heap default is confined to the extended daemon typecheck', () => {
  for (const [name, command] of Object.entries(daemon.scripts)) {
    if (name !== 'typecheck') assert.ok(!command.includes('max-old-space-size'), name);
  }
  const root = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(root.scripts.typecheck, 'turbo run typecheck');
});
