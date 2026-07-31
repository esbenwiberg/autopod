#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const TERMINAL_RUN_STATUSES = new Set(['succeeded', 'failed', 'canceled', 'error', 'timeout']);

export function discoverBaseTemplates(repoRoot = DEFAULT_REPO_ROOT) {
  const templateDir = path.join(repoRoot, 'templates', 'base');
  return fs
    .readdirSync(templateDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith('Dockerfile.'))
    .map((entry) => entry.name.slice('Dockerfile.'.length))
    .sort();
}

export function createPublishPlan({
  registry,
  revision,
  templates = 'all',
  repoRoot = DEFAULT_REPO_ROOT,
}) {
  const registryInfo = parseRegistry(registry);
  const available = discoverBaseTemplates(repoRoot);
  const selected = selectTemplates(available, templates);
  validateTag(revision, 'revision');

  return selected.map((template) => {
    const repository = `autopod-${template}`;
    const dockerfile = `templates/base/Dockerfile.${template}`;
    const revisionTag = `${repository}:${revision}`;
    const latestTag = `${repository}:latest`;
    return {
      template,
      repository,
      dockerfile,
      platform: 'linux/amd64',
      revision,
      revisionRef: `${registryInfo.loginServer}/${revisionTag}`,
      latestRef: `${registryInfo.loginServer}/${latestTag}`,
      buildArgs: [
        'acr',
        'build',
        '--registry',
        registryInfo.name,
        '--file',
        dockerfile,
        '--platform',
        'linux/amd64',
        '--image',
        revisionTag,
        '--image',
        latestTag,
        '--no-logs',
        '--no-wait',
        '--output',
        'json',
        '.',
      ],
      verifyTags: [revisionTag, latestTag],
      registry: registryInfo,
    };
  });
}

export async function executePublishPlan(
  plan,
  {
    dryRun = false,
    repoRoot = DEFAULT_REPO_ROOT,
    runAz = defaultRunAz,
    pollIntervalMs = 5000,
    timeoutMs = 60 * 60 * 1000,
  } = {},
) {
  if (dryRun) return formatPublishPlan(plan);

  const results = [];
  for (const entry of plan) {
    process.stdout.write(`\n==> building ${entry.template} (${entry.platform})\n`);
    const queued = parseQueuedBuild(runAz(entry.buildArgs, repoRoot));
    const runId = queued.runId ?? queued.name ?? idSuffix(queued.id);
    if (typeof runId !== 'string' || !runId) {
      throw new Error(`ACR build for ${entry.template} did not return a run ID`);
    }

    const run = await waitForRun({
      registry: entry.registry.name,
      runId,
      repoRoot,
      runAz,
      pollIntervalMs,
      timeoutMs,
    });
    verifyRun(entry, run);

    const digests = entry.verifyTags.map((tag) =>
      runAz(
        [
          'acr',
          'manifest',
          'show-metadata',
          '--registry',
          entry.registry.name,
          '--name',
          tag,
          '--query',
          'digest',
          '--output',
          'tsv',
        ],
        repoRoot,
      ).trim(),
    );
    if (digests.some((digest) => !/^sha256:[a-f0-9]{64}$/i.test(digest))) {
      throw new Error(`ACR manifest verification returned an invalid digest for ${entry.template}`);
    }
    if (new Set(digests).size !== 1) {
      throw new Error(`Immutable and latest tags do not match for ${entry.template}`);
    }

    const [digest] = digests;
    process.stdout.write(`published ${entry.latestRef}@${digest}\n`);
    results.push({ template: entry.template, digest, platform: entry.platform });
  }
  return results;
}

export function formatPublishPlan(plan) {
  return plan
    .map((entry) => {
      const build = ['az', ...entry.buildArgs].map(shellQuote).join(' ');
      const verify = entry.verifyTags
        .map(
          (tag) =>
            `az acr manifest show-metadata --registry ${shellQuote(entry.registry.name)} ` +
            `--name ${shellQuote(tag)} --query digest --output tsv`,
        )
        .join('\n');
      return `# ${entry.template} -> ${entry.latestRef}\n${build}\n${verify}`;
    })
    .join('\n\n');
}

function parseArgs(argv) {
  const options = { templates: [] };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--registry') options.registry = requireValue(argv, ++index, arg);
    else if (arg === '--revision') options.revision = requireValue(argv, ++index, arg);
    else if (arg === '--template') options.templates.push(requireValue(argv, ++index, arg));
    else if (arg === '--all') options.all = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.all && options.templates.length > 0) {
    throw new Error('Use either --all or --template, not both');
  }
  return options;
}

function parseRegistry(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('ACR registry is required');
  const normalized = value.trim().toLowerCase();
  if (normalized.includes('://') || normalized.includes('/') || normalized.includes(':')) {
    throw new Error('Registry must be an ACR name or login server without scheme, path, or port');
  }
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(normalized)) {
    throw new Error(`Invalid ACR registry: ${value}`);
  }
  if (normalized.endsWith('.azurecr.io')) {
    return { name: normalized.slice(0, -'.azurecr.io'.length), loginServer: normalized };
  }
  if (normalized.includes('.')) {
    throw new Error(`Unsupported ACR login server: ${value}`);
  }
  return { name: normalized, loginServer: `${normalized}.azurecr.io` };
}

function selectTemplates(available, templates) {
  if (templates === 'all') return [...available];
  if (!Array.isArray(templates) || templates.length === 0) {
    throw new Error('Select --all or at least one --template');
  }
  const unique = [...new Set(templates)].sort();
  if (unique.length !== templates.length) throw new Error('Duplicate --template selection');
  for (const template of unique) {
    if (!available.includes(template)) throw new Error(`Unknown base template: ${template}`);
  }
  return unique;
}

function validateTag(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(value)) {
    throw new Error(`Invalid ${label} image tag: ${value}`);
  }
}

async function waitForRun({ registry, runId, repoRoot, runAz, pollIntervalMs, timeoutMs }) {
  const startedAt = Date.now();
  for (;;) {
    const run = parseJson(
      runAz(
        ['acr', 'task', 'show-run', '--registry', registry, '--run-id', runId, '--output', 'json'],
        repoRoot,
      ),
      'az acr task show-run',
    );
    const status = String(run.status ?? '').toLowerCase();
    if (TERMINAL_RUN_STATUSES.has(status)) return run;
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Timed out waiting for ACR run ${runId}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

function verifyRun(entry, run) {
  if (String(run.status).toLowerCase() !== 'succeeded') {
    throw new Error(`ACR build ${run.runId ?? run.name ?? ''} ended with status ${run.status}`);
  }
  const os = String(run.platform?.os ?? '').toLowerCase();
  const architecture = String(run.platform?.architecture ?? '').toLowerCase();
  if (os !== 'linux' || architecture !== 'amd64') {
    throw new Error(
      `ACR built ${entry.template} for ${os || 'unknown'}/${architecture || 'unknown'}, expected linux/amd64`,
    );
  }
}

function defaultRunAz(args, cwd) {
  const result = spawnSync('az', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = result.stderr.trim().split('\n').at(-1);
    throw new Error(
      `az ${args.join(' ')} failed with exit code ${result.status}${detail ? `: ${detail}` : ''}`,
    );
  }

  // `az acr build --no-wait --output json` returns JSON on some Azure CLI
  // versions, while others emit only "Queued a build with ID: ..." to stderr.
  // Preserve stdout for all other commands so warnings cannot corrupt digest or
  // run-status parsing.
  if (args[0] === 'acr' && args[1] === 'build' && !result.stdout.trim()) {
    return result.stderr;
  }
  return result.stdout;
}

function parseQueuedBuild(value) {
  try {
    return JSON.parse(value);
  } catch {
    const runId = /Queued a build with ID:\s*([A-Za-z0-9-]+)/i.exec(value)?.[1];
    if (runId) return { runId };
    throw new Error('az acr build did not return JSON or a queued build ID');
  }
}

function parseJson(value, command) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${command} did not return valid JSON`, { cause: error });
  }
}

function idSuffix(value) {
  return typeof value === 'string' ? value.split('/').filter(Boolean).at(-1) : undefined;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function shellQuote(value) {
  return /^[A-Za-z0-9_./:@=-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function usage() {
  return `Usage:
  node scripts/publish-base-images.mjs --registry <name|login-server> --all [--dry-run]
  node scripts/publish-base-images.mjs --registry <name|login-server> \\
    --template node22-pw [--template node22] [--dry-run]

Options:
  --registry   ACR name or <name>.azurecr.io (or set ACR_REGISTRY_URL)
  --revision   Immutable image tag (default: current Git commit)
  --all        Publish every templates/base/Dockerfile.* image
  --template   Publish one template; may be repeated
  --dry-run    Print the complete build and verification plan without mutations
`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const registry = options.registry ?? process.env.ACR_REGISTRY_URL;
  if (!options.dryRun) {
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: DEFAULT_REPO_ROOT,
      encoding: 'utf8',
    }).trim();
    if (status) {
      throw new Error('Refusing to publish from a dirty worktree; commit or stash changes first');
    }
  }
  const revision =
    options.revision ??
    execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      cwd: DEFAULT_REPO_ROOT,
      encoding: 'utf8',
    }).trim();
  const templates = options.all ? 'all' : options.templates;
  const plan = createPublishPlan({ registry, revision, templates });
  const result = await executePublishPlan(plan, { dryRun: options.dryRun });
  if (options.dryRun) process.stdout.write(`${result}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
