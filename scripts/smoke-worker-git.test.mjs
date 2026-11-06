import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const smoke = path.join(root, 'scripts/smoke-worker-git.sh');
const imageId = `sha256:${'a'.repeat(64)}`;

function fixture(t, { inspectOutput = imageId, runExit = 0 } = {}) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'worker-git-smoke-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const log = path.join(directory, 'calls.jsonl');
  const docker = path.join(directory, 'docker');
  fs.writeFileSync(
    docker,
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] === 'image' && args[1] === 'inspect') {
  console.log(args.at(-1) === '{{.Id}}' ? ${JSON.stringify(inspectOutput)} : '${imageId} linux/amd64');
} else if (args[0] === 'run') {
  process.exit(${runExit});
} else { process.exit(99); }
`,
    { mode: 0o755 },
  );
  return {
    run: (args) =>
      spawnSync('bash', [smoke, ...args], {
        cwd: tmpdir(),
        encoding: 'utf8',
        env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
      }),
    calls: () =>
      fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [],
  };
}

test('Git image smoke resolves each tag once and checks immutable images offline', (t) => {
  const f = fixture(t);
  const result = f.run(['worker:first', 'worker:second']);
  assert.equal(result.status, 0, result.stderr);
  const calls = f.calls();
  assert.equal(calls.length, 6);
  for (let offset = 0; offset < calls.length; offset += 3) {
    assert.deepEqual(calls[offset], [
      'image',
      'inspect',
      offset === 0 ? 'worker:first' : 'worker:second',
      '--format',
      '{{.Id}}',
    ]);
    assert.equal(calls[offset + 1][2], imageId);
    const run = calls[offset + 2];
    assert.deepEqual(run.slice(0, 8), [
      'run',
      '--rm',
      '--pull=never',
      '--network',
      'none',
      '--entrypoint',
      'sh',
      '-e',
    ]);
    assert.match(run[8], /^EXPECTED_GIT_VERSION=\d+\.\d+\.\d+$/);
    assert.equal(run[9], imageId);
    const probe = run.at(-1);
    for (const required of [
      'test "$(id -u)" -ne 0',
      'autopod-check-git',
      'git-remote-https',
      'git config --system --get maintenance.auto',
      'git config --system --get gc.auto',
    ])
      assert.ok(probe.includes(required));
    assert.ok(!run.some((arg) => arg === '-v' || arg.startsWith('--mount')));
  }
});

test('Git image smoke propagates a failed capability check without trying later images', (t) => {
  const f = fixture(t, { runExit: 7 });
  assert.equal(f.run(['worker:first', 'worker:second']).status, 7);
  assert.equal(f.calls().length, 3);
});

test('Git image smoke rejects a nonimmutable inspected identity', (t) => {
  const f = fixture(t, { inspectOutput: 'worker:latest' });
  assert.equal(f.run(['worker:first']).status, 1, JSON.stringify(f.calls()));
  assert.equal(f.calls().length, 1);
});

test('Git image smoke requires explicit images and performs no Docker operations otherwise', (t) => {
  const f = fixture(t);
  const result = f.run([]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage:/);
  assert.deepEqual(f.calls(), []);
});
