import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
const deploy = readFileSync(new URL('scripts/deploy-hosted-daemon.sh', root), 'utf8');

test('full and overlay hosted builds use the repository-pinned package manager', () => {
  assert.equal(manifest.packageManager, 'pnpm@9.15.4');
  const calls = [...deploy.matchAll(/npx --yes (pnpm(?:@[\d.]+)?) (install|build)/g)];
  assert.equal(calls.length, 3, 'full install/build and overlay build must all be covered');
  for (const [, manager] of calls) assert.equal(manager, manifest.packageManager);
  assert.match(deploy, /pnpm@9\.15\.4 install --frozen-lockfile/);
});
