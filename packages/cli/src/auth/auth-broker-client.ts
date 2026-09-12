import { fetch as undiciFetch } from 'undici';

const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export interface BrokeredAuthorizationResponse {
  code?: string;
  error?: string;
  errorDescription?: string;
  state: string;
}

interface BrokerTransaction {
  expiresAt: string;
  id: string;
  pollToken: string;
}

export interface CliAuthBrokerClientOptions {
  fetcher?: typeof fetch;
  now?: () => number;
  pollIntervalMs?: number;
  wait?: (milliseconds: number) => Promise<void>;
}

export class CliAuthBrokerClient {
  readonly callbackUrl: string;
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly pollIntervalMs: number;
  private readonly wait: (milliseconds: number) => Promise<void>;

  constructor(baseUrl: string, options: CliAuthBrokerClientOptions = {}) {
    const parsed = new URL(baseUrl);
    const isLocal = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname);
    if (parsed.username || parsed.password) {
      throw new Error('Auth broker URL must not contain credentials');
    }
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocal)) {
      throw new Error('Auth broker requires HTTPS except for localhost development');
    }
    this.baseUrl = parsed.toString().replace(/\/+$/, '');
    this.callbackUrl = `${this.baseUrl}/auth/cli/callback`;
    this.fetcher = options.fetcher ?? (undiciFetch as unknown as typeof fetch);
    this.now = options.now ?? Date.now;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.wait =
      options.wait ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async waitForAuthorization(
    expectedState: string,
    startBrowser: () => Promise<void> = async () => undefined,
  ): Promise<BrokeredAuthorizationResponse> {
    const transaction = await this.createTransaction(expectedState);
    let complete = false;
    try {
      await startBrowser();
      while (this.now() < Date.parse(transaction.expiresAt)) {
        const response = await this.fetcher(
          `${this.baseUrl}/auth/cli/transactions/${encodeURIComponent(transaction.id)}`,
          {
            headers: { 'x-autopod-auth-transaction': transaction.pollToken },
            signal: AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS),
          },
        );
        if (response.status === 202) {
          await this.wait(this.pollIntervalMs);
          continue;
        }
        if (!response.ok) throw new Error('Authentication transaction became unavailable');

        const body = (await response.json()) as {
          response?: BrokeredAuthorizationResponse;
          status?: string;
        };
        if (body.status !== 'complete' || !body.response) {
          throw new Error('Authentication broker returned an invalid response');
        }
        if (body.response.state !== expectedState) {
          throw new Error('Authentication response state mismatch');
        }
        if (body.response.error) {
          const detail = boundedMessage(body.response.errorDescription ?? body.response.error);
          throw new Error(`Authentication failed: ${detail}`);
        }
        if (!body.response.code) throw new Error('Authentication response did not contain a code');
        complete = true;
        return body.response;
      }
      throw new Error('Authentication timed out before the browser response arrived');
    } finally {
      if (!complete) await this.cancel(transaction).catch(() => undefined);
    }
  }

  private async createTransaction(state: string): Promise<BrokerTransaction> {
    const response = await this.fetcher(`${this.baseUrl}/auth/cli/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state }),
      signal: AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(
        response.status === 404
          ? 'This daemon does not support brokered CLI authentication'
          : 'Could not start brokered CLI authentication',
      );
    }
    const transaction = (await response.json()) as Partial<BrokerTransaction>;
    if (
      !transaction.id ||
      !transaction.pollToken ||
      !transaction.expiresAt ||
      !Number.isFinite(Date.parse(transaction.expiresAt))
    ) {
      throw new Error('Authentication broker returned an invalid transaction');
    }
    return transaction as BrokerTransaction;
  }

  private async cancel(transaction: BrokerTransaction): Promise<void> {
    await this.fetcher(
      `${this.baseUrl}/auth/cli/transactions/${encodeURIComponent(transaction.id)}`,
      {
        method: 'DELETE',
        headers: { 'x-autopod-auth-transaction': transaction.pollToken },
        signal: AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS),
      },
    );
  }
}

function boundedMessage(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').slice(0, 500);
}
