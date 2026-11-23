import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import type { AuthModule } from '../interfaces/index.js';
import type { ProviderAccountStore } from '../provider-accounts/index.js';
import {
  candidateAccountIds,
  registerCandidateAccountSetup,
} from './parent-candidate-account-setup.js';

it('only the bound owner can populate empty trial accounts and no credential is returned', async () => {
  const app = Fastify();
  const accounts = new Map(
    candidateAccountIds.map((id) => [
      id,
      { id, name: id, provider: 'openai', credentials: null as unknown },
    ]),
  );
  const update = vi.fn((id, input) => {
    const account = { ...accounts.get(id), credentials: input.credentials };
    accounts.set(id, account as never);
    return account;
  });
  const auth = {
    async validateToken(token: string) {
      return { oid: token };
    },
  } as AuthModule;
  registerCandidateAccountSetup(app, auth, 'fixture-owner', {
    get: (id: (typeof candidateAccountIds)[number]) => accounts.get(id),
    update,
  } as unknown as ProviderAccountStore);
  const headers = { authorization: 'Bearer fixture-owner' };
  const login = {
    credentials: {
      provider: 'openai',
      authMode: 'chatgpt',
      authJson: JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: {
          access_token: 'inert-fixture-value',
          refresh_token: 'inert-fixture-refresh',
          account_id: 'fixture',
          oauth_provenance: { issuer: 'https://fixture.example', client_id: 'fixture-client' },
          login_owner_id: 'fixture-login',
        },
      }),
    },
  };
  const patch = (payload: object, id = 'trial-child', token = 'fixture-owner') =>
    app.inject({
      method: 'PATCH',
      url: '/provider-accounts/' + id,
      headers: { authorization: 'Bearer ' + token },
      payload,
    });
  try {
    expect((await patch(login, 'trial-child', 'fixture-other')).statusCode).toBe(401);
    expect((await patch(login, 'outside-trial')).statusCode).toBe(400);
    expect((await patch({ ...login, failoverPolicy: {} })).statusCode).toBe(400);
    expect(
      (await patch({ credentials: { ...login.credentials, authJson: 'invalid' } })).statusCode,
    ).toBe(400);
    expect(
      (
        await patch({
          credentials: {
            ...login.credentials,
            authJson: JSON.stringify({
              auth_mode: 'chatgpt',
              tokens: { access_token: 'inert', account_id: 'fixture' },
            }),
          },
        })
      ).statusCode,
    ).toBe(400);
    const raw = JSON.parse(login.credentials.authJson);
    for (const authJson of [
      { ...raw, OPENAI_API_KEY: 'inert-not-oauth' },
      {
        ...raw,
        tokens: { ...raw.tokens, oauth_provenance: { issuer: 'https://fixture.example' } },
      },
    ]) {
      expect(
        (await patch({ credentials: { ...login.credentials, authJson: JSON.stringify(authJson) } }))
          .statusCode,
      ).toBe(400);
    }
    expect(update).not.toHaveBeenCalled();
    const first = await patch(login);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      id: 'trial-child',
      hasCredentials: true,
      credentials: { provider: 'openai' },
    });
    expect(first.body).not.toContain('inert-fixture-value');
    expect(JSON.parse(update.mock.calls[0]?.[1].credentials.authJson)).toMatchObject({
      tokens: {
        oauth_provenance: { issuer: 'https://fixture.example', client_id: 'fixture-client' },
        login_owner_id: 'fixture-login',
      },
    });
    expect((await patch(login)).statusCode).toBe(409);
    expect(update).toHaveBeenCalledOnce();
    const list = await app.inject({ url: '/provider-accounts', headers });
    expect(list.json().map((a: { id: string }) => a.id)).toEqual(candidateAccountIds);
    expect(list.body).not.toContain('inert-fixture-value');
    expect((await app.inject({ method: 'POST', url: '/pods', headers })).statusCode).toBe(404);
    expect(
      (await app.inject({ method: 'POST', url: '/orchestration/runs/trial/start', headers }))
        .statusCode,
    ).toBe(404);
  } finally {
    await app.close();
  }
});
