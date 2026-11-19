// Fixed test workload, never a launcher for worker-provided commands.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const [key, pin] = process.argv.slice(2);
assert.equal(readFileSync('.git/HEAD', 'utf8').trim(), pin);
assert.equal(readFileSync('proof.txt', 'utf8'), 'unpublished checkpoint\n');
process.once('disconnect', () => process.exit(1));
process.once('message', (message) => {
  assert.equal(message, 'finish');
  const finding =
    key === 'worker-0'
      ? 'Issue: CLI retries'
      : key === 'worker-1'
        ? 'Issue: cache expiry'
        : 'Checks passed';
  mkdirSync('fixture-output', { mode: 0o700 });
  writeFileSync('fixture-output/report.md', `${finding}\n${'é'.repeat(1300)}hidden-tail`);
  writeFileSync('fixture-output/private.txt', 'sibling contents must not escape');
  process.exit(0);
});
process.send({ type: 'ready', pid: process.pid });
