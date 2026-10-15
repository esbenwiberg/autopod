import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { requestTimeFixture, resign } from '../test-utils/managed-fixture.js';
import { digest } from './canonical.js';
import { ManagedPublicReadGateway, publicAddress, publicUrl } from './public-read-gateway.js';

it('refuses private, loopback, cloud metadata, mapped and reserved addresses', () => {
  for (const address of [
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '168.63.129.16',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    'fd00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '2001:db8::1',
    '2002:7f00:0001::1',
  ])
    expect(publicAddress(address)).toBe(false);
  expect(publicAddress('1.1.1.1')).toBe(true);
  expect(publicAddress('2606:4700:4700::1111')).toBe(true);
});

it('accepts public HTTPS reads and refuses credentials, private names and non-GET transports', () => {
  expect(publicUrl('https://api.github.com/orgs/vercel-labs/repos?sort=created').hostname).toBe(
    'api.github.com',
  );
  for (const url of [
    'http://example.org',
    'https://localhost',
    'https://metadata.internal/path',
    'https://127.0.0.1/',
    'https://example.org:3100/',
    'https://user:password@example.org/',
    'https://example.org/?access_token=secret',
    'file:///etc/passwd',
  ])
    expect(() => publicUrl(url)).toThrow();
});

it('requires the existing active grant and persists replayable read evidence without credentials', async () => {
  const f = requestTimeFixture();
  try {
    f.db.exec(
      readFileSync(
        new URL('../db/migrations/209_managed_public_reads.sql', import.meta.url),
        'utf8',
      ),
    );
    for (const scope of [f.request.profileSnapshot.scope, f.request.effectiveGrant.scope])
      scope.allowedEffects.push('web.public-read');
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
    const handle = await service.start('installation-one', f.request);
    const transport = vi.fn(async (url: string) =>
      JSON.stringify({ url, status: 200, body: 'source evidence' }),
    );
    const gateway = new ManagedPublicReadGateway(service, transport);
    const raw = JSON.stringify({ url: 'https://example.org/research' });
    const first = await gateway.invoke('installation-one', handle.podId, 1, 'read-one', raw);
    expect(await gateway.invoke('installation-one', handle.podId, 1, 'read-one', raw)).toEqual(
      first,
    );
    expect(transport).toHaveBeenCalledTimes(1);
    await expect(
      gateway.invoke(
        'installation-one',
        handle.podId,
        1,
        'read-one',
        JSON.stringify({ url: 'https://other.example/research' }),
      ),
    ).rejects.toThrow('managed-public-replay-conflict');
    f.db.prepare('UPDATE managed_pods SET revoked=1 WHERE pod_id=?').run(handle.podId);
    await expect(
      gateway.invoke('installation-one', handle.podId, 1, 'read-two', raw),
    ).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
  } finally {
    f.close();
  }
});
