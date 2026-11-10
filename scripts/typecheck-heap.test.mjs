import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const daemon = JSON.parse(
  readFileSync(new URL('../packages/daemon/package.json', import.meta.url), 'utf8'),
);
const declarations = ['build', 'typecheck'];

function probe(command, nodeOptions, exitCode = 0, worker = false) {
  const directory = mkdtempSync(join(tmpdir(), 'autopod-declaration-heap-'));
  const env = {
    ...process.env,
    PATH: `${directory}:${process.env.PATH}`,
    FIXTURE_EXIT: String(exitCode),
    NODE_OPTIONS: nodeOptions,
    AUTOPOD_TYPECHECK: undefined,
    FIXTURE_NODE: process.execPath,
    FIXTURE_WORKER: join(directory, 'worker.cjs'),
  };
  try {
    // Exercise the actual package scripts; keep the expensive compiler separate.
    writeFileSync(
      join(directory, 'tsup'),
      worker
        ? '#!/bin/sh\nexec "$FIXTURE_NODE" "$FIXTURE_WORKER"\n'
        : '#!/bin/sh\nprintf "%s\\n" "$NODE_OPTIONS" "$AUTOPOD_TYPECHECK" "$@"\nexit "$FIXTURE_EXIT"\n',
      { mode: 0o755 },
    );
    if (worker) {
      writeFileSync(
        env.FIXTURE_WORKER,
        `const { Worker } = require('node:worker_threads');
const limit = () => require('node:v8').getHeapStatistics().heap_size_limit;
const child = new Worker(
  "require('node:worker_threads').parentPort.postMessage(require('node:v8').getHeapStatistics().heap_size_limit)",
  { eval: true },
);
child.once('message', worker => console.log(JSON.stringify({ main: limit(), worker })));
child.once('error', error => { console.error(error); process.exitCode = 1; });
`,
      );
    }
    return spawnSync('sh', ['-c', daemon.scripts[command]], {
      env,
      encoding: 'utf8',
      timeout: 10_000,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const command of declarations) {
  const defaultHeapMiB = command === 'typecheck' ? 6144 : 4096;
  for (const supplied of [undefined, '']) {
    test(`declaration ${command} defaults to a bounded ${defaultHeapMiB / 1024} GiB heap when NODE_OPTIONS is ${supplied === undefined ? 'absent' : 'empty'}`, () => {
      const result = probe(command, supplied);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(result.stdout.split('\n').slice(0, -1), [
        `--max-old-space-size=${defaultHeapMiB}`,
        ...(command === 'typecheck' ? ['1', '--dts-only', '--out-dir', '.turbo/typecheck'] : ['']),
      ]);
    });
  }

  for (const supplied of [
    '--max-old-space-size=2048',
    '--enable-source-maps --max_old_space_size=3072',
    '--enable-source-maps',
  ]) {
    test(`declaration ${command} preserves caller NODE_OPTIONS: ${supplied}`, () => {
      const result = probe(command, supplied);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.split('\n')[0], supplied);
    });
  }

  test(`declaration compiler failure remains a failed ${command}`, () => {
    assert.equal(probe(command, undefined, 23).status, 23);
  });

  test(`declaration ${command} passes its heap bound to a real Node worker`, () => {
    const result = probe(command, undefined, 0, true);
    assert.equal(result.status, 0, result.stderr);
    const limits = JSON.parse(result.stdout);
    assert.ok(limits.main >= defaultHeapMiB * 1024 * 1024, JSON.stringify(limits));
    // V8 adds a bounded young-generation allowance above the old-space limit.
    assert.ok(limits.main <= (defaultHeapMiB + 512) * 1024 * 1024, JSON.stringify(limits));
    assert.equal(limits.worker, limits.main);
  });
}

test('the heap default is confined to daemon declaration build and typecheck', () => {
  for (const [name, command] of Object.entries(daemon.scripts)) {
    if (!declarations.includes(name)) assert.ok(!command.includes('max-old-space-size'), name);
  }
  const root = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(root.scripts.typecheck, 'turbo run typecheck');
  assert.equal(root.scripts.build, 'turbo run build');
});
