import fs from 'node:fs';
import { AzureSandboxApiClient as ActualClient } from '/private/tmp/autopod-canary-127-candidate.mjs';
const p = JSON.parse(
  fs.readFileSync(
    '/private/tmp/autopod-durable-execution/docs/analysis/2026-09-07/execution/fixtures/canary-127-contract.json',
  ),
);
const original = fs.readFileSync(
  '/private/tmp/autopod-durable-execution/docs/analysis/2026-09-07/execution/fixtures/run-canary-127-replacement.mjs',
  'utf8',
);
for (const scenario of ['success', 'runtime_failure']) {
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
    if (method === 'GET' && !identifier) body = resources[kind] ? [resources[kind]] : [];
    else if (method === 'PUT') {
      creates[kind]++;
      const v = JSON.parse(init.body);
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
      if (cmd === p.commands.identity || cmd[2]?.includes('command -v codex')) {
        stdout =
          '0\n0\n1000\n/usr/local/bin/codex\ncodex-cli 0.107.0\nv22.23.1\n8.0.400\n200000 100000\n4294967296\nFilesystem 1B-blocks Used Available Use% Mounted\n/dev/root 42949672960 1 1 1% /workspace\n';
        if (scenario === 'runtime_failure') exitCode = 1;
      }
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
      "import { AzureSandboxApiClient, runtimeConfigInstallCommand } from './autopod-canary-127-candidate.mjs';",
      "const AzureSandboxApiClient=globalThis.MockClient;const runtimeConfigInstallCommand=(a,b)=>['fixture-install',a,b];",
    )
    .replace(
      "if(process.argv[2]!=='--execute-approved-cp127')throw new Error('explicit_execution_flag_required');",
      '',
    )
    .replace(
      "const journal='/private/tmp/autopod-canary-127-replacement-journal.json';",
      `const journal=${JSON.stringify(journal)};`,
    )
    .replace('const wait=(ms)=>new Promise(res=>setTimeout(res,ms));', 'const wait=async()=>{};');
  const f = `/private/tmp/autopod-canary-127-dry-${scenario}.mjs`;
  fs.writeFileSync(f, code);
  await import(f);
  const result = JSON.parse(fs.readFileSync(journal));
  if (
    exchanges !== 1 ||
    JSON.stringify(result).includes('fixture-only-acr-token') ||
    result.allCreatedResourcesRemoved !== true ||
    creates.diskimages !== 1 ||
    creates.sandboxes !== 1 ||
    removed.join(',') !== 'sandboxes,diskimages' ||
    result.status !== (scenario === 'success' ? 'verified' : 'failed')
  )
    throw new Error(`dry_run_failed_${scenario}`);
  console.log(
    JSON.stringify({
      scenario,
      passed: true,
      actualCandidateExchange: true,
      oneExchange: exchanges === 1,
      tokenAbsentFromReceipt: !JSON.stringify(result).includes('fixture-only-acr-token'),
      network: 'mocked',
      cloudMutations: 0,
    }),
  );
}
