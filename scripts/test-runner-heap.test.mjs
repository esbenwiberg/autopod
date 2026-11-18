import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const command = JSON.parse(
  readFileSync(new URL('../packages/daemon/package.json', import.meta.url), 'utf8'),
).scripts.test;

function probe(options, { exitCode = 0, realFork = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'autopod-test-heap-'));
  try {
    writeFileSync(
      join(root, 'vitest'),
      realFork
        ? '#!/bin/sh\nexec "$FIXTURE_NODE" "$FIXTURE_PARENT" "$@"\n'
        : '#!/bin/sh\nprintf "%s\\n" "$NODE_OPTIONS" "$@"\nexit "$FIXTURE_EXIT"\n',
      { mode: 0o755 },
    );
    writeFileSync(
      join(root, 'child.cjs'),
      'process.send(require("node:v8").getHeapStatistics().heap_size_limit);\n',
    );
    writeFileSync(
      join(root, 'parent.cjs'),
      `
const child = require('node:child_process').fork(${JSON.stringify(join(root, 'child.cjs'))}, [], { stdio: ['ignore','ignore','inherit','ipc'] });
child.on('message', worker => console.log(JSON.stringify({ main: require('node:v8').getHeapStatistics().heap_size_limit, worker })));
child.on('error', error => { throw error; });
child.on('exit', code => { process.exitCode = code; });
`,
    );
    return spawnSync('sh', ['-c', command], {
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        NODE_OPTIONS: options,
        FIXTURE_EXIT: String(exitCode),
        FIXTURE_NODE: process.execPath,
        FIXTURE_PARENT: join(root, 'parent.cjs'),
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const options of [undefined, '']) {
  test(`test runner defaults to bounded 4 GiB old space when options are ${options === undefined ? 'absent' : 'empty'}`, () => {
    const result = probe(options);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '--max-old-space-size=4096\nrun\n');
  });
}
for (const options of [
  '--max-old-space-size=2048',
  '--enable-source-maps --max_old_space_size=3072',
  '--enable-source-maps',
]) {
  test(`test runner preserves explicit caller options: ${options}`, () => {
    const result = probe(options);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${options}\nrun\n`);
  });
}
test('a test-runner failure is still a failed required gate', () => {
  assert.equal(probe(undefined, { exitCode: 23 }).status, 23);
});
test('the actual script propagates its heap bound to a real Node test-worker fork', () => {
  const result = probe(undefined, { realFork: true });
  assert.equal(result.status, 0, result.stderr);
  const limits = JSON.parse(result.stdout);
  assert.ok(limits.main >= 4096 * 1024 * 1024, result.stdout);
  assert.ok(limits.main <= 4608 * 1024 * 1024, result.stdout);
  assert.equal(limits.worker, limits.main);
});
