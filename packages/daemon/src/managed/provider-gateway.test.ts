import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { type ManagedFixture, fixture } from '../test-utils/managed-fixture.js';
import { type BoundedProviderTransport, ManagedProviderFailure } from './bounded-provider.js';
import { ManagedPodService } from './managed-service.js';
import { ManagedProviderGateway } from './provider-gateway.js';
import { ManagedQuotaBroker } from './quota-broker.js';
let f: ManagedFixture;
const gateways: ManagedProviderGateway[] = [];
afterEach(() => {
  for (const g of gateways.splice(0)) g.close();
  f?.close();
});
async function setup() {
  f = fixture();
  const service = f.service();
  const handle = await service.start('installation', f.request);
  const generate = vi
    .fn<BoundedProviderTransport['generate']>()
    .mockResolvedValue({ value: 'facts', consumedTokens: 30 });
  const transport: BoundedProviderTransport = {
    bindingDigest: 'fixture-route-v1',
    preflight: vi.fn(),
    generate,
  };
  const gateway = new ManagedProviderGateway(service, transport);
  gateways.push(gateway);
  const call = (key = 'request-one', prompt = 'Read README') =>
    gateway.invoke('installation', handle.podId, 1, key, prompt, 100);
  return { service, handle, transport, generate, gateway, call };
}
it('replays durable output after restart without another provider call', async () => {
  const x = await setup();
  expect(await x.call()).toEqual({ state: 'observed', value: 'facts' });
  expect(x.service.row('installation', x.handle.podId).consumed_tokens).toBe(30);
  x.gateway.close();
  f.restart();
  const g = new ManagedProviderGateway(f.service(), x.transport);
  gateways.push(g);
  expect(
    await g.invoke('installation', x.handle.podId, 1, 'request-one', 'Read README', 100),
  ).toEqual({ state: 'observed', value: 'facts' });
  expect(x.generate).toHaveBeenCalledTimes(1);
});
it('persists and replays a transport-declared agent response above 64 KiB', async () => {
  const x = await setup();
  const value = 'x'.repeat(70 * 1024);
  x.generate.mockResolvedValue({ value, consumedTokens: 30 });
  x.gateway.close();
  const transport = { ...x.transport, maximumResponseBytes: 1024 * 1024 };
  const gateway = new ManagedProviderGateway(x.service, transport);
  gateways.push(gateway);
  expect(
    await gateway.invoke('installation', x.handle.podId, 1, 'request-one', 'Read README', 100),
  ).toEqual({
    state: 'observed',
    value,
  });
  gateway.close();
  f.restart();
  const replay = new ManagedProviderGateway(f.service(), transport);
  gateways.push(replay);
  expect(
    await replay.invoke('installation', x.handle.podId, 1, 'request-one', 'Read README', 100),
  ).toEqual({ state: 'observed', value });
  expect(x.generate).toHaveBeenCalledTimes(1);
});
it('rejects a transport response bound above the one MiB channel ceiling', async () => {
  const x = await setup();
  x.gateway.close();
  const transport = { ...x.transport, maximumResponseBytes: 1024 * 1024 + 1 };
  expect(() => new ManagedProviderGateway(x.service, transport)).toThrow(
    'managed-provider-output-limit-invalid',
  );
});
it('admits an explicitly bounded one MiB agent request', async () => {
  const x = await setup();
  x.gateway.close();
  const transport = { ...x.transport, maximumPromptBytes: 1024 * 1024 };
  const gateway = new ManagedProviderGateway(x.service, transport);
  gateways.push(gateway);
  const prompt = 'x'.repeat(140 * 1024);
  await expect(
    gateway.invoke('installation', x.handle.podId, 1, 'large-agent-request', prompt, 100),
  ).resolves.toEqual({ state: 'observed', value: 'facts' });
  expect(x.generate.mock.calls[0]?.[1]).toBe(prompt);
});
it('concurrent duplicate calls reserve once', async () => {
  const x = await setup();
  let finish!: (v: { value: string; consumedTokens: number }) => void;
  x.generate.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const first = x.call();
  expect(await x.call()).toEqual({ state: 'reserved' });
  expect(x.service.row('installation', x.handle.podId).consumed_tokens).toBe(100);
  finish({ value: 'facts', consumedTokens: 30 });
  await first;
  expect(x.generate).toHaveBeenCalledTimes(1);
});
it('uncertainty stays reserved after restart and cannot use a second key', async () => {
  const x = await setup();
  x.generate.mockRejectedValue(new Error('private-provider-body'));
  await expect(x.call()).rejects.toThrow(/^managed-provider-attempt-unavailable$/);
  x.gateway.close();
  f.restart();
  const g = new ManagedProviderGateway(f.service(), x.transport);
  gateways.push(g);
  expect(
    await g.invoke('installation', x.handle.podId, 1, 'request-one', 'Read README', 100),
  ).toEqual({ state: 'reserved' });
  await expect(
    g.invoke('installation', x.handle.podId, 1, 'request-two', 'Read README', 100),
  ).rejects.toThrow('request-limit');
  expect(f.service().row('installation', x.handle.podId).consumed_tokens).toBe(100);
  expect(x.generate).toHaveBeenCalledTimes(1);
  expect(
    f.db
      .prepare(
        'SELECT failure_phase,failure_reason,failure_http_status FROM managed_provider_requests',
      )
      .get(),
  ).toEqual({ failure_phase: null, failure_reason: null, failure_http_status: null });
});
it('persists only schema-bounded provider failure diagnostics on an uncertain request', async () => {
  const x = await setup();
  x.generate.mockRejectedValue(
    new ManagedProviderFailure({ phase: 'http', reason: 'http', httpStatus: 429 }),
  );
  await expect(x.call()).rejects.toThrow(/^managed-provider-attempt-unavailable$/);
  expect(
    f.db
      .prepare(
        'SELECT state,response_json,actual_tokens,failure_phase,failure_reason,failure_http_status FROM managed_provider_requests',
      )
      .get(),
  ).toEqual({
    state: 'reserved',
    response_json: null,
    actual_tokens: null,
    failure_phase: 'http',
    failure_reason: 'http',
    failure_http_status: 429,
  });
});
it('rejects changed prompt, transport or request limit on replay and new keys', async () => {
  const x = await setup();
  await x.call();
  await expect(x.call('request-one', 'Different prompt')).rejects.toThrow('replay-conflict');
  for (const g of [
    new ManagedProviderGateway(x.service, { ...x.transport, bindingDigest: 'other' }),
    new ManagedProviderGateway(x.service, x.transport, 2),
  ]) {
    gateways.push(g);
    await expect(
      g.invoke('installation', x.handle.podId, 1, 'request-one', 'Read README', 100),
    ).rejects.toThrow('replay-conflict');
    await expect(
      g.invoke('installation', x.handle.podId, 1, 'request-two', 'Read README', 100),
    ).rejects.toThrow('binding-changed');
  }
  expect(x.generate).toHaveBeenCalledTimes(1);
});
it.each(['expiry', 'duration', 'revoked', 'stop', 'revision', 'foreign', 'closed'])(
  'rejects %s before cached delivery',
  async (kind) => {
    const x = await setup();
    await x.call();
    if (kind === 'expiry') f.advance(f.request.effectiveGrant.budget.expiresAt);
    if (kind === 'duration') f.advance(100 + f.request.effectiveGrant.budget.maxDurationSeconds);
    if (kind === 'revoked') f.db.prepare('UPDATE managed_pods SET revoked=1').run();
    if (kind === 'stop') f.db.prepare('UPDATE managed_pods SET stop_requested=1').run();
    if (kind === 'revision') f.db.prepare('UPDATE managed_pods SET grant_revision=2').run();
    if (kind === 'closed') x.gateway.close();
    await expect(
      kind === 'foreign'
        ? x.gateway.invoke(
            'other-installation',
            x.handle.podId,
            1,
            'request-one',
            'Read README',
            100,
          )
        : x.call(),
    ).rejects.toThrow();
    expect(x.generate).toHaveBeenCalledTimes(1);
  },
);
it.each(['revoked', 'expiry', 'closed'])(
  'aborts in-flight %s retaining the allowance',
  async (kind) => {
    const x = await setup();
    x.generate.mockImplementation(async (_route, _prompt, _tokens, signal) => {
      if (kind === 'revoked') f.db.prepare('UPDATE managed_pods SET revoked=1').run();
      if (kind === 'expiry') f.advance(f.request.effectiveGrant.budget.expiresAt);
      if (kind === 'closed') queueMicrotask(() => x.gateway.close());
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    });
    await expect(x.call()).rejects.toThrow('attempt-unavailable');
    expect(x.service.row('installation', x.handle.podId).consumed_tokens).toBe(100);
  },
);
it('unsupported preflight creates no reservation or provider call', async () => {
  const x = await setup();
  x.transport.preflight = () => {
    throw new Error('unsupported');
  };
  await expect(x.call()).rejects.toThrow('unsupported');
  expect(f.db.prepare('SELECT count(*) AS n FROM managed_provider_requests').get()).toEqual({
    n: 0,
  });
  expect(x.generate).not.toHaveBeenCalled();
});
it('refuses a fully reserved budget before effects so the quota watchdog cannot kill its own request', async () => {
  const x = await setup();
  await expect(
    x.gateway.invoke(
      'installation',
      x.handle.podId,
      1,
      'full',
      'Read README',
      'maxTokens' in f.request.effectiveGrant.budget
        ? f.request.effectiveGrant.budget.maxTokens
        : 0,
    ),
  ).rejects.toThrow('budget-headroom-required');
  expect(f.db.prepare('SELECT count(*) AS n FROM managed_provider_requests').get()).toEqual({
    n: 0,
  });
  expect(x.generate).not.toHaveBeenCalled();
});
it('independent database connections cannot duplicate or change a pending operation', async () => {
  const x = await setup();
  const db = new Database(f.db.name);
  const g = new ManagedProviderGateway(
    new ManagedPodService(db, f.admission, f.runtime, () => 100, true),
    x.transport,
  );
  let finish!: (v: { value: string; consumedTokens: number }) => void;
  x.generate.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  try {
    const first = x.call();
    expect(
      await g.invoke('installation', x.handle.podId, 1, 'request-one', 'Read README', 100),
    ).toEqual({ state: 'reserved' });
    await expect(
      g.invoke('installation', x.handle.podId, 1, 'request-one', 'Changed prompt', 100),
    ).rejects.toThrow('replay-conflict');
    finish({ value: 'facts', consumedTokens: 30 });
    await first;
    expect(x.generate).toHaveBeenCalledTimes(1);
  } finally {
    g.close();
    db.close();
  }
});
it('a crash between journal and allowance reservation cannot become a retry after restart', async () => {
  const x = await setup();
  const fault = vi
    .spyOn(ManagedQuotaBroker.prototype, 'invoke')
    .mockRejectedValueOnce(new Error('crash-before-allowance'));
  try {
    await expect(x.call()).rejects.toThrow('attempt-unavailable');
  } finally {
    fault.mockRestore();
  }
  expect(f.db.prepare('SELECT count(*) AS n FROM managed_provider_allowances').get()).toEqual({
    n: 0,
  });
  x.gateway.close();
  f.restart();
  const g = new ManagedProviderGateway(f.service(), x.transport);
  gateways.push(g);
  expect(
    await g.invoke('installation', x.handle.podId, 1, 'request-one', 'Read README', 100),
  ).toEqual({ state: 'reserved' });
  expect(x.generate).not.toHaveBeenCalled();
});
it('a late response after revocation cannot be persisted or delivered', async () => {
  const x = await setup();
  x.generate.mockImplementation(async () => {
    f.db.prepare('UPDATE managed_pods SET revoked=1').run();
    return { value: 'late', consumedTokens: 30 };
  });
  await expect(x.call()).rejects.toThrow('attempt-unavailable');
  expect(f.db.prepare('SELECT state,response_json FROM managed_provider_requests').get()).toEqual({
    state: 'reserved',
    response_json: null,
  });
});
it('an unmigrated 150 database cannot construct an executable gateway', async () => {
  const x = await setup();
  x.gateway.close();
  f.db.exec('DROP TABLE managed_provider_requests');
  expect(() => new ManagedProviderGateway(x.service, x.transport)).toThrow(
    'journal-migration-required',
  );
  expect(x.generate).not.toHaveBeenCalled();
});
it('a pre-184 provider journal cannot construct an executable gateway', async () => {
  const x = await setup();
  x.gateway.close();
  f.db.exec('DROP TABLE managed_provider_requests');
  f.db.exec(
    readFileSync(
      new URL('../db/migrations/151_managed_provider_requests.sql', import.meta.url),
      'utf8',
    ),
  );
  f.db.exec(
    readFileSync(
      new URL('../db/migrations/152_managed_request_usage.sql', import.meta.url),
      'utf8',
    ),
  );
  expect(() => new ManagedProviderGateway(x.service, x.transport)).toThrow(
    'diagnostic-migration-required',
  );
  expect(x.generate).not.toHaveBeenCalled();
});
