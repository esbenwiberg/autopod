import fs from 'node:fs';
import { AzureSandboxApiClient as ActualClient } from '/private/tmp/autopod-canary-resource-131-candidate.mjs';
const p = JSON.parse(
  fs.readFileSync(
    '/private/tmp/autopod-durable-execution/docs/analysis/2026-09-07/execution/fixtures/canary-resource-131-contract.json',
  ),
);
const original = fs.readFileSync(process.argv[2], 'utf8');
const signalTimeout = AbortSignal.timeout;
const budgets = new WeakMap();
AbortSignal.timeout = (ms) => {
  const signal = signalTimeout(ms);
  budgets.set(signal, ms);
  return signal;
};
for (const scenario of ['success', 'runtime_failure', 'label_refusal']) {
  const journal = `/private/tmp/autopod-canary-127-dry-${scenario}.json`;
  fs.rmSync(journal, { force: true });
  const resources = {};
  const creates = { diskimages: 0, sandboxes: 0 };
  const removed = [];
  let exchanges = 0;
  globalThis.mockSpawn = (bin, args) => {
    if (bin === 'git') return { status: 0 };
    let value;
    if (args[0] === 'account')
      value = {
        accessToken: `eyJ.${Buffer.from(JSON.stringify({ oid: p.principalId, aud: args.includes('https://containerregistry.azure.net/') ? 'https://containerregistry.azure.net/' : 'https://dynamicsessions.io/', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.fixture`,
      };
    if (args[0] === 'resource')
      value = {
        id: p.groupPath.replace('/sandboxGroups/', '/providers/Microsoft.App/sandboxGroups/'),
        location: 'northeurope',
        identity: {
          userAssignedIdentities: {
            [p.importBody.managedIdentityResourceId]: {
              principalId: 'c3003025-3baf-4222-b35f-d82f9eaef56c',
            },
          },
        },
      };
    if (args[0] === 'acr') value = { digest: p.importBody.labels.sourceDigest };
    return { status: 0, stdout: JSON.stringify(value) };
  };
  globalThis.fetch = async (url, init) => {
    if (String(url) === 'https://ewiautopodacr.azurecr.io/oauth2/exchange') {
      exchanges++;
      return new Response(JSON.stringify({ refresh_token: 'fixture-only-acr-token' }), {
        status: 200,
      });
    }
    const method = init?.method ?? 'GET';
    const a = new URL(url).pathname.split('/');
    const kind = a[7];
    const identifier = a[8];
    let status = 200;
    let body = {};
    if (
      method === 'PUT' &&
      kind === 'diskimages' &&
      budgets.get(init.signal) !== p.limits.imageReadyDeadlineSeconds * 1000
    )
      throw new Error('import_window_truncated');
    if (method === 'GET' && !identifier) body = resources[kind] ? [resources[kind]] : [];
    else if (method === 'PUT') {
      creates[kind]++;
      const v = JSON.parse(init.body);
      if (kind === 'sandboxes' && scenario === 'label_refusal')
        return new Response(
          JSON.stringify({
            error: 'Label value contains invalid characters: fixture-only-secret-token',
          }),
          { status: 400 },
        );
      if (
        kind === 'sandboxes' &&
        !Object.values(v.labels).every(
          (x) => x.length <= 63 && /^[A-Za-z0-9]([A-Za-z0-9_.-]*[A-Za-z0-9])?$/.test(x),
        )
      )
        throw new Error('sandbox_label_not_safe');
      if (kind === 'diskimages' && v.registryCredentials?.token !== 'fixture-only-acr-token')
        throw new Error('missing_ephemeral_token');
      v.registryCredentials = undefined;
      body = {
        ...v,
        id:
          kind === 'diskimages'
            ? '11111111-1111-1111-1111-111111111111'
            : '22222222-2222-2222-2222-222222222222',
        state: kind === 'diskimages' ? 'Ready' : 'Running',
      };
      resources[kind] = body;
    } else if (method === 'DELETE') {
      delete resources[kind];
      removed.push(kind);
      status = 204;
    } else if (resources[kind]) body = resources[kind];
    else status = 404;
    return new Response(status === 204 ? null : JSON.stringify(body), { status });
  };
  let stats = 0;
  globalThis.MockClient = class {
    constructor(config, logger) {
      this.actual = new ActualClient(config, logger);
    }
    async resolveAcrRegistryCredentials(image) {
      return this.actual.resolveAcrRegistryCredentials(image);
    }
    async exec(id, cmd) {
      let stdout = '';
      let exitCode = 0;
      if (cmd[0] === 'id') stdout = cmd.includes('autopod') ? '1000\n' : '0\n';
      if (cmd[0] === 'sh' && cmd[2] === 'command -v codex') stdout = '/usr/local/bin/codex\n';
      if (cmd[0] === 'codex') {
        stdout = 'codex-cli 0.107.0\n';
        if (scenario === 'runtime_failure') exitCode = 127;
      }
      if (cmd[0] === 'node')
        stdout =
          cmd[1] === '-e'
            ? JSON.stringify({ memoryLimitBytes: null, cpuLimit: null })
            : 'v22.23.1\n';
      if (cmd[0] === 'sh' && cmd[2]?.includes('/sys/fs/cgroup/cpu.max'))
        stdout = `${['/sys/fs/cgroup/cpu.max=unavailable', '/sys/fs/cgroup/memory.max=unavailable', '/sys/fs/cgroup/cpu/cpu.cfs_quota_us=unavailable', '/sys/fs/cgroup/cpu/cpu.cfs_period_us=unavailable', '/sys/fs/cgroup/memory/memory.limit_in_bytes=unavailable', 'onlineCPUs=2', 'memoryKiB=4000000', 'filesystemBytes=42000000000'].join('\n')}\n`;

      if (cmd[0] === 'stat')
        stdout = cmd[2].includes('%i') ? `1000:1000:644:${++stats}\n` : '0:0:644\n';
      if (cmd[0] === 'dotnet')
        stdout = cmd.includes('--help')
          ? '--configfile --take --format'
          : cmd[1] === 'nuget'
            ? 'https://api.nuget.org/v3/index.json'
            : JSON.stringify({ problems: [], searchResult: [] });
      return { stdout, stderr: '', exitCode };
    }
    async getResourceAllocation() {
      return { memoryLimitBytes: 4294967296, cpuLimit: 2 };
    }
    async writeFile() {}
    async *execStream() {
      yield { stdout: 'cp126-stream-out\n' };
      yield { stderr: 'cp126-stream-err\n' };
      yield { exitCode: 0 };
    }
  };
  const code = original
    .replace(
      "import { spawnSync } from 'node:child_process';",
      'const spawnSync=globalThis.mockSpawn;',
    )
    .replace(
      "import { AzureSandboxApiClient, runtimeConfigInstallCommand, SandboxContainerManager, CGROUP_EXECUTION_METADATA_PROBE, parseCgroupExecutionMetadata } from './autopod-canary-resource-131-candidate.mjs';",
      "const AzureSandboxApiClient=globalThis.MockClient;const runtimeConfigInstallCommand=(a,b)=>['fixture-install',a,b];import {SandboxContainerManager,CGROUP_EXECUTION_METADATA_PROBE,parseCgroupExecutionMetadata} from '/private/tmp/autopod-canary-resource-131-candidate.mjs';",
    )
    .replace(
      "if(process.argv[2]!=='--execute-approved-resource131')throw new Error('explicit_execution_flag_required');",
      '',
    )
    .replace(
      "const journal='/private/tmp/autopod-canary-resource-131-new-attempt-journal.json';",
      `const journal=${JSON.stringify(journal)};`,
    )
    .replace('const wait=(ms)=>new Promise(res=>setTimeout(res,ms));', 'const wait=async()=>{};');
  const f = `/private/tmp/autopod-canary-127-dry-${scenario}.mjs`;
  fs.writeFileSync(f, code);
  await import(f);
  const result = JSON.parse(fs.readFileSync(journal));
  if (scenario === 'label_refusal') {
    const d = result.events.find((e) => e.kind === 'http_refusal');
    if (
      !result.sandboxRefusedNoResourceObserved ||
      !result.diskRemoved ||
      removed.join(',') !== 'diskimages' ||
      !d?.labelMention ||
      !d?.formatOrLengthMention ||
      JSON.stringify(result).includes('fixture-only-secret-token') ||
      creates.diskimages !== 1 ||
      creates.sandboxes !== 1
    )
      throw new Error('diagnostic_test_failed');
  } else if (
    exchanges !== 1 ||
    JSON.stringify(result).includes('fixture-only-acr-token') ||
    result.allCreatedResourcesRemoved !== true ||
    creates.diskimages !== 1 ||
    creates.sandboxes !== 1 ||
    removed.join(',') !== 'sandboxes,diskimages' ||
    result.status !== (scenario === 'success' ? 'verified' : 'failed')
  )
    throw new Error(`dry_run_failed_${scenario}`);
  if (
    scenario === 'success' &&
    (result.resourceFacts.onlineCPUs !== '2' || result.resourceEvidence.cgroupV2Available !== false)
  )
    throw new Error('resource_unavailability_hidden');
  if (
    scenario === 'success' &&
    (result.originalCgroupOnlyMetadata.cpuLimit !== null ||
      result.correctedExecutionMetadata.cpuLimit !== 2)
  )
    throw new Error('actual_adapter_not_exercised');
  if (
    scenario === 'runtime_failure' &&
    (result.failure.code !== 'check_failed_codexVersion' ||
      result.runtime.codexPath !== '/usr/local/bin/codex' ||
      result.checks.codexVersion.exitCode !== 127)
  )
    throw new Error('missing_named_failure_evidence');
  console.log(
    JSON.stringify({
      scenario,
      passed: true,
      actualCandidateExchange: true,
      oneExchange: exchanges === 1,
      tokenAbsentFromReceipt:
        !JSON.stringify(result).includes('fixture-only-acr-token') &&
        !JSON.stringify(result).includes('fixture-only-secret-token'),
      network: 'mocked',
      cloudMutations: 0,
    }),
  );
}
