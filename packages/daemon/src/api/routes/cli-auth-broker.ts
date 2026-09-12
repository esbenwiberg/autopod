import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

const TRANSACTION_TTL_MS = 5 * 60 * 1000;
const MAX_STATE_LENGTH = 4096;
const MAX_CODE_LENGTH = 8192;
const MAX_ERROR_LENGTH = 1024;
const MAX_TRANSACTIONS = 256;

interface AuthorizationResponse {
  code?: string;
  error?: string;
  errorDescription?: string;
  state: string;
}

interface Transaction {
  id: string;
  pollTokenHash: Buffer;
  state: string;
  expiresAtMs: number;
  response?: AuthorizationResponse;
}

export interface CliAuthBrokerOptions {
  maxTransactions?: number;
  now?: () => number;
  randomToken?: () => string;
  ttlMs?: number;
}

export class CliAuthBroker {
  private readonly transactions = new Map<string, Transaction>();
  private readonly transactionIdByState = new Map<string, string>();
  private readonly now: () => number;
  private readonly maxTransactions: number;
  private readonly randomToken: () => string;
  private readonly ttlMs: number;

  constructor(options: CliAuthBrokerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxTransactions = options.maxTransactions ?? MAX_TRANSACTIONS;
    this.randomToken = options.randomToken ?? (() => randomBytes(32).toString('base64url'));
    this.ttlMs = options.ttlMs ?? TRANSACTION_TTL_MS;
  }

  create(state: string): { id: string; pollToken: string; expiresAt: string } {
    this.sweepExpired();
    if (!isValidState(state) || this.transactionIdByState.has(state)) {
      throw new Error('invalid-auth-state');
    }
    if (this.transactions.size >= this.maxTransactions) {
      throw new Error('auth-broker-capacity');
    }

    let id = this.randomToken();
    while (this.transactions.has(id)) id = this.randomToken();
    const pollToken = this.randomToken();
    const expiresAtMs = this.now() + this.ttlMs;
    this.transactions.set(id, {
      id,
      pollTokenHash: digest(pollToken),
      state,
      expiresAtMs,
    });
    this.transactionIdByState.set(state, id);
    return { id, pollToken, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  complete(response: AuthorizationResponse): boolean {
    this.sweepExpired();
    const id = this.transactionIdByState.get(response.state);
    const transaction = id ? this.transactions.get(id) : undefined;
    if (!transaction || transaction.response) return false;
    transaction.response = response;
    return true;
  }

  poll(
    id: string,
    pollToken: string,
  ): { status: 'pending' } | { status: 'complete'; response: AuthorizationResponse } | null {
    this.sweepExpired();
    const transaction = this.transactions.get(id);
    if (!transaction || !secureTokenMatches(pollToken, transaction.pollTokenHash)) return null;
    if (!transaction.response) return { status: 'pending' };

    const response = transaction.response;
    this.delete(transaction);
    return { status: 'complete', response };
  }

  cancel(id: string, pollToken: string): boolean {
    this.sweepExpired();
    const transaction = this.transactions.get(id);
    if (!transaction || !secureTokenMatches(pollToken, transaction.pollTokenHash)) return false;
    this.delete(transaction);
    return true;
  }

  private sweepExpired(): void {
    const now = this.now();
    for (const transaction of this.transactions.values()) {
      if (transaction.expiresAtMs <= now) this.delete(transaction);
    }
  }

  private delete(transaction: Transaction): void {
    this.transactions.delete(transaction.id);
    this.transactionIdByState.delete(transaction.state);
  }
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function secureTokenMatches(value: string, expectedHash: Buffer): boolean {
  if (!value) return false;
  const actualHash = digest(value);
  return actualHash.length === expectedHash.length && timingSafeEqual(actualHash, expectedHash);
}

function isValidState(value: string): boolean {
  return value.length >= 16 && value.length <= MAX_STATE_LENGTH && /^[A-Za-z0-9._~-]+$/.test(value);
}

function bounded(value: string | undefined, maximum: number): string | undefined {
  if (!value || value.length > maximum) return undefined;
  return value;
}

const SUCCESS_PAGE =
  '<!doctype html><meta charset="utf-8"><title>Autopod authentication</title>' +
  '<h1>Authentication successful</h1><p>You can close this window.</p>';

export function cliAuthBrokerRoutes(app: FastifyInstance, broker = new CliAuthBroker()): void {
  app.post<{ Body: { state?: string } }>(
    '/auth/cli/transactions',
    { config: { auth: false } },
    async (request, reply) => {
      const state = request.body?.state;
      if (!state) return reply.status(400).send({ code: 'invalid-auth-state' });
      try {
        return reply.status(201).send(broker.create(state));
      } catch (error) {
        const code = error instanceof Error ? error.message : 'invalid-auth-state';
        if (code === 'auth-broker-capacity') {
          return reply.status(503).send({ code });
        }
        return reply.status(400).send({ code: 'invalid-auth-state' });
      }
    },
  );

  app.get<{
    Querystring: { code?: string; error?: string; error_description?: string; state?: string };
  }>('/auth/cli/callback', { config: { auth: false } }, async (request, reply) => {
    const state = bounded(request.query.state, MAX_STATE_LENGTH);
    const code = bounded(request.query.code, MAX_CODE_LENGTH);
    const error = bounded(request.query.error, MAX_ERROR_LENGTH);
    const errorDescription = bounded(request.query.error_description, MAX_ERROR_LENGTH);
    if (!state || (!code && !error)) {
      return reply.status(400).type('text/plain').send('Invalid authentication response');
    }
    if (
      !broker.complete({
        state,
        ...(code ? { code } : {}),
        ...(error ? { error } : {}),
        ...(errorDescription ? { errorDescription } : {}),
      })
    ) {
      return reply.status(400).type('text/plain').send('Authentication transaction unavailable');
    }
    return reply
      .header('cache-control', 'no-store')
      .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'")
      .header('referrer-policy', 'no-referrer')
      .header('x-content-type-options', 'nosniff')
      .type('text/html')
      .send(SUCCESS_PAGE);
  });

  app.get<{ Params: { id: string } }>(
    '/auth/cli/transactions/:id',
    { config: { auth: false } },
    async (request, reply) => {
      const pollToken = request.headers['x-autopod-auth-transaction'];
      const token = Array.isArray(pollToken) ? pollToken[0] : pollToken;
      const result = broker.poll(request.params.id, token ?? '');
      if (!result) return reply.status(404).send({ code: 'auth-transaction-unavailable' });
      if (result.status === 'pending') return reply.status(202).send(result);
      return reply.header('cache-control', 'no-store').send(result);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/auth/cli/transactions/:id',
    { config: { auth: false } },
    async (request, reply) => {
      const pollToken = request.headers['x-autopod-auth-transaction'];
      const token = Array.isArray(pollToken) ? pollToken[0] : pollToken;
      if (!broker.cancel(request.params.id, token ?? '')) {
        return reply.status(404).send({ code: 'auth-transaction-unavailable' });
      }
      return reply.status(204).send();
    },
  );
}
