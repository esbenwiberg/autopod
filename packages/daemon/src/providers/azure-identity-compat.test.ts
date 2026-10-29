import { describe, expect, it } from 'vitest';
import {
  IDENTITY_FIXTURE_SCOPE,
  IDENTITY_FIXTURE_TENANT,
  createIdentityCompatibilityFixture,
} from '../test-utils/azure-identity-compat-helpers.js';

describe('actual Azure Identity/MSAL compatibility (in-memory HTTP only)', () => {
  it('preserves tenant-bound confidential-client token acquisition and cache behavior', async () => {
    const s = createIdentityCompatibilityFixture();
    const first = await s.credential.getToken(IDENTITY_FIXTURE_SCOPE).catch((error) => {
      throw new Error(`In-memory SDK protocol fixture failed: ${JSON.stringify(s.requests)}`, {
        cause: error,
      });
    });
    expect(first.token).toBe('fixture-access-token');
    expect(first.expiresOnTimestamp).toBeGreaterThan(Date.now());
    const posts = s.requests.filter((request) => request.method === 'POST');
    expect(posts).toHaveLength(1);
    const tokenUrl = new URL(posts[0]?.url ?? 'https://invalid.invalid');
    expect(tokenUrl.origin + tokenUrl.pathname).toBe(
      `https://login.microsoftonline.com/${IDENTITY_FIXTURE_TENANT}/oauth2/v2.0/token`,
    );
    const body = new URLSearchParams(posts[0]?.body);
    expect(body.get('grant_type')).toBe('client_credentials');
    expect(body.get('scope')).toContain(IDENTITY_FIXTURE_SCOPE);
    expect(body.get('client_id')).toBe('22222222-2222-4222-8222-222222222222');
    const second = await s.credential.getToken(IDENTITY_FIXTURE_SCOPE);
    expect(second.token).toBe(first.token);
    expect(s.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
  });
  it('does not silently switch to an unapproved tenant or contact an alternate auth endpoint', async () => {
    const s = createIdentityCompatibilityFixture();
    await expect(
      s.credential.getToken(IDENTITY_FIXTURE_SCOPE, {
        tenantId: '33333333-3333-4333-8333-333333333333',
      }),
    ).rejects.toThrow(/tenant/i);
    expect(s.requests).toEqual([]);
  });
});
