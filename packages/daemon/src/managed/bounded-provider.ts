import type { Route } from '@autopod/shared';
import { z } from 'zod';
import { canonical, digest } from './canonical.js';
import { codexInput, codexSse } from './codex-wire.js';

export interface BoundedProviderTransport {
  /** Non-secret digest of endpoint, exact route and supported authentication mode. */
  readonly bindingDigest: string;
  readonly budgetMode?: 'request-time';
  readonly maximumPromptBytes?: number;
  /** Maximum validated wire response persisted and returned by the trusted gateway. */
  readonly maximumResponseBytes?: number;
  /** Reviewed wall-clock ceiling for one provider request. */
  readonly maximumRequestDurationMs?: number;
  preflight(route: Route): void;
  generate(
    route: Route,
    prompt: string,
    maximumTokens: number,
    signal: AbortSignal,
    assertActive: () => void,
  ): Promise<{ value: string; consumedTokens: number }>;
}
export interface ManagedProviderFailureDiagnostic {
  phase:
    | 'request'
    | 'credential'
    | 'http'
    | 'stream'
    | 'response-schema'
    | 'model'
    | 'usage'
    | 'artifact'
    | 'wire-response';
  reason:
    | 'account'
    | 'http'
    | 'stream-read'
    | 'incomplete'
    | 'duplicate-completion'
    | 'response-limit'
    | 'usage'
    | 'artifact-size'
    | 'output-size'
    | 'timeout'
    | 'authority'
    | 'unclassified';
  httpStatus: number | null;
}

export const MANAGED_PROVIDER_ABORT_TIMEOUT = 'managed-provider-timeout';
export const MANAGED_PROVIDER_ABORT_AUTHORITY = 'managed-provider-authority-inactive';

/** Carries only schema-bounded diagnostics. Provider bodies, prompts and credentials are excluded. */
export class ManagedProviderFailure extends Error {
  constructor(
    readonly diagnostic: ManagedProviderFailureDiagnostic,
    message = 'managed-provider-request-unavailable',
  ) {
    super(message);
  }
}
export interface ProviderCredential {
  accountId: string;
  mode: 'api-key' | 'chatgpt';
  token: string;
}
const countSchema = z.object({
  object: z.literal('response.input_tokens'),
  input_tokens: z.number().int().nonnegative().safe(),
});
export const responseSchema = z.object({
  model: z.string(),
  status: z.literal('completed'),
  usage: z.object({
    input_tokens: z.number().int().nonnegative().safe(),
    output_tokens: z.number().int().nonnegative().safe(),
    total_tokens: z.number().int().nonnegative().safe(),
  }),
  output: z.array(
    z.discriminatedUnion('type', [
      z.object({
        type: z.literal('message'),
        role: z.literal('assistant'),
        content: z.array(z.object({ type: z.literal('output_text'), text: z.string() })),
      }),
      z.object({
        type: z.literal('reasoning'),
        id: z.string(),
        summary: z.array(z.object({ type: z.literal('summary_text'), text: z.string() })),
      }),
    ]),
  ),
});

/** Explicit API transport. ChatGPT credentials are never substituted or sent to the API. */
export class BoundedResponsesTransport implements BoundedProviderTransport {
  readonly bindingDigest: string;
  readonly maximumPromptBytes: number;
  private readonly route: Route;
  constructor(
    route: Route,
    private readonly mode: ProviderCredential['mode'],
    private readonly credential: () => Promise<ProviderCredential>,
    private readonly transport: typeof fetch = fetch,
    private readonly format: 'text' | 'codex-report' = 'text',
  ) {
    this.route = structuredClone(route);
    this.maximumPromptBytes = format === 'codex-report' ? 128 * 1024 : 16384;
    this.bindingDigest = digest({
      route: this.route,
      mode,
      endpoint: 'https://api.openai.com/v1',
      protocol: 'bounded-responses-v1',
      format,
    });
  }
  preflight(route: Route): void {
    if (canonical(route) !== canonical(this.route))
      throw new Error('managed-provider-route-mismatch');
    if (this.mode !== 'api-key') throw new Error('managed-provider-hard-token-ceiling-unavailable');
  }
  async generate(
    route: Route,
    prompt: string,
    maximumTokens: number,
    signal: AbortSignal,
    assertActive: () => void,
  ) {
    this.preflight(route);
    if (
      !prompt ||
      Buffer.byteLength(prompt) > this.maximumPromptBytes ||
      !Number.isSafeInteger(maximumTokens) ||
      maximumTokens < 2
    )
      throw new Error('managed-provider-request-invalid');
    try {
      signal.throwIfAborted();
      assertActive();
      const input =
        this.format === 'codex-report'
          ? codexInput(route, prompt)
          : {
              model: route.model,
              input: prompt,
              reasoning: { effort: route.reasoning },
              tools: [],
              truncation: 'disabled',
            };
      const credential = await this.credential();
      if (
        credential.mode !== this.mode ||
        credential.accountId !== route.providerAccountId ||
        !credential.token ||
        /[\r\n]/.test(credential.token)
      )
        throw new Error('binding');
      const post = async (path: string, body: object) => {
        signal.throwIfAborted();
        assertActive();
        const response = await this.transport(`https://api.openai.com/v1/${path}`, {
          method: 'POST',
          redirect: 'error',
          signal,
          headers: {
            Authorization: `Bearer ${credential.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          throw new Error('http');
        }
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
          while (true) {
            signal.throwIfAborted();
            assertActive();
            const part = await reader.read();
            if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > 128 * 1024) throw new Error('response-limit');
            chunks.push(part.value);
          }
        } finally {
          await reader.cancel();
        }
        signal.throwIfAborted();
        assertActive();
        return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
      };
      const count = countSchema.parse(await post('responses/input_tokens', input)).input_tokens;
      const outputBudget = maximumTokens - count;
      if (outputBudget < 16) throw new Error('input-budget-exhausted');
      const result = responseSchema.parse(
        await post('responses', {
          ...input,
          max_output_tokens: outputBudget,
          store: false,
          stream: false,
        }),
      );
      if (
        result.model !== route.model ||
        result.usage.input_tokens !== count ||
        result.usage.output_tokens > outputBudget ||
        result.usage.total_tokens !== result.usage.input_tokens + result.usage.output_tokens ||
        result.usage.total_tokens > maximumTokens
      )
        throw new Error('usage-binding');
      const value = result.output
        .flatMap((item) => (item.type === 'message' ? item.content.map((part) => part.text) : []))
        .join('\n');
      if (!value || Buffer.byteLength(value) > 65536) throw new Error('output-limit');
      const output = this.format === 'codex-report' ? codexSse(result) : value;
      if (Buffer.byteLength(output) > 65536) throw new Error('output-limit');
      return { value: output, consumedTokens: result.usage.total_tokens };
    } catch {
      // Never propagate network errors, provider bodies, credentials or authentication metadata.
      throw new Error('managed-provider-request-unavailable');
    }
  }
}
