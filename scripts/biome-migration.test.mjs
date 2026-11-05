import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const binary = path.join(root, 'node_modules/.bin/biome');
const configText = await readFile(path.join(root, 'biome.json'), 'utf8');
const config = JSON.parse(configText);

test('Biome 2 migration keeps pinned tooling, rule intent and repository gate commands', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.devDependencies['@biomejs/biome'], '2.5.3');
  assert.equal(config.$schema, 'https://biomejs.dev/schemas/2.5.3/schema.json');
  assert.equal(config.linter.rules.preset, 'recommended');
  assert.equal(config.linter.rules.style.useConst, 'error');
  assert.equal(config.linter.rules.style.noNonNullAssertion, 'warn');
  assert.equal(config.linter.rules.suspicious.noExplicitAny, 'warn');
  assert.equal(config.assist.actions.source.organizeImports, 'on');
  assert.equal(config.files.maxSize, 2097152);
  assert.equal(manifest.scripts.lint, 'biome check .');
  assert.match(await readFile(path.join(root, '.githooks/pre-commit'), 'utf8'), /npx pnpm lint/);
  const version = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 15000 });
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /2\.5\.3/);
});

test('the installed binary checks maintained source and retains generated/cache exclusions', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'autopod-biome-policy-'));
  try {
    await writeFile(path.join(directory, 'biome.json'), configText);
    const sources = ['daemon', 'cli', 'shared', 'validator', 'escalation-mcp', 'mobile-web'].map(
      (name) => `packages/${name}/src/policy-probe.ts`,
    );
    const excluded = [
      'packages/daemon/dist/probe.ts',
      'node_modules/probe.ts',
      '.turbo/probe.ts',
      '.pnpm-store/probe.ts',
      '.autopod-data/probe.ts',
      '.agentry/probe.ts',
      '.claude/worktrees/probe.ts',
      '.clawpatch/features/probe.ts',
      '.clawpatch/findings/probe.ts',
      '.speclint-cache/probe.ts',
      'packages/desktop/.build/probe.ts',
      'packages/desktop/build/probe.ts',
      'packages/desktop/build-preview/probe.ts',
      'packages/desktop/Sources/AutopodUI/Resources/Village/renderer/probe.ts',
      'tmp/probe.ts',
    ];
    for (const relative of [...sources, ...excluded]) {
      const file = path.join(directory, relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, 'let probe = 1;\ndebugger;\n');
    }
    const check = spawnSync(binary, ['check', '--reporter=json', '--max-diagnostics=1000', '.'], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 2 * 1024 * 1024,
    });
    assert.equal(check.status, 1, check.stderr);
    const { diagnostics } = JSON.parse(check.stdout);
    const checked = new Set(diagnostics.map((item) => item.location.path));
    for (const source of sources) assert.ok(checked.has(source), `${source} must be checked`);
    for (const ignored of excluded)
      assert.ok(!checked.has(ignored), `${ignored} must stay excluded`);
    assert.ok(diagnostics.some((item) => item.category === 'lint/style/useConst'));
    assert.ok(diagnostics.some((item) => item.category === 'lint/suspicious/noDebugger'));
    const formatted = spawnSync(binary, ['format', '--stdin-file-path=probe.ts'], {
      cwd: directory,
      input: 'const quote = "value"',
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(formatted.status, 0, formatted.stderr);
    assert.equal(formatted.stdout, "const quote = 'value';\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
