import type { Route } from '@autopod/shared';
import type { BoundedProviderTransport, ProviderCredential } from './bounded-provider.js';
import { responseSchema } from './bounded-provider.js';
import { canonical, digest } from './canonical.js';
import { codexInput, codexSse } from './codex-wire.js';

export interface ChatGptCredential extends ProviderCredential {
  mode: 'chatgpt';
  chatgptAccountId: string;
}
export type ChatGptFailurePhase =
  | 'request'
  | 'credential'
  | 'http'
  | 'stream'
  | 'response-schema'
  | 'model'
  | 'usage'
  | 'artifact'
  | 'wire-response';
export interface ChatGptFailureDiagnostic {
  phase: ChatGptFailurePhase;
  reason:
    | 'account'
    | 'http'
    | 'incomplete'
    | 'duplicate-completion'
    | 'response-limit'
    | 'usage'
    | 'artifact-size'
    | 'output-size'
    | 'unclassified';
}
const failureReasons = new Set([
  'account',
  'http',
  'incomplete',
  'duplicate-completion',
  'response-limit',
  'usage',
  'artifact-size',
  'output-size',
]);
/** One host request under an explicit request/time grant; never a hard token/cost cap. */
export class ChatGptReportTransport implements BoundedProviderTransport {
  readonly budgetMode = 'request-time' as const;
  readonly maximumPromptBytes = 128 * 1024;
  readonly bindingDigest: string;
  private readonly route: Route;
  constructor(
    route: Route,
    private readonly chatgptAccountId: string,
    private readonly credential: () => Promise<ChatGptCredential>,
    private readonly transport: typeof fetch = fetch,
    private readonly onFailure?: (diagnostic: ChatGptFailureDiagnostic) => void,
  ) {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(chatgptAccountId))
      throw new Error('managed-account-binding-invalid');
    this.route = structuredClone(route);
    this.bindingDigest = digest({
      route,
      chatgptAccountId,
      endpoint: 'https://chatgpt.com/backend-api/codex/responses',
      protocol: 'codex-report-request-time-v1',
    });
  }
  preflight(route: Route) {
    if (canonical(route) !== canonical(this.route) || route.runtime !== 'codex')
      throw new Error('managed-provider-route-mismatch');
  }
  async generate(
    route: Route,
    prompt: string,
    maximumTokens: number,
    signal: AbortSignal,
    assertActive: () => void,
  ) {
    this.preflight(route);
    if (maximumTokens !== 0 || Buffer.byteLength(prompt) > this.maximumPromptBytes)
      throw new Error('managed-provider-budget-mode-mismatch');
    let phase: ChatGptFailurePhase = 'request';
    try {
      const normalized = codexInput(route, prompt);
      const { truncation: _truncation, ...input } = normalized;
      signal.throwIfAborted();
      assertActive();
      phase = 'credential';
      const credential = await this.credential();
      if (
        credential.mode !== 'chatgpt' ||
        credential.accountId !== route.providerAccountId ||
        credential.chatgptAccountId !== this.chatgptAccountId ||
        !credential.token ||
        /[\r\n]/.test(credential.token)
      )
        throw new Error('account');
      signal.throwIfAborted();
      assertActive();
      phase = 'http';
      const response = await this.transport('https://chatgpt.com/backend-api/codex/responses', {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: {
          Authorization: `Bearer ${credential.token}`,
          'ChatGPT-Account-Id': this.chatgptAccountId,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          originator: 'codex_cli_rs',
        },
        body: JSON.stringify({
          ...input,
          instructions:
            input.instructions ?? 'Return the requested factual report only. Do not call tools.',
          stream: true,
          store: false,
        }),
      });
      // The pinned ChatGPT endpoint can omit Content-Type (live canary 014).
      // Only the missing-header case joins SSE parsing; a declared different
      // media type is still refused. Completion, model, usage and byte limits
      // below remain mandatory before any response is returned to the worker.
      const contentType = response.headers.get('content-type');
      if (
        !response.ok ||
        !response.body ||
        (contentType !== null &&
          contentType.split(';', 1)[0]?.trim().toLowerCase() !== 'text/event-stream')
      ) {
        await response.body?.cancel();
        throw new Error('http');
      }
      phase = 'stream';
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let buffer = '';
      let bytes = 0;
      let completed: unknown;
      const consume = (line: string) => {
        if (!line.startsWith('data:')) return;
        const raw = line.slice(5).trim();
        if (!raw || raw === '[DONE]') return;
        const event = JSON.parse(raw);
        if (
          event.type === 'response.failed' ||
          event.type === 'error' ||
          event.type === 'response.incomplete'
        )
          throw new Error('incomplete');
        if (event.type === 'response.completed') {
          if (completed !== undefined) throw new Error('duplicate-completion');
          completed = event.response;
        }
      };
      try {
        while (true) {
          signal.throwIfAborted();
          assertActive();
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > 1024 * 1024) throw new Error('response-limit');
          buffer += decoder.decode(part.value, { stream: true });
          let newline = buffer.indexOf('\n');
          while (newline >= 0) {
            consume(buffer.slice(0, newline).replace(/\r$/, ''));
            buffer = buffer.slice(newline + 1);
            newline = buffer.indexOf('\n');
          }
        }
        buffer += decoder.decode();
        if (buffer.trim()) consume(buffer);
      } finally {
        await reader.cancel();
      }
      signal.throwIfAborted();
      assertActive();
      phase = 'response-schema';
      const result = responseSchema.parse(completed);
      phase = 'model';
      if (result.model !== route.model) throw new Error('usage');
      phase = 'usage';
      if (result.usage.total_tokens !== result.usage.input_tokens + result.usage.output_tokens)
        throw new Error('usage');
      phase = 'artifact';
      const text = result.output
        .flatMap((item) => (item.type === 'message' ? item.content.map((part) => part.text) : []))
        .join('\n');
      if (!text || Buffer.byteLength(text) > 16384) throw new Error('artifact-size');
      phase = 'wire-response';
      const value = codexSse(result);
      if (Buffer.byteLength(value) > 65536) throw new Error('output-size');
      return { value, consumedTokens: result.usage.total_tokens };
    } catch (error) {
      // Never publish payloads, tokens, provider messages or schema issue values.
      const reason =
        error instanceof Error && failureReasons.has(error.message)
          ? (error.message as ChatGptFailureDiagnostic['reason'])
          : 'unclassified';
      try {
        this.onFailure?.({ phase, reason });
      } catch {
        /* Diagnostics cannot alter outcome. */
      }
      throw new Error('managed-chatgpt-request-unavailable');
    }
  }
}
