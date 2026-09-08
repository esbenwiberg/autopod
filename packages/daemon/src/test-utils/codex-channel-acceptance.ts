import assert from 'node:assert/strict';
/** Explicitly invoked real-CLI/local-provider fixture. Never uses an account credential. */
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BoundedResponsesTransport } from '../managed/bounded-provider.js';
import { digest, sha256 } from '../managed/canonical.js';
import { ChatGptReportTransport } from '../managed/chatgpt-provider.js';
import { codexInput } from '../managed/codex-wire.js';
import { ManagedProviderGateway } from '../managed/provider-gateway.js';
import { fixture, requestTimeFixture, resign } from './managed-fixture.js';

const [repositoryRoot, reportPath] = process.argv.slice(2);
if (!repositoryRoot || !reportPath) throw new Error('explicit-owned-root-and-report-required');
const root = await realpath(await mkdtemp('/private/tmp/codex-wire-'));
await chmod(root, 0o700);
const requestTime = process.argv[4] === '--request-time';
const f = requestTime ? requestTimeFixture() : fixture();
for (const route of [
  f.request.route,
  f.request.profileSnapshot.route,
  f.request.effectiveGrant.route,
]) {
  route.model = 'gpt-5.6-terra';
  route.reasoning = 'low';
}
f.request.profileSnapshot.snapshotDigest = digest(
  Object.fromEntries(
    Object.entries(f.request.profileSnapshot).filter(([key]) => key !== 'snapshotDigest'),
  ),
);
f.request.effectiveGrant.profileSnapshotDigest = f.request.profileSnapshot.snapshotDigest;
resign(f.request);
f.admission.profiles = new Map([
  [f.request.profileSnapshot.snapshotDigest, f.request.profileSnapshot],
]);
const service = f.service();
const handle = await service.start('fixture-installation', f.request);
const calls: { url: string; inputBytes: number; maxOutputTokens?: number }[] = [];
const apiProvider = new BoundedResponsesTransport(
  f.request.route,
  'api-key',
  async () => ({
    accountId: f.request.route.providerAccountId,
    mode: 'api-key',
    token: 'local-fixture-only',
  }),
  async (url, init) => {
    const body = JSON.parse(String(init?.body));
    calls.push({
      url: String(url),
      inputBytes: Buffer.byteLength(JSON.stringify(body.input)),
      maxOutputTokens: body.max_output_tokens,
    });
    if (String(url).endsWith('/input_tokens'))
      return Response.json({ object: 'response.input_tokens', input_tokens: 10 });
    return Response.json({
      model: f.request.route.model,
      status: 'completed',
      usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '# Report\nLocal Codex channel verified.\n' }],
        },
      ],
    });
  },
  'codex-report',
);
const provider = requestTime
  ? new ChatGptReportTransport(
      f.request.route,
      'fixture-account',
      async () => ({
        accountId: f.request.route.providerAccountId,
        mode: 'chatgpt',
        chatgptAccountId: 'fixture-account',
        token: 'fixture-only',
      }),
      async (url, init) => {
        calls.push({ url: String(url), inputBytes: Buffer.byteLength(String(init?.body)) });
        return new Response(
          `data: ${JSON.stringify({ type: 'response.completed', response: { model: f.request.route.model, status: 'completed', usage: { input_tokens: 5000, output_tokens: 4, total_tokens: 5004 }, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '# Report\nLocal Codex channel verified.\n' }] }] } })}\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    )
  : apiProvider;
const expectedCalls = requestTime ? 1 : 2;
const gateway = new ManagedProviderGateway(service, provider);
const server = spawn(
  'python3',
  [
    path.join(repositoryRoot, 'packages/daemon/src/managed/runtime/codex_channel.py'),
    root,
    '0',
    '30',
  ],
  { stdio: 'ignore' },
);
let worker: ReturnType<typeof spawn> | undefined;
let raw = '';
let lastTicket = '';
let timer: ReturnType<typeof setInterval> | undefined;
try {
  let port = 0;
  for (let i = 0; i < 100; i++) {
    try {
      port = JSON.parse(await readFile(path.join(root, 'channel-ready.json'), 'utf8')).port;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 30));
    }
  }
  assert(port > 0);
  const endpoint = `http://127.0.0.1:${port}/v1`;
  await writeFile(path.join(root, 'README.md'), 'A frozen local fact.\n');
  let busy = false;
  let fault: unknown;
  let expectRevocation = false;
  let revokedReplayRejected = false;
  timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void (async () => {
      try {
        const request = JSON.parse(await readFile(path.join(root, 'channel-request.json'), 'utf8'));
        if (request.ticket === lastTicket) return;
        lastTicket = request.ticket;
        raw = request.body;
        assert.equal(request.digest, sha256(raw).slice(7));
        codexInput(f.request.route, raw);
        const result = await gateway.invoke(
          'fixture-installation',
          handle.podId,
          1,
          'codex-report-one',
          raw,
          requestTime ? 0 : 4095,
        );
        assert.equal(result.state, 'observed');
        await writeFile(
          path.join(root, 'channel-response.tmp'),
          JSON.stringify({
            digest: request.digest,
            ticket: request.ticket,
            ok: true,
            body: result.state === 'observed' ? result.value : '',
          }),
        );
        await rename(
          path.join(root, 'channel-response.tmp'),
          path.join(root, 'channel-response.json'),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          if (expectRevocation && String(error).includes('grant-inactive')) {
            revokedReplayRejected = true;
            await writeFile(path.join(root, 'channel-closed'), 'true');
            return;
          }
          fault = error;
          try {
            if (worker?.pid) process.kill(-worker.pid, 'SIGKILL');
          } catch {}
        }
      } finally {
        busy = false;
      }
    })();
  }, 30);
  worker = spawn(
    'python3',
    [
      path.join(repositoryRoot, 'packages/daemon/src/managed/runtime/codex_worker.py'),
      '--model',
      f.request.route.model,
      '--reasoning',
      'low',
      '--endpoint',
      endpoint,
      '--readme',
      path.join(root, 'README.md'),
      '--output',
      path.join(root, 'report.md'),
      '--',
      'Produce a short report.',
    ],
    {
      env: { PATH: process.env.PATH, HOME: root, TMPDIR: root },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  worker.stdout?.on('data', (data) => {
    stdout += data.toString();
  });
  worker.stderr?.on('data', (data) => {
    stderr += data.toString();
  });
  const killWorker = () => {
    try {
      if (worker?.pid) process.kill(-worker.pid, 'SIGKILL');
    } catch {}
  };
  const timeout = setTimeout(killWorker, 25000);
  const [code] = await once(worker, 'exit');
  clearTimeout(timeout);
  if (fault) throw fault;
  assert.equal(code, 0, stderr.slice(-2000));
  assert.match(stdout, /turn.completed/);
  assert.equal(
    await readFile(path.join(root, 'report.md'), 'utf8'),
    '# Report\nLocal Codex channel verified.\n',
  );
  assert.equal(calls.length, expectedCalls);
  assert.equal(
    service.row('fixture-installation', handle.podId).consumed_tokens,
    requestTime ? 5004 : 14,
  );
  const retry = await fetch(`${endpoint}/responses`, { method: 'POST', body: raw });
  assert.equal(retry.status, 200);
  await retry.text();
  assert.equal(calls.length, expectedCalls);
  assert.equal((await fetch(`${endpoint}/responses`, { method: 'POST', body: '{}' })).status, 409);
  assert.equal(
    (
      await fetch(`${endpoint}/responses`, {
        method: 'POST',
        headers: { Authorization: 'fixture-only' },
        body: raw,
      })
    ).status,
    403,
  );
  expectRevocation = true;
  f.db.prepare('UPDATE managed_pods SET revoked=1').run();
  const revoked = await fetch(`${endpoint}/responses`, {
    method: 'POST',
    body: raw,
    signal: AbortSignal.timeout(2000),
  });
  assert.equal(revoked.status, 410);
  assert.equal(revokedReplayRejected, true);
  assert.equal(calls.length, expectedCalls);
  const body = JSON.parse(raw);
  const report = {
    status: 'PASS-real-installed-Codex-through-local-spool-and-deterministic-provider',
    codexVersion: execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim(),
    model: f.request.route.model,
    credentialMode: 'empty child home; worker sends no Authorization; host fixture credential only',
    providerMode: 'deterministic in-process fetch, no live provider request',
    requestBytes: Buffer.byteLength(raw),
    requestHasMaxOutputTokens: Object.hasOwn(body, 'max_output_tokens'),
    providerRequests: calls.length,
    providerRequestsMeaning: requestTime
      ? 'one fake ChatGPT generation request'
      : 'one fake input-count call plus one fake generation call',
    budgetMode: requestTime ? 'request-time' : 'hard-tokens',
    fixtureUsage: { input: requestTime ? 5000 : 10, output: 4, total: requestTime ? 5004 : 14 },
    fixtureUsageIsRealModelTokenCount: false,
    outputArtifactVerified: true,
    replayDidNotRegenerate: true,
    changedRequestRejected: true,
    workerAuthorizationRejected: true,
    revokedReplayRejected,
    httpReplayChecksCurrentAuthority: true,
    liveSandboxProviderAcceptance: 'BLOCKED-not-run',
    hardChatGptTokenCap: 'not established by this test',
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
} catch (error) {
  process.stderr.write(`${String(error)}\n`);
  throw error;
} finally {
  if (timer) clearInterval(timer);
  gateway.close();
  try {
    if (worker?.pid) process.kill(-worker.pid, 'SIGKILL');
  } catch {}
  server.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 300));
  f.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
