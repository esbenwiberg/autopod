import type { FastifyRequest } from 'fastify';
import { expect, it } from 'vitest';
import { fixture } from '../test-utils/managed-fixture.js';
import { MemoryArtifactStore } from './artifact-store.js';
import { managedComponents, servicePrincipal } from './bootstrap.js';

it('composition stays dark and only an authenticated pinned certificate binds the installation', async () => {
  const f = fixture();
  try {
    const components = managedComponents({
      db: f.db,
      admission: f.admission,
      runtime: f.runtime,
      store: new MemoryArtifactStore(),
      stateRoot: '/fixture',
    });
    expect(components.service.health().enabled).toBe(false);
    await expect(components.service.start('installation-one', f.request)).rejects.toThrow(
      'disabled',
    );
    expect(f.launches()).toBe(0);
    const request = (socket: object) =>
      ({
        raw: { socket },
        headers: { 'x-dispatcher-installation': 'installation-one' },
      }) as unknown as FastifyRequest;
    const principals = new Map([['fixture-fingerprint', 'installation-one']]);
    expect(servicePrincipal(request({}), principals)).toBeNull();
    expect(
      servicePrincipal(
        request({
          encrypted: true,
          authorized: false,
          getPeerCertificate: () => ({ fingerprint256: 'fixture-fingerprint' }),
        }),
        principals,
      ),
    ).toBeNull();
    expect(
      servicePrincipal(
        request({
          encrypted: true,
          authorized: true,
          getPeerCertificate: () => ({ fingerprint256: 'fixture-fingerprint' }),
        }),
        principals,
      ),
    ).toBe('installation-one');
    expect(
      servicePrincipal(
        request({
          encrypted: true,
          authorized: true,
          getPeerCertificate: () => ({ fingerprint256: 'other' }),
        }),
        principals,
      ),
    ).toBeNull();
  } finally {
    f.close();
  }
});
