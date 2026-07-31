import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createPublicationContext,
  createPublishPlan,
  discoverBaseTemplates,
  executePublishPlan,
} from './publish-base-images.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('publication-plan-covers-all-base-templates', async () => {
  const templates = discoverBaseTemplates(repoRoot);
  const dockerfiles = fs
    .readdirSync(path.join(repoRoot, 'templates', 'base'))
    .filter((name) => name.startsWith('Dockerfile.'))
    .sort();
  const plan = createPublishPlan({
    registry: 'example.azurecr.io',
    revision: 'abc123def456',
    templates: 'all',
    repoRoot,
  });

  assert.deepEqual(
    plan.map((entry) => entry.dockerfile),
    dockerfiles.map((name) => `templates/base/${name}`),
  );
  assert.equal(plan.length, templates.length);
  assert.equal(new Set(plan.map((entry) => entry.template)).size, templates.length);

  for (const entry of plan) {
    assert.equal(entry.repository, `autopod-${entry.template}`);
    assert.equal(entry.platform, 'linux/amd64');
    assert.ok(entry.buildArgs.includes('linux/amd64'));
    assert.ok(entry.buildArgs.includes(`${entry.repository}:abc123def456`));
    assert.ok(entry.buildArgs.includes(`${entry.repository}:latest`));
    assert.deepEqual(entry.verifyTags, [
      `${entry.repository}:abc123def456`,
      `${entry.repository}:latest`,
    ]);
  }

  let mutations = 0;
  const output = await executePublishPlan(plan, {
    dryRun: true,
    repoRoot,
    runAz: () => {
      mutations++;
      throw new Error('dry run attempted an Azure mutation');
    },
  });
  assert.equal(mutations, 0);
  assert.match(output, /az acr build/);
  assert.match(output, /--platform linux\/amd64/);
  assert.match(output, /az acr manifest show-metadata/);
});

test('publication accepts real Azure queue output without JSON', async () => {
  const [entry] = createPublishPlan({
    registry: 'example',
    revision: 'abc123',
    templates: ['node22'],
    repoRoot,
  });
  const digest = `sha256:${'a'.repeat(64)}`;
  const results = await executePublishPlan([entry], {
    repoRoot,
    pollIntervalMs: 0,
    runAz: (args) => {
      if (args[1] === 'build') return 'WARNING: Queued a build with ID: run-real\n';
      if (args[1] === 'task') {
        return JSON.stringify({
          runId: 'run-real',
          status: 'Succeeded',
          platform: { os: 'Linux', architecture: 'amd64' },
        });
      }
      if (args[1] === 'manifest') return `${digest}\n`;
      throw new Error(`unexpected az command: ${args.join(' ')}`);
    },
  });

  assert.deepEqual(results, [{ template: 'node22', digest, platform: 'linux/amd64' }]);
});

test('publication context exclusions keep required base inputs', () => {
  const marker = path.join(repoRoot, 'node_modules', '.autopod-base-context-test');
  fs.writeFileSync(marker, 'must not be uploaded');
  const context = createPublicationContext(repoRoot);

  try {
    assert.ok(!fs.existsSync(path.join(context.path, '.git')));
    assert.ok(!fs.existsSync(path.join(context.path, 'node_modules')));
    for (const required of [
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'tsconfig.base.json',
      'packages/pi-worker/package.json',
      'packages/pi-worker/tsconfig.json',
      'packages/pi-worker/src',
    ]) {
      assert.ok(fs.existsSync(path.join(context.path, required)), `${required} must be archived`);
    }
  } finally {
    context.cleanup();
    fs.rmSync(marker, { force: true });
  }
});

test('publication verifies completed run platform and matching manifests', async () => {
  const [entry] = createPublishPlan({
    registry: 'example',
    revision: 'abc123',
    templates: ['node22'],
    repoRoot,
  });
  const calls = [];
  const digest = `sha256:${'d'.repeat(64)}`;
  const results = await executePublishPlan([entry], {
    repoRoot,
    pollIntervalMs: 0,
    runAz: (args) => {
      calls.push(args);
      if (args[1] === 'build') return JSON.stringify({ runId: 'run-1' });
      if (args[1] === 'task') {
        return JSON.stringify({
          runId: 'run-1',
          status: 'Succeeded',
          platform: { os: 'Linux', architecture: 'amd64' },
        });
      }
      if (args[1] === 'manifest') return `${digest}\n`;
      throw new Error(`unexpected az command: ${args.join(' ')}`);
    },
  });

  assert.deepEqual(results, [{ template: 'node22', digest, platform: 'linux/amd64' }]);
  assert.ok(calls.some((args) => args.slice(0, 3).join(' ') === 'acr task show-run'));
  assert.equal(calls.filter((args) => args[1] === 'manifest').length, 2);
});

test('publication rejects an incompatible completed build platform', async () => {
  const [entry] = createPublishPlan({
    registry: 'example',
    revision: 'abc123',
    templates: ['node22'],
    repoRoot,
  });

  await assert.rejects(
    executePublishPlan([entry], {
      repoRoot,
      pollIntervalMs: 0,
      runAz: (args) =>
        args[1] === 'build'
          ? JSON.stringify({ runId: 'run-arm' })
          : JSON.stringify({
              runId: 'run-arm',
              status: 'Succeeded',
              platform: { os: 'Linux', architecture: 'arm64' },
            }),
    }),
    /expected linux\/amd64/,
  );
});

test('selected publication rejects duplicate and unknown templates', () => {
  assert.throws(
    () =>
      createPublishPlan({
        registry: 'example',
        revision: 'abc123',
        templates: ['node22', 'node22'],
        repoRoot,
      }),
    /Duplicate --template selection/,
  );
  assert.throws(
    () =>
      createPublishPlan({
        registry: 'example',
        revision: 'abc123',
        templates: ['missing'],
        repoRoot,
      }),
    /Unknown base template: missing/,
  );
});
