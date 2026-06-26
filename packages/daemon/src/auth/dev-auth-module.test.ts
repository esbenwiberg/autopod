import { AuthError } from '@autopod/shared';
import { describe, expect, it } from 'vitest';
import { createDevAuthModule } from './dev-auth-module.js';

describe('createDevAuthModule', () => {
  it('accepts the configured dev token', async () => {
    const auth = createDevAuthModule({
      allowDevAuth: true,
      devToken: 'abc123',
      isDev: true,
    });

    const payload = await auth.validateToken('abc123');

    expect(payload).toMatchObject({
      oid: 'dev-user',
      preferred_username: 'developer',
      roles: ['admin'],
      aud: 'autopod',
      iss: 'autopod-dev',
    });
  });

  it('rejects a non-matching dev token', async () => {
    const auth = createDevAuthModule({
      allowDevAuth: true,
      devToken: 'abc123',
      isDev: true,
    });

    await expect(auth.validateToken('wrong')).rejects.toThrow(AuthError);
    await expect(auth.validateToken('wrong')).rejects.toThrow('Invalid dev auth token');
  });

  it('rejects when dev auth is disabled', async () => {
    const auth = createDevAuthModule({
      allowDevAuth: false,
      devToken: 'abc123',
      isDev: true,
    });

    await expect(auth.validateToken('abc123')).rejects.toThrow(
      'Dev auth not enabled — set AUTOPOD_ALLOW_DEV_AUTH=1',
    );
  });
});
