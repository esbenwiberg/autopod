import type { JwtPayload } from '@autopod/shared';
import Fastify from 'fastify';
import type { FastifyRequest } from 'fastify';
import { expect, it, vi } from 'vitest';
import { fixture } from '../test-utils/managed-fixture.js';
import { MemoryArtifactStore } from './artifact-store.js';
import { managedUserAuthenticator, registerManagedUserRoutes } from './user-auth.js';
const binding = {
  issuer: 'https://issuer/tenant/',
  audience: 'api://autopod',
  objectId: 'owner',
  installationId: 'installation-one',
};
const claims = (): JwtPayload => ({
  iss: binding.issuer,
  aud: binding.audience,
  oid: binding.objectId,
  exp: Date.now() / 1000 + 60,
  iat: 0,
  roles: ['operator'],
  name: 'test',
  preferred_username: 'test',
});
const request = {
  headers: { authorization: 'Bearer fixture', 'x-dispatcher-installation': 'spoof' },
} as unknown as FastifyRequest;
it('pins issuer, audience and object, and checks expiry on every request', async () => {
  for (const change of [
    { iss: 'https://other/' },
    { aud: 'other' },
    { oid: 'other' },
    { oid: 'unenrolled-viewer', roles: ['viewer'] },
    { exp: 0 },
    { exp: Number.NaN },
  ]) {
    const auth = managedUserAuthenticator(
      { validateToken: async () => ({ ...claims(), ...change }) as JwtPayload },
      [binding],
    );
    expect(await auth(request)).toBeNull();
  }
  expect(
    await managedUserAuthenticator({ validateToken: async () => claims() }, [binding])(request),
  ).toBe('installation-one');
});
it('rejects invalid or absent bearer tokens and observes enrollment removal without restart', async () => {
  const bindings = [binding];
  const validateToken = vi.fn(async () => claims());
  const auth = managedUserAuthenticator({ validateToken }, bindings);
  expect(await auth({ headers: {} } as FastifyRequest)).toBeNull();
  expect(validateToken).not.toHaveBeenCalled();
  expect(await auth(request)).toBe('installation-one');
  bindings.length = 0;
  expect(await auth(request)).toBeNull();
  expect(
    await managedUserAuthenticator(
      {
        validateToken: async () => {
          throw new Error('secret');
        },
      },
      [binding],
    )(request),
  ).toBeNull();
  expect(() => managedUserAuthenticator({ validateToken }, [binding, binding])).toThrow(
    'binding-invalid',
  );
});
it('mounts existing managed protocol dark, without changing native routes or spoofing installation', async () => {
  const f = fixture();
  const app = Fastify();
  app.get('/native-fixture', async () => ({ unchanged: true }));
  registerManagedUserRoutes(
    app,
    {
      db: f.db,
      admission: f.admission,
      runtime: f.runtime,
      store: new MemoryArtifactStore(),
      stateRoot: '/fixture',
    },
    {
      validateToken: async (token) => {
        if (token !== 'owner') throw new Error('bad-token');
        return claims();
      },
    },
    [binding],
  );
  try {
    expect((await app.inject('/native-fixture')).json()).toEqual({ unchanged: true });
    expect((await app.inject('/managed/health')).statusCode).toBe(401);
    const headers = { authorization: 'Bearer owner', 'x-dispatcher-installation': 'spoof' };
    expect((await app.inject({ url: '/managed/health', headers })).json().enabled).toBe(false);
    expect(
      (await app.inject({ url: '/managed/pods', method: 'POST', headers, payload: f.request }))
        .statusCode,
    ).toBe(409);
    expect((await app.inject({ url: '/artifacts/foreign', headers })).statusCode).toBe(404);
    expect(f.launches()).toBe(0);
  } finally {
    await app.close();
    f.close();
  }
});

it('uses the existing Entra signature verifier with locally signed tokens, no identity provider call', async () => {
  const { generateKeyPair, SignJWT } = await import('jose');
  const { createEntraAuthModule } = await import('../auth/entra-auth-module.js');
  const keys = await generateKeyPair('RS256');
  const native = createEntraAuthModule({
    tenantId: 'tenant',
    clientId: 'client',
    issuers: [binding.issuer],
    acceptedAudiences: [binding.audience],
    jwks: async () => keys.publicKey,
  });
  const authenticate = managedUserAuthenticator(native, [binding]);
  const sign = async (oid = 'owner', expired = false, alternate = false) => {
    const key = alternate ? (await generateKeyPair('RS256')).privateKey : keys.privateKey;
    return new SignJWT({ oid, roles: ['operator'] })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(binding.issuer)
      .setAudience(binding.audience)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + (expired ? -120 : 60))
      .sign(key);
  };
  const call = async (token: string) =>
    authenticate({ headers: { authorization: `Bearer ${token}` } } as FastifyRequest);
  expect(await call(await sign())).toBe('installation-one');
  expect(await call(await sign('other'))).toBeNull();
  expect(await call(await sign('owner', true))).toBeNull();
  expect(await call(await sign('owner', false, true))).toBeNull();
});

it('accepts an explicitly enrolled Entra CLI user without an application-role claim', async () => {
  const auth = managedUserAuthenticator(
    { validateToken: async () => ({ ...claims(), roles: [] }) },
    [binding],
  );
  expect(await auth(request)).toBe('installation-one');
});
