import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticateOperatorRequest } from '../api/plugins/auth.js';
import { redactProviderAccountSecrets } from '../api/provider-account-redaction.js';
import type { AuthModule } from '../interfaces/index.js';
import type { ProviderAccountStore } from '../provider-accounts/index.js';

export const candidateAccountIds = ['trial-parent', 'trial-child', 'trial-review'] as const;
const accountId = z.enum(candidateAccountIds);
const codexLogin = z
  .object({
    credentials: z
      .object({
        provider: z.literal('openai'),
        authMode: z.literal('chatgpt'),
        authJson: z
          .string()
          .min(1)
          .max(48 * 1024),
      })
      .strict(),
  })
  .strict();
const opaque = z.string().min(1).regex(/^\S+$/);
const oauthPayload = z
  .object({
    auth_mode: z.literal('chatgpt'),
    OPENAI_API_KEY: z.null().optional(),
    tokens: z
      .object({
        access_token: opaque,
        refresh_token: opaque,
        id_token: opaque.optional(),
        account_id: opaque.max(200),
        // Codex 0.166 persists refresh authority and login identity here.
        oauth_provenance: z
          .object({ issuer: opaque.max(2048), client_id: opaque.max(256) })
          .strict()
          .optional(),
        login_owner_id: opaque.max(256).optional(),
      })
      .strict(),
    last_refresh: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

/** Account setup only: no launch, model call, credential export or provider configuration updates. */
export function registerCandidateAccountSetup(
  app: FastifyInstance,
  auth: AuthModule,
  oid: string,
  accounts: ProviderAccountStore,
  observeOwner?: (binding: { oid: string; issuer: string; audience: string }) => void,
) {
  app.decorateRequest('user', null);
  app.setErrorHandler((_error, _req, reply) => {
    void reply.code(400).send({ error: 'Candidate account setup request refused' });
  });
  app.addHook('onRequest', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    try {
      await authenticateOperatorRequest(req, auth);
      if (req.user.oid !== oid) throw new Error('not the owner');
      observeOwner?.({ oid, issuer: req.user.iss, audience: req.user.aud });
    } catch {
      return reply.code(401).send({ error: 'Candidate owner sign-in required' });
    }
  });
  app.get('/candidate-owner', async (req) => ({
    oid: req.user.oid,
    issuer: req.user.iss,
    audience: req.user.aud,
  }));
  app.get('/provider-accounts', async () =>
    candidateAccountIds.map((id) => redactProviderAccountSecrets(accounts.get(id))),
  );
  app.get('/provider-accounts/:id', async (req) =>
    redactProviderAccountSecrets(accounts.get(accountId.parse((req.params as { id: string }).id))),
  );
  app.patch('/provider-accounts/:id', async (req, reply) => {
    const id = accountId.parse((req.params as { id: string }).id);
    const input = codexLogin.parse(req.body);
    const normalized = oauthPayload.parse(JSON.parse(input.credentials.authJson));
    const existing = accounts.get(id);
    if (existing.provider !== 'openai' || existing.credentials)
      return reply
        .code(409)
        .send({ error: 'Candidate account already configured or not a Codex slot' });
    return redactProviderAccountSecrets(
      accounts.update(id, {
        credentials: { ...input.credentials, authJson: JSON.stringify(normalized) },
      }),
    );
  });
}
