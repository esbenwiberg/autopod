import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PodTokenIssuer } from '../../crypto/pod-tokens.js';
import type { AuthModule } from '../../interfaces/index.js';
import { errorHandler } from '../error-handler.js';
import { authPlugin } from './auth.js';

function makeIssuer(): PodTokenIssuer {
  const valid = new Map<string, string>();
  return {
    generate(podId: string) {
      const tok = `tok-${podId}-test`;
      valid.set(tok, podId);
      return tok;
    },
    verify(token: string) {
      return valid.get(token) ?? null;
    },
  };
}

const acceptAllAuth: AuthModule = {
  validateToken: async () => ({
    oid: 'u1',
    preferred_username: 'test',
    name: 'T',
    roles: [],
    aud: '',
    iss: '',
    exp: 9999999999,
    iat: 0,
  }),
  validateTokenSync: () => ({
    oid: 'u1',
    preferred_username: 'test',
    name: 'T',
    roles: [],
    aud: '',
    iss: '',
    exp: 9999999999,
    iat: 0,
  }),
};

describe('authPlugin', () => {
  let app: FastifyInstance;
  let issuer: PodTokenIssuer;

  beforeEach(async () => {
    issuer = makeIssuer();
    app = Fastify({ logger: false });
    app.setErrorHandler(errorHandler);
    authPlugin(app, acceptAllAuth, issuer);

    // A pod-token-protected route at /pods/:podId/preview (mirrors production)
    app.post('/pods/:podId/preview', { config: { auth: 'pod-token' } }, async () => ({ ok: true }));
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('rejects ?token= query-param for pod-token routes (fix 1.4)', async () => {
    const token = issuer.generate('pod-abc');
    const res = await app.inject({
      method: 'POST',
      url: `/pods/pod-abc/preview?token=${encodeURIComponent(token)}`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('accepts valid Bearer token for pod-token routes', async () => {
    const token = issuer.generate('pod-abc');
    const res = await app.inject({
      method: 'POST',
      url: '/pods/pod-abc/preview',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('rejects missing token for pod-token routes', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/pods/pod-abc/preview',
    });
    expect(res.statusCode).toBe(401);
  });
});
