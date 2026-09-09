import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createManagedImagePlan,
  prepareSourceArchive,
  publishManagedImage,
} from './publish-managed-codex-image.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const revision = '13790f366fadcac851da0d36390d393d7dea6f62';

test('managed portfolio image is Codex-only and bakes the exact dependency tree', () => {
  const dockerfile = fs.readFileSync(
    path.join(root, 'templates/managed/Dockerfile.codex-portfolio'),
    'utf8',
  );
  assert.match(dockerfile, /@openai\/codex@\$\{CODEX_VERSION\}/);
  assert.match(dockerfile, /ADD source.tar/);
  assert.doesNotMatch(dockerfile, /git fetch/);
  assert.match(dockerfile, /npm ci/);
  assert.match(dockerfile, /\/opt\/autopod-managed\/portfolio-simulation/);
  assert.doesNotMatch(dockerfile, /anthropic-ai|github\/copilot|pi-coding-agent/i);
});

test('dry run binds exact repository, revision, platform, and immutable tag without mutation', async () => {
  const plan = createManagedImagePlan({
    registry: 'ewiautopodacr.azurecr.io',
    repositoryUrl: 'https://github.com/context-and/portfolio-simulation',
    baseRevision: revision,
    tag: 'dispatcher-voice-13790f366fad',
  });
  let mutations = 0;
  const result = await publishManagedImage(plan, {
    dryRun: true,
    runAz: () => {
      mutations++;
      return '';
    },
  });
  assert.equal(mutations, 0);
  assert.equal(result.status, 'prepared-not-published');
  assert.ok(result.buildArgs.includes('linux/amd64'));
  assert.ok(result.buildArgs.includes(`BASE_REVISION=${revision}`));
  assert.ok(
    result.buildArgs.includes('autopod/managed-codex-portfolio:dispatcher-voice-13790f366fad'),
  );
});

test('publication accepts queue text and returns the immutable manifest', async (t) => {
  const fixture = sourceFixture(t);
  const plan = createManagedImagePlan({
    registry: 'ewiautopodacr',
    repositoryUrl: 'https://github.com/context-and/portfolio-simulation',
    baseRevision: revision,
    tag: 'dispatcher-voice-13790f366fad',
  });
  plan.baseRevision = fixture.revision;
  const digest = `sha256:${'d'.repeat(64)}`;
  const result = await publishManagedImage(plan, {
    pollIntervalMs: 0,
    sourceRepository: fixture.path,
    runAz: (args) => {
      if (args[1] === 'build') return 'Queued a build with ID: managed-1\n';
      if (args[1] === 'task')
        return JSON.stringify({
          status: 'Succeeded',
          platform: { os: 'Linux', architecture: 'amd64' },
        });
      if (args[1] === 'manifest') return `${digest}\n`;
      throw new Error(`unexpected az command ${args.join(' ')}`);
    },
  });
  assert.equal(result.image, `ewiautopodacr.azurecr.io/autopod/managed-codex-portfolio@${digest}`);
  assert.equal(result.baseRevision, fixture.revision);
});

test('publication rejects mutable tags and unpinned repository revisions', () => {
  for (const changed of [
    { registry: undefined, tag: 'immutable', baseRevision: revision },
    { tag: 'latest', baseRevision: revision },
    { tag: 'immutable', baseRevision: 'main' },
  ]) {
    assert.throws(() =>
      createManagedImagePlan({
        registry: 'registry' in changed ? changed.registry : 'ewiautopodacr',
        repositoryUrl: 'https://github.com/context-and/portfolio-simulation',
        ...changed,
      }),
    );
  }
});

function sourceFixture(t) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'managed-source-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '--quiet');
  git('remote', 'add', 'origin', 'https://github.com/context-and/portfolio-simulation');
  fs.writeFileSync(path.join(directory, 'tracked.txt'), 'committed source');
  git('add', 'tracked.txt');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'fixture',
  );
  const revision = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(directory, 'tracked.txt'), 'dirty source');
  fs.writeFileSync(path.join(directory, '.env'), 'UNTRACKED_SECRET=fixture');
  return { path: directory, revision };
}

test('source archive excludes dirty files, untracked credentials, and git configuration', (t) => {
  const fixture = sourceFixture(t);
  const context = fs.mkdtempSync(path.join(tmpdir(), 'managed-context-test-'));
  t.after(() => fs.rmSync(context, { recursive: true, force: true }));
  const plan = {
    repositoryUrl: 'https://github.com/context-and/portfolio-simulation',
    baseRevision: fixture.revision,
  };
  prepareSourceArchive(plan, fixture.path, context);
  const archive = path.join(context, 'source.tar');
  assert.equal(
    spawnSync('tar', ['-tf', archive], { encoding: 'utf8' }).stdout.trim(),
    'tracked.txt',
  );
  assert.equal(
    spawnSync('tar', ['-xOf', archive, 'tracked.txt'], { encoding: 'utf8' }).stdout,
    'committed source',
  );
  assert.throws(
    () =>
      prepareSourceArchive(
        { ...plan, repositoryUrl: 'https://github.com/wrong/repo' },
        fixture.path,
        context,
      ),
    /origin mismatch/,
  );
  assert.throws(
    () => prepareSourceArchive({ ...plan, baseRevision: '0'.repeat(40) }, fixture.path, context),
    /validation failed/,
  );
});
