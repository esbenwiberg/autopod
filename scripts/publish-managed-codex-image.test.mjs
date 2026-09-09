import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createManagedImagePlan, publishManagedImage } from './publish-managed-codex-image.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const revision = '13790f366fadcac851da0d36390d393d7dea6f62';

test('managed portfolio image is Codex-only and bakes the exact dependency tree', () => {
  const dockerfile = fs.readFileSync(
    path.join(root, 'templates/managed/Dockerfile.codex-portfolio'),
    'utf8',
  );
  assert.match(dockerfile, /@openai\/codex@\$\{CODEX_VERSION\}/);
  assert.match(dockerfile, /git fetch --quiet --depth 1 source "\$\{BASE_REVISION\}"/);
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

test('publication accepts queue text and returns the immutable manifest', async () => {
  const plan = createManagedImagePlan({
    registry: 'ewiautopodacr',
    repositoryUrl: 'https://github.com/context-and/portfolio-simulation',
    baseRevision: revision,
    tag: 'dispatcher-voice-13790f366fad',
  });
  const digest = `sha256:${'d'.repeat(64)}`;
  const result = await publishManagedImage(plan, {
    pollIntervalMs: 0,
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
  assert.equal(result.baseRevision, revision);
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
