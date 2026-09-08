import { expect, it } from 'vitest';
import { fixture } from '../test-utils/managed-fixture.js';
import { managedComponents } from './bootstrap.js';
import { composeDarkManagedCli, parseManagedCliConfig } from './cli-config.js';
const input = {
  bindings: [
    {
      issuer: 'https://issuer/',
      audience: 'api://autopod',
      objectId: 'owner',
      installationId: 'installation-one',
    },
  ],
  blobContainerUrl: 'https://fixture.blob.core.windows.net/private',
};
it('startup remains absent by default; explicit config is strict and forbids dev auth or enabling workers', () => {
  expect(parseManagedCliConfig(undefined, true)).toBeUndefined();
  for (const value of [
    { ...input, enabled: true },
    { ...input, token: 'secret' },
    { ...input, bindings: [] },
    { ...input, bindings: [...input.bindings, ...input.bindings] },
    { ...input, blobContainerUrl: 'http://other' },
  ])
    expect(() => parseManagedCliConfig(JSON.stringify(value), false)).toThrow(
      'managed-cli-config-invalid',
    );
  expect(() => parseManagedCliConfig(JSON.stringify(input), true)).toThrow(
    'managed-cli-config-invalid',
  );
  expect(() => parseManagedCliConfig('secret', false)).toThrow('managed-cli-config-invalid');
});
it('dark composition permits terminal history but cannot replace a live runtime', async () => {
  const f = fixture();
  try {
    const config = parseManagedCliConfig(JSON.stringify(input), false);
    const value = composeDarkManagedCli(config, f.db, '/data/autopod/autopod.db');
    expect(value?.config.enabled).toBe(false);
    expect(value?.config.stateRoot).toBe('/data/autopod/managed');
    if (!value) throw new Error('expected-composition');
    const components = managedComponents(value.config);
    await expect(components.service.start('installation-one', f.request)).rejects.toThrow(
      'disabled',
    );
    expect(f.launches()).toBe(0);
    await expect(
      f.service().start('installation-one', f.request, 'after-reservation'),
    ).rejects.toThrow('injected-after-reservation');
    expect(() => composeDarkManagedCli(config, f.db, '/data/autopod/autopod.db')).toThrow(
      'runtime-composition-required',
    );
    f.db
      .prepare("UPDATE managed_pods SET revoked=1,stop_requested=1,observed_exit=1,state='killed'")
      .run();
    expect(composeDarkManagedCli(config, f.db, '/data/autopod/autopod.db')?.config.enabled).toBe(
      false,
    );
  } finally {
    f.close();
  }
});
