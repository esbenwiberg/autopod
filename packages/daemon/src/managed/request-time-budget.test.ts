import { afterEach, expect, it, vi } from 'vitest';
import { type ManagedFixture, requestTimeFixture } from '../test-utils/managed-fixture.js';
import type { BoundedProviderTransport } from './bounded-provider.js';
import { digest } from './canonical.js';
import { ManagedControls } from './managed-controls.js';
import { ManagedProviderGateway } from './provider-gateway.js';
import { ManagedQuotaBroker } from './quota-broker.js';
let f: ManagedFixture;
const gateways: ManagedProviderGateway[] = [];
afterEach(() => {
  for (const g of gateways.splice(0)) g.close();
  f?.close();
});
async function setup() {
  f = requestTimeFixture();
  const service = f.service();
  const handle = await service.start('installation', f.request);
  const transport: BoundedProviderTransport = {
    budgetMode: 'request-time',
    bindingDigest: 'request-time-test',
    preflight: vi.fn(),
    generate: vi.fn(async () => ({ value: 'report', consumedTokens: 6000 })),
  };
  const gateway = new ManagedProviderGateway(service, transport);
  gateways.push(gateway);
  const call = (key = 'one') => gateway.invoke('installation', handle.podId, 1, key, 'report', 0);
  return { service, handle, transport, gateway, call };
}
it('observes usage above the old cap without inventing a token reservation, then replays after restart', async () => {
  const x = await setup();
  expect(await x.call()).toEqual({ state: 'observed', value: 'report' });
  expect(x.service.row('installation', x.handle.podId).consumed_tokens).toBe(6000);
  expect(x.service.expired(x.service.row('installation', x.handle.podId))).toBe(false);
  expect(f.db.prepare('SELECT * FROM managed_provider_allowances').all()).toEqual([]);
  expect(
    new ManagedQuotaBroker(x.service).snapshot('installation', x.handle.podId).tokenUsageKnown,
  ).toBe(true);
  x.gateway.close();
  f.restart();
  const g = new ManagedProviderGateway(f.service(), x.transport);
  gateways.push(g);
  expect(await g.invoke('installation', x.handle.podId, 1, 'one', 'report', 0)).toEqual({
    state: 'observed',
    value: 'report',
  });
  await expect(g.invoke('installation', x.handle.podId, 1, 'two', 'report', 0)).rejects.toThrow(
    'request-limit',
  );
  expect(x.transport.generate).toHaveBeenCalledTimes(1);
});
it('claims one concurrent operation and preserves unknown usage after failure and restart', async () => {
  const x = await setup();
  let fail!: () => void;
  vi.mocked(x.transport.generate).mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        fail = () => reject(Error('uncertain'));
      }),
  );
  const active = x.call();
  expect(await x.call()).toEqual({ state: 'reserved' });
  fail();
  await expect(active).rejects.toThrow('unavailable');
  expect(f.db.prepare('SELECT actual_tokens FROM managed_provider_requests').get()).toEqual({
    actual_tokens: null,
  });
  expect(
    new ManagedQuotaBroker(x.service).snapshot('installation', x.handle.podId).tokenUsageKnown,
  ).toBe(false);
  x.gateway.close();
  f.restart();
  const g = new ManagedProviderGateway(f.service(), x.transport);
  gateways.push(g);
  expect(await g.invoke('installation', x.handle.podId, 1, 'one', 'report', 0)).toEqual({
    state: 'reserved',
  });
  expect(x.transport.generate).toHaveBeenCalledTimes(1);
});
it.each(['revocation', 'expiry', 'duration', 'revision'])(
  'denies cached delivery after %s',
  async (kind) => {
    const x = await setup();
    await x.call();
    if (kind === 'revocation') f.db.prepare('UPDATE managed_pods SET revoked=1').run();
    if (kind === 'expiry') f.advance(401);
    if (kind === 'duration') f.advance(281);
    if (kind === 'revision') f.db.prepare('UPDATE managed_pods SET grant_revision=2').run();
    await expect(x.call()).rejects.toThrow();
    expect(x.transport.generate).toHaveBeenCalledTimes(1);
  },
);
it('rejects mode substitution, token reservation and unmigrated usage before provider calls', async () => {
  const x = await setup();
  await expect(
    x.gateway.invoke('installation', x.handle.podId, 1, 'one', 'report', 4095),
  ).rejects.toThrow('budget-mode');
  const wrong = new ManagedProviderGateway(x.service, { ...x.transport, budgetMode: undefined });
  gateways.push(wrong);
  expect(() => wrong.preflight(f.request)).toThrow('budget-mode');
  f.db.exec('ALTER TABLE managed_provider_requests DROP COLUMN actual_tokens');
  await expect(x.call()).rejects.toThrow('usage-migration');
  expect(x.transport.generate).not.toHaveBeenCalled();
});
it('does not allow changing an active request/time grant to token mode', async () => {
  const x = await setup();
  const grant = structuredClone(f.request.effectiveGrant);
  grant.revision++;
  grant.budget = { expiresAt: 400, maxDurationSeconds: 180, maxTokens: 4096 };
  grant.digest = digest(Object.fromEntries(Object.entries(grant).filter(([k]) => k !== 'digest')));
  expect(() =>
    new ManagedControls(x.service).updateGrant('installation', x.handle.podId, grant),
  ).toThrow('budget-update');
});
