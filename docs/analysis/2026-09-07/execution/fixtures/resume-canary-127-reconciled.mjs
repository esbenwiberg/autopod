import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {
  AzureSandboxApiClient,
  runtimeConfigInstallCommand,
} from './autopod-canary-127-candidate.mjs';
const root = '/private/tmp/autopod-durable-execution';
if (process.argv[2] !== '--resume-reconciled-cp127')
  throw new Error('explicit_execution_flag_required');
const contractPath = `${root}/docs/analysis/2026-09-07/execution/fixtures/canary-127-contract.json`;
const p = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
const journal = '/private/tmp/autopod-canary-128-resumed-journal.json';
const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');
const expected = 'c503745f8b7fb8864493399aff22a89615ee6425320ed6a9f696ff8736a7d6d0';
const assert = (condition, code) => {
  if (!condition) throw new Error(code);
};
assert(sha(fs.readFileSync(contractPath)) === expected, 'contract_mismatch');
const prior = JSON.parse(
  fs.readFileSync('/private/tmp/autopod-canary-127-replacement-journal.json', 'utf8'),
);
const reconciliation = JSON.parse(
  fs.readFileSync('/private/tmp/autopod-canary-128-reconciliation.json', 'utf8'),
);
assert(
  prior.contractSHA256 === expected &&
    prior.nonce === p.nonce &&
    prior.diskCreateIntent === true &&
    !prior.sandboxCreateIntent,
  'resume_prior_identity',
);
assert(
  prior.events.filter((e) => e.kind === 'disk_create_intent').length === 1,
  'resume_image_attempt_count',
);
const observation = reconciliation.observations.at(-1);
assert(
  reconciliation.nonce === p.nonce &&
    observation.diskimages.nonceMatches === 1 &&
    observation.sandboxes.nonceMatches === 0,
  'resume_reconciliation_identity',
);
const recovered = observation.diskimages.matchingIds[0];
assert(/^[a-f0-9-]{36}$/i.test(recovered), 'resume_disk_id');
const imageDeadline =
  Date.parse(prior.events.find((e) => e.kind === 'disk_create_intent').at) + 600000;
const r = {
  startedAt: new Date().toISOString(),
  contractSHA256: expected,
  candidate: p.candidate,
  nonce: p.nonce,
  runnerSHA256: sha(fs.readFileSync(new URL(import.meta.url))),
  bundleSHA256: sha(fs.readFileSync('/private/tmp/autopod-canary-127-candidate.mjs')),
  status: 'reconciling',
  events: [],
  checks: {},
  providerCalls: 0,
  diskCreateIntent: true,
  diskId: recovered,
  priorImportJournalSHA256: sha(
    fs.readFileSync('/private/tmp/autopod-canary-127-replacement-journal.json'),
  ),
  additionalImageCreates: 0,
  additionalTokenExchanges: 0,
};
assert(!fs.existsSync(journal), 'journal_exists_no_recreate');
function save() {
  const s = `${JSON.stringify(r, null, 2)}\n`;
  assert(Buffer.byteLength(s) <= 32768, 'receipt_bound');
  fs.writeFileSync(`${journal}.tmp`, s, { mode: 0o600 });
  fs.renameSync(`${journal}.tmp`, journal);
}
function event(kind, fields = {}) {
  r.events.push({ at: new Date().toISOString(), kind, ...fields });
  save();
  console.log(JSON.stringify({ kind, ...fields }));
}
function az(args) {
  const q = spawnSync('az', args, { encoding: 'utf8', timeout: 30000, maxBuffer: 1048576 });
  assert(q.status === 0, 'azure_cli_failed');
  return JSON.parse(q.stdout);
}
let token;
let tokenExp;
function credential() {
  if (!token || Date.now() + 60000 > tokenExp) {
    const a = az([
      'account',
      'get-access-token',
      '--resource',
      'https://dynamicsessions.io/',
      '--output',
      'json',
    ]);
    const claims = JSON.parse(Buffer.from(a.accessToken.split('.')[1], 'base64url').toString());
    assert(claims.oid === p.principalId, 'principal_mismatch');
    assert(
      claims.aud === 'https://dynamicsessions.io' || claims.aud === 'https://dynamicsessions.io/',
      'audience_mismatch',
    );
    token = a.accessToken;
    tokenExp = claims.exp * 1000;
  }
  return token;
}
const wait = (ms) => new Promise((res) => setTimeout(res, ms));
function labels(b) {
  return b?.labels ?? b?.properties?.labels ?? {};
}
function state(b) {
  return b?.state ?? b?.status?.state ?? b?.properties?.status?.state;
}
function owned(b) {
  const l = labels(b);
  return Object.entries(p.importBody.labels).every(([k, v]) => l[k] === v);
}
function id(b) {
  assert(typeof b?.id === 'string' && /^[a-f0-9-]{36}$/i.test(b.id), 'invalid_resource_id');
  return b.id;
}
function list(b) {
  if (Array.isArray(b)) {
    assert(b.length <= 100, 'inventory_bound');
    return b;
  }
  assert(!b?.nextLink, 'inventory_pagination');
  const a = b?.value ?? b?.items ?? b?.diskImages;
  assert(Array.isArray(a) && a.length <= 100, 'inventory_shape');
  return a;
}
async function request(method, suffix, body, timeout = 20000) {
  const u = `${p.endpoint + p.groupPath + suffix}?api-version=${p.apiVersion}`;
  const res = await fetch(u, {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(timeout),
    headers: {
      Authorization: `Bearer ${credential()}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const reader = res.body?.getReader();
  const chunks = [];
  let size = 0;
  if (reader)
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1048576) {
        await reader.cancel();
        throw new Error('response_bound');
      }
      chunks.push(value);
    }
  let value;
  try {
    value = size ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  } catch {
    throw new Error('response_json');
  }
  if (res.status >= 400) {
    const code = value?.error?.code ?? value?.code;
    const message = String(value?.error?.message ?? value?.message ?? '');
    event('http_refusal', {
      httpStatus: res.status,
      ...(typeof code === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(code)
        ? { serviceCode: code }
        : {}),
      registryMention: /registry|image pull/i.test(message),
      authenticationMention: /auth|credential|token/i.test(message),
      permissionMention: /permission|access denied|forbidden/i.test(message),
    });
  }
  return { status: res.status, body: value };
}
async function get(suffix) {
  const v = await request('GET', suffix);
  assert(v.status === 200, `read_http_${v.status}`);
  return v.body;
}
async function create(kind, body) {
  r[`${kind}CreateIntent`] = true;
  if (kind === 'sandbox') r.sandboxCreateStarted = Date.now();
  event(`${kind}_create_intent`);
  try {
    const q = await request(
      'PUT',
      `/${kind === 'disk' ? 'diskimages' : 'sandboxes'}`,
      body,
      kind === 'disk' ? 60000 : 45000,
    );
    event(`${kind}_create_response`, { httpStatus: q.status });
    assert([200, 201, 202].includes(q.status), `create_http_${q.status}`);
    const value = id(q.body);
    r[`${kind}Id`] = value;
    event(`${kind}_identified`, { id: value });
    return value;
  } catch (e) {
    r[`${kind}CreateUncertain`] = true;
    event(`${kind}_reconcile`);
    const entries = list(await get(`/${kind === 'disk' ? 'diskimages' : 'sandboxes'}`)).filter(
      owned,
    );
    assert(entries.length === 1, 'create_reconciliation_unresolved');
    const value = id(entries[0]);
    r[`${kind}Id`] = value;
    event(`${kind}_identified_by_nonce`, { id: value });
    throw new Error('create_response_uncertain_stop');
  }
}
async function ready(kind, desired, deadline) {
  const path = `/${kind === 'disk' ? 'diskimages' : 'sandboxes'}/${r[`${kind}Id`]}`;
  let previous;
  while (Date.now() < deadline) {
    const b = await get(path);
    assert(owned(b), 'owned_resource_mismatch');
    const s = state(b);
    if (s !== previous) {
      event(`${kind}_state`, { state: /^[A-Za-z]{1,40}$/.test(s ?? '') ? s : 'unknown' });
      previous = s;
    }
    if (s === desired) return b;
    assert(!['Failed', 'Deleting'].includes(s), 'resource_failed');
    await wait(10000);
  }
  throw new Error(`${kind}_ready_timeout`);
}
async function cleanup(kind) {
  const identifier = r[`${kind}Id`];
  if (!identifier) {
    assert(!r[`${kind}CreateIntent`], 'unresolved_creation_identity');
    return;
  }
  const suffix = `/${kind === 'disk' ? 'diskimages' : 'sandboxes'}/${identifier}`;
  const deadline = Date.now() + 120000;
  let deletes = 0;
  let lastDelete = 0;
  while (Date.now() < deadline) {
    const q = await request('GET', suffix);
    if (q.status === 404) {
      r[`${kind}Removed`] = true;
      event(`${kind}_removed`, { id: identifier });
      return;
    }
    assert(q.status === 200, `cleanup_read_http_${q.status}`);
    assert(owned(q.body), 'cleanup_ownership_mismatch');
    if (kind === 'sandbox')
      assert(
        (q.body.sourcesRef ?? q.body.properties?.sourcesRef)?.diskImage?.id === r.diskId,
        'cleanup_source_mismatch',
      );
    if (deletes < 3 && Date.now() - lastDelete >= 30000) {
      event(`${kind}_delete_intent`, { id: identifier });
      deletes++;
      lastDelete = Date.now();
      try {
        const d = await request('DELETE', suffix);
        event(`${kind}_delete_response`, { httpStatus: d.status });
      } catch {
        event(`${kind}_delete_response_uncertain`);
      }
    }
    await wait(5000);
  }
  throw new Error('cleanup_absence_unverified');
}
let client;
function workRemaining() {
  return p.limits.workCutoffSecondsAfterCreate * 1000 - (Date.now() - r.sandboxCreateStarted);
}
async function exec(name, command, oracle, timeout = 15000) {
  assert(workRemaining() > 1000, 'work_deadline');
  event('check_started', { check: name });
  const v = await client.exec(r.sandboxId, command, {
    timeoutMs: Math.min(timeout, workRemaining()),
    cwd: '/workspace',
  });
  assert(
    Buffer.byteLength(v.stdout) + Buffer.byteLength(v.stderr) <= 16384,
    'command_output_bound',
  );
  const oraclePassed = oracle(v.stdout, v.stderr);
  const passed = v.exitCode === 0 && oraclePassed;
  r.checks[name] = {
    passed,
    exitCode: v.exitCode,
    diagnostics: {
      permissionDenied: /permission denied/i.test(v.stderr),
      commandNotFound: /not found/i.test(v.stderr),
      missingPath: /no such file/i.test(v.stderr),
    },
  };
  event('check_finished', { check: name, passed, exitCode: v.exitCode });
  assert(passed, `check_failed_${name}`);
  return v.stdout;
}
async function upload(path, value) {
  assert(workRemaining() > 1000, 'work_deadline');
  await client.writeFile(r.sandboxId, path, Buffer.from(value));
}
let stage = 'preflight';
try {
  save();
  const diff = spawnSync(
    'git',
    [
      'diff',
      '--quiet',
      p.candidate,
      '--',
      'packages/daemon/src/containers/azure-sandbox-api-client.ts',
      'packages/daemon/src/runtimes/runtime-config-capability.ts',
      'packages/daemon/src/pods/registry-injector.ts',
    ],
    { cwd: root },
  );
  assert(diff.status === 0, 'candidate_source_changed');
  credential();
  const scope =
    '/subscriptions/06bb959b-9458-41a6-bdf5-77cc12feaab9/resourceGroups/ewi-sandboxes/providers/Microsoft.App/sandboxGroups/autopod-spike-neu';
  const group = az([
    'resource',
    'show',
    '--ids',
    scope,
    '--api-version',
    p.apiVersion,
    '--query',
    '{id:id,location:location,identity:identity}',
    '--output',
    'json',
  ]);
  assert(
    group.id.toLowerCase() === scope.toLowerCase() && group.location === 'northeurope',
    'group_mismatch',
  );
  const pull = group.identity?.userAssignedIdentities?.[p.importBody.managedIdentityResourceId];
  assert(pull?.principalId === 'c3003025-3baf-4222-b35f-d82f9eaef56c', 'pull_identity_mismatch');
  const meta = az([
    'acr',
    'manifest',
    'show-metadata',
    '--registry',
    'ewiautopodacr',
    '--name',
    `autopod/dataverse-harness@${p.importBody.labels.sourceDigest}`,
    '--query',
    '{digest:digest}',
    '--output',
    'json',
  ]);
  assert(meta.digest === p.importBody.labels.sourceDigest, 'digest_mismatch');
  const disks = list(await get('/diskimages'));
  const sandboxes = list(await get('/sandboxes'));
  assert(
    sandboxes.every(
      (b) => ![p.nonce, 'autopod-cp126-20260910-6d48b2c9'].includes(labels(b).acceptanceRun),
    ),
    'resume_sandbox_already_present',
  );
  const matches = disks.filter((b) => labels(b).acceptanceRun === p.nonce);
  assert(
    matches.length === 1 && id(matches[0]) === recovered && owned(matches[0]),
    'resume_disk_ownership',
  );
  assert(
    disks.every((b) => labels(b).acceptanceRun !== 'autopod-cp126-20260910-6d48b2c9'),
    'prior_nonce_present',
  );
  r.preflight = {
    sourceUnchanged: true,
    principalMatched: true,
    groupMatched: true,
    pullIdentityMatched: true,
    sourceDigestMatched: true,
    exactDiskRecovered: true,
    sandboxNonceAbsent: true,
  };
  event('preflight_passed');
  stage = 'image_reconciliation';
  await ready('disk', 'Ready', imageDeadline);
  event('image_identity_reconciled');
  stage = 'sandbox_create';
  const body = structuredClone(p.sandboxBodyTemplate);
  body.sourcesRef.diskImage.id = r.diskId;
  await create('sandbox', body);
  const sandbox = await ready('sandbox', 'Running', r.sandboxCreateStarted + 120000);
  const actual = sandbox.resources ?? sandbox.properties?.resources;
  r.resourceMetadata = actual && { cpu: actual.cpu, memory: actual.memory, disk: actual.disk };
  assert(
    (sandbox.sourcesRef ?? sandbox.properties?.sourcesRef)?.diskImage?.id === r.diskId,
    'sandbox_source_mismatch',
  );
  const bytes = (v) => {
    const m = /^(\d+)(Mi|Gi)$/.exec(String(v));
    return m ? Number(m[1]) * (m[2] === 'Gi' ? 1073741824 : 1048576) : Number.NaN;
  };
  const cpu = (v) => (String(v).endsWith('m') ? Number(String(v).slice(0, -1)) / 1000 : Number(v));
  assert(
    actual &&
      cpu(actual.cpu) === 2 &&
      bytes(actual.memory) === 4294967296 &&
      bytes(actual.disk) === 42949672960,
    'resource_metadata_mismatch',
  );
  stage = 'capability';
  const logger = {
    child() {
      return this;
    },
    info() {},
    warn() {},
    error() {},
    debug() {},
  };
  client = new AzureSandboxApiClient(
    {
      subscriptionId: '06bb959b-9458-41a6-bdf5-77cc12feaab9',
      resourceGroup: 'ewi-sandboxes',
      location: 'northeurope',
      sandboxGroup: 'autopod-spike-neu',
      assumeGroupExists: true,
      credential: {
        async getToken(scopes) {
          assert(scopes === 'https://dynamicsessions.io/.default', 'credential_scope');
          return { token: credential() };
        },
      },
      retry: { maxAttempts: 1 },
      fetch: async (input, init) => {
        const u = new URL(input);
        assert(
          u.origin === p.endpoint &&
            u.pathname.startsWith(`${p.groupPath}/sandboxes/${r.sandboxId}/`),
          'client_request_scope',
        );
        assert(workRemaining() > 0, 'work_deadline');
        return fetch(input, {
          ...init,
          redirect: 'error',
          signal: AbortSignal.any([
            ...(init?.signal ? [init.signal] : []),
            AbortSignal.timeout(Math.min(20000, workRemaining())),
          ]),
        });
      },
    },
    logger,
  );
  await exec('identity', p.commands.identity, (out) => {
    const l = out.trim().split('\n');
    const cpu = l[7]?.trim().split(/\s+/).map(Number);
    const valid =
      l.length >= 11 &&
      l.slice(0, 3).every((v) => /^\d+$/.test(v)) &&
      /^\/[A-Za-z0-9/_.-]+$/.test(l[3]) &&
      /^codex(?:-cli)? [0-9.\w-]+$/.test(l[4]) &&
      /^v\d+[\d.]+$/.test(l[5]) &&
      /^\d+[\d.]+$/.test(l[6]) &&
      cpu?.[0] / cpu?.[1] === 2 &&
      l[8] === '4294967296';
    if (valid)
      r.runtime = {
        execUid: l[0],
        execGid: l[1],
        autopodUid: l[2],
        codexPath: l[3],
        codexVersion: l[4],
        nodeVersion: l[5],
        dotnetVersion: l[6],
        cpuQuota: cpu[0],
        cpuPeriod: cpu[1],
        memoryBytes: l[8],
        filesystemCapacityBytes: l.at(-1).trim().split(/\s+/)[1],
      };
    return valid;
  });
  await exec('prepare', p.commands.prepare, () => true);
  await upload(p.configInstall.source, p.uploads[p.configInstall.source]);
  await exec('uploadedIdentity', p.commands.uploadedIdentity, (out) => {
    const v = out.trim();
    if (!/^\d+:\d+:[0-7]{3,4}$/.test(v)) return false;
    r.uploadIdentity = v;
    return true;
  });
  const verifyConfig = (expected) => [
    'sh',
    '-c',
    'set -eu; test "$(cat "$1")" = "$2"',
    'canary-config-check',
    p.configInstall.target,
    expected.trim(),
  ];
  await exec(
    'configInstallA',
    runtimeConfigInstallCommand(p.configInstall.source, p.configInstall.target),
    () => true,
  );
  await exec('configContentA', verifyConfig(p.uploads[p.configInstall.source]), () => true);
  let inodeA;
  await exec('targetIdentityA', p.commands.targetIdentity, (out) => {
    const v = out.trim();
    if (!/^\d+:\d+:644:\d+$/.test(v)) return false;
    r.configIdentityA = v;
    inodeA = v.split(':')[3];
    return true;
  });
  await upload(p.configInstall.source, p.configInstall.secondUpload);
  await exec(
    'configInstallB',
    runtimeConfigInstallCommand(p.configInstall.source, p.configInstall.target),
    () => true,
  );
  await exec('configContentB', verifyConfig(p.configInstall.secondUpload), () => true);
  await exec('targetIdentityB', p.commands.targetIdentity, (out) => {
    const v = out.trim();
    if (!/^\d+:\d+:644:\d+$/.test(v)) return false;
    r.configIdentityB = v;
    return v.split(':')[3] !== inodeA;
  });
  event('check_started', { check: 'stream' });
  let stdout = '';
  let stderr = '';
  let exitCode;
  assert(workRemaining() > 1000, 'work_deadline');
  for await (const chunk of client.execStream(r.sandboxId, p.commands.stream, {
    timeoutMs: Math.min(20000, workRemaining()),
  })) {
    stdout += chunk.stdout ?? '';
    stderr += chunk.stderr ?? '';
    if (chunk.exitCode !== undefined) exitCode = chunk.exitCode;
    assert(Buffer.byteLength(stdout) + Buffer.byteLength(stderr) <= 16384, 'stream_output_bound');
  }
  r.checks.stream = {
    passed: stdout === 'cp126-stream-out\n' && stderr === 'cp126-stream-err\n' && exitCode === 0,
    stdoutMatched: stdout === 'cp126-stream-out\n',
    stderrMatched: stderr === 'cp126-stream-err\n',
    exitCode,
  };
  event('check_finished', { check: 'stream', passed: r.checks.stream.passed });
  assert(r.checks.stream.passed, 'stream_oracle_failed');
  const nuget = Object.keys(p.uploads).find((v) => v.endsWith('NuGet.Config'));
  await upload(nuget, p.uploads[nuget]);
  await exec('nugetList', p.commands.nugetList, (out) =>
    out.includes('https://api.nuget.org/v3/index.json'),
  );
  await exec('nugetHelp', p.commands.nugetHelp, (out) =>
    ['--configfile', '--take', '--format'].every((v) => out.includes(v)),
  );
  await exec(
    'nugetSearch',
    p.commands.nugetSearch,
    (out) => {
      try {
        const report = JSON.parse(out);
        return (
          Array.isArray(report.problems) &&
          report.problems.length === 0 &&
          Array.isArray(report.searchResult)
        );
      } catch {
        return false;
      }
    },
    60000,
  );
  r.status = 'capability_verified_cleanup_pending';
  event('capability_verified');
} catch (e) {
  r.status = 'failed';
  r.failure = {
    stage,
    code: /^[a-zA-Z0-9_]{1,100}$/.test(e.message ?? '') ? e.message : 'operation_failed',
    ...(typeof e.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(e.code)
      ? { sourceErrorCode: e.code }
      : {}),
  };
  event('execution_stopped', r.failure);
} finally {
  try {
    await cleanup('sandbox');
  } catch (e) {
    r.sandboxCleanupError = /^[a-zA-Z0-9_]{1,100}$/.test(e.message ?? '')
      ? e.message
      : 'cleanup_failed';
    event('sandbox_cleanup_unresolved');
  }
  if (!r.sandboxCreateIntent || r.sandboxRemoved) {
    try {
      await cleanup('disk');
    } catch (e) {
      r.diskCleanupError = /^[a-zA-Z0-9_]{1,100}$/.test(e.message ?? '')
        ? e.message
        : 'cleanup_failed';
      event('disk_cleanup_unresolved');
    }
  }
  r.finishedAt = new Date().toISOString();
  r.allCreatedResourcesRemoved =
    (!r.sandboxCreateIntent || r.sandboxRemoved === true) &&
    (!r.diskCreateIntent || r.diskRemoved === true);
  if (r.sandboxCreateStarted)
    r.sandboxAllocationThroughCleanupMs = Date.now() - r.sandboxCreateStarted;
  if (r.status === 'capability_verified_cleanup_pending' && r.allCreatedResourcesRemoved)
    r.status = 'verified';
  save();
  console.log(
    JSON.stringify({
      status: r.status,
      allCreatedResourcesRemoved: r.allCreatedResourcesRemoved,
      failure: r.failure,
    }),
  );
}
