import { AuthError } from '@autopod/shared';
import { type JWK, SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  createEntraAuthModule,
  defaultEntraAudiences,
  defaultEntraIssuers,
} from './entra-auth-module.js';

const TENANT_ID = '0d3aa8f9-8168-4bc2-bda1-c3972e6d9352';
const CLIENT_ID = '3ccd604d-3887-4309-9988-739358fb5811';
const ISSUER = `https://login.microsoftonline.com/${TENANT_ID}/v2.0`;
const AUDIENCE = `api://${CLIENT_ID}`;

async function createFixture() {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const publicJwk = (await exportJWK(publicKey)) as JWK;
  publicJwk.kid = 'test-key';
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';

  const auth = createEntraAuthModule({
    tenantId: TENANT_ID,
    clientId: CLIENT_ID,
    jwks: createLocalJWKSet({ keys: [publicJwk] }),
  });

  const sign = (claims: Record<string, unknown> = {}) =>
    new SignJWT({
      tid: TENANT_ID,
      oid: 'user-123',
      preferred_username: 'esben@example.com',
      name: 'Esben',
      roles: ['admin', 'ignored-role'],
      ...claims,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(String(claims.iss ?? ISSUER))
      .setAudience(String(claims.aud ?? AUDIENCE))
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);

  return { auth, sign };
}

describe('createEntraAuthModule', () => {
  it('validates and maps a tenant token signed by the configured JWKS', async () => {
    const { auth, sign } = await createFixture();
    const token = await sign();

    const payload = await auth.validateToken(token);

    expect(payload).toMatchObject({
      oid: 'user-123',
      preferred_username: 'esben@example.com',
      name: 'Esben',
      aud: AUDIENCE,
      iss: ISSUER,
      roles: ['admin'],
    });
  });

  it('rejects tokens for another audience', async () => {
    const { auth, sign } = await createFixture();
    const token = await sign({ aud: 'api://some-other-app' });

    await expect(auth.validateToken(token)).rejects.toThrow(AuthError);
  });

  it('rejects tokens from another tenant even when issuer validation passed', async () => {
    const { auth, sign } = await createFixture();
    const token = await sign({ tid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });

    await expect(auth.validateToken(token)).rejects.toThrow('Token tenant does not match');
  });

  it('accepts the legacy api://autopod audience for the existing CLI default', () => {
    expect(defaultEntraAudiences(CLIENT_ID)).toContain('api://autopod');
  });

  it('accepts v1 and v2 Entra issuer formats for the configured tenant', () => {
    expect(defaultEntraIssuers(TENANT_ID)).toEqual([
      `https://login.microsoftonline.com/${TENANT_ID}/v2.0`,
      `https://sts.windows.net/${TENANT_ID}/`,
    ]);
  });
});
