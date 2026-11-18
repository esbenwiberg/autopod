import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function exactFingerprint(value) {
  const fields = value.split(':');
  if (fields.length !== 4) return false;
  const [commit, path, rule, line] = fields;
  return (
    /^[a-f0-9]{40}$/.test(commit) &&
    path.length > 0 &&
    ![...'*?[]{}\\'].some((character) => path.includes(character)) &&
    /^[a-z0-9-]+$/.test(rule) &&
    /^[1-9]\d*$/.test(line)
  );
}

test('secret-scan exceptions stay pinned to exact historical findings, never whole paths or rules', () => {
  const lines = readFileSync(new URL('../.gitleaksignore', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  assert.ok(lines.length > 0);
  for (const line of lines)
    assert.ok(exactFingerprint(line), `Unbounded secret-scan exception: ${line}`);
  assert.equal(new Set(lines).size, lines.length, 'Duplicate fingerprint hides an audit mistake');
});

test('file-wide, rule-wide and wildcard exclusions do not satisfy the historical exception contract', () => {
  for (const value of [
    '*.test.ts',
    'generic-api-key',
    `${'a'.repeat(40)}:packages/**:generic-api-key:1`,
    `${'a'.repeat(40)}:fixture.test.ts:generic-api-key:*`,
    `${'a'.repeat(40)}:fixture.test.ts:generic-api-key:0`,
  ])
    assert.equal(exactFingerprint(value), false, value);
});
