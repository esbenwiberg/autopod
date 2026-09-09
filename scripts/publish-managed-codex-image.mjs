#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCKERFILE = 'templates/managed/Dockerfile.codex-portfolio';
const TERMINAL = new Set(['succeeded', 'failed', 'canceled', 'error', 'timeout']);

export function createManagedImagePlan({ registry, repositoryUrl, baseRevision, tag }) {
  if (typeof registry !== 'string') throw new Error('invalid registry');
  const normalized = registry
    .trim()
    .toLowerCase()
    .replace(/\.azurecr\.io$/, '');
  if (!/^[a-z0-9][a-z0-9-]{3,48}[a-z0-9]$/.test(normalized)) throw new Error('invalid registry');
  if (
    typeof repositoryUrl !== 'string' ||
    !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repositoryUrl)
  )
    throw new Error('invalid repository URL');
  if (typeof baseRevision !== 'string' || !/^[a-f0-9]{40}$/.test(baseRevision))
    throw new Error('invalid base revision');
  if (
    typeof tag !== 'string' ||
    !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag) ||
    tag === 'latest'
  )
    throw new Error('invalid immutable tag');
  const repository = 'autopod/managed-codex-portfolio';
  return {
    registry: normalized,
    loginServer: `${normalized}.azurecr.io`,
    repository,
    repositoryUrl,
    baseRevision,
    tag,
    image: `${normalized}.azurecr.io/${repository}:${tag}`,
  };
}

export async function publishManagedImage(
  plan,
  { dryRun = false, runAz = defaultRunAz, pollIntervalMs = 5000, timeoutMs = 60 * 60 * 1000 } = {},
) {
  const buildArgs = [
    'acr',
    'build',
    '--registry',
    plan.registry,
    '--file',
    'Dockerfile',
    '--platform',
    'linux/amd64',
    '--image',
    `${plan.repository}:${plan.tag}`,
    '--build-arg',
    `REPOSITORY_URL=${plan.repositoryUrl}`,
    '--build-arg',
    `BASE_REVISION=${plan.baseRevision}`,
    '--no-logs',
    '--no-wait',
    '--output',
    'json',
    '.',
  ];
  if (dryRun) return { status: 'prepared-not-published', image: plan.image, buildArgs };

  const context = fs.mkdtempSync(path.join(tmpdir(), 'autopod-managed-image-'));
  try {
    fs.copyFileSync(path.join(ROOT, DOCKERFILE), path.join(context, 'Dockerfile'));
    const queued = parseQueued(runAz(buildArgs, context));
    const runId =
      queued.runId ??
      queued.name ??
      String(queued.id ?? '')
        .split('/')
        .at(-1);
    if (!runId) throw new Error('ACR build did not return a run ID');
    const started = Date.now();
    let run;
    for (;;) {
      run = JSON.parse(
        runAz(
          [
            'acr',
            'task',
            'show-run',
            '--registry',
            plan.registry,
            '--run-id',
            runId,
            '--output',
            'json',
          ],
          ROOT,
        ),
      );
      if (TERMINAL.has(String(run.status).toLowerCase())) break;
      if (Date.now() - started >= timeoutMs)
        throw new Error(`timed out waiting for ACR run ${runId}`);
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    if (
      String(run.status).toLowerCase() !== 'succeeded' ||
      String(run.platform?.os).toLowerCase() !== 'linux' ||
      String(run.platform?.architecture).toLowerCase() !== 'amd64'
    )
      throw new Error(`incompatible ACR build ${runId}: ${run.status ?? 'unknown'}`);
    const digest = runAz(
      [
        'acr',
        'manifest',
        'show-metadata',
        '--registry',
        plan.registry,
        '--name',
        `${plan.repository}:${plan.tag}`,
        '--query',
        'digest',
        '--output',
        'tsv',
      ],
      ROOT,
    ).trim();
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error('invalid published manifest digest');
    return {
      status: 'published',
      runId,
      platform: 'linux/amd64',
      baseRevision: plan.baseRevision,
      image: `${plan.loginServer}/${plan.repository}@${digest}`,
    };
  } finally {
    fs.rmSync(context, { recursive: true, force: true });
  }
}

function defaultRunAz(args, cwd) {
  const result = spawnSync('az', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`az ${args.slice(0, 3).join(' ')} failed: ${result.stderr.trim()}`);
  if (args[0] === 'acr' && args[1] === 'build' && !result.stdout.trim()) return result.stderr;
  return result.stdout;
}

function parseQueued(value) {
  try {
    return JSON.parse(value);
  } catch {
    const runId = /Queued a build with ID:\s*([A-Za-z0-9-]+)/i.exec(value)?.[1];
    if (!runId) throw new Error('az acr build did not return JSON or a queued build ID');
    return { runId };
  }
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    if (name === '--dry-run') args.dryRun = true;
    else if (name === '--registry') args.registry = argv[++i];
    else if (name === '--repository-url') args.repositoryUrl = argv[++i];
    else if (name === '--base-revision') args.baseRevision = argv[++i];
    else if (name === '--tag') args.tag = argv[++i];
    else throw new Error(`unknown argument: ${name}`);
  }
  return args;
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const plan = createManagedImagePlan(args);
  publishManagedImage(plan, { dryRun: args.dryRun }).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
