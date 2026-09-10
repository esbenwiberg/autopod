import type { Route } from '@autopod/shared';
import { z } from 'zod';
import type {
  BoundedProviderTransport,
  ManagedProviderFailureDiagnostic,
  ProviderCredential,
} from './bounded-provider.js';
import { ManagedProviderFailure, responseSchema } from './bounded-provider.js';
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
export interface ChatGptFailureDiagnostic extends ManagedProviderFailureDiagnostic {
  phase: ChatGptFailurePhase;
}
const completedItemSchema = z.object({
  output_index: z.number().int().nonnegative().safe(),
  item: z
    .object({ id: z.string().min(1).max(200), status: z.literal('completed').optional() })
    .passthrough(),
});
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
const REPORT_MAXIMUM_RESPONSE_BYTES = 64 * 1024;
const AGENT_MAXIMUM_RESPONSE_BYTES = 1024 * 1024;
/** One host request under an explicit request/time grant; never a hard token/cost cap. */
export class ChatGptReportTransport implements BoundedProviderTransport {
  readonly budgetMode = 'request-time' as const;
  readonly maximumPromptBytes = 128 * 1024;
  readonly maximumResponseBytes: number;
  readonly bindingDigest: string;
  private readonly route: Route;
  constructor(
    route: Route,
    private readonly chatgptAccountId: string,
    private readonly credential: () => Promise<ChatGptCredential>,
    private readonly transport: typeof fetch = fetch,
    private readonly onFailure?: (diagnostic: ChatGptFailureDiagnostic) => void,
    private readonly mode: 'report' | 'agent' = 'report',
  ) {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(chatgptAccountId))
      throw new Error('managed-account-binding-invalid');
    this.route = structuredClone(route);
    this.maximumResponseBytes =
      mode === 'agent' ? AGENT_MAXIMUM_RESPONSE_BYTES : REPORT_MAXIMUM_RESPONSE_BYTES;
    this.bindingDigest = digest({
      route,
      chatgptAccountId,
      endpoint: 'https://chatgpt.com/backend-api/codex/responses',
      protocol: mode === 'agent' ? 'codex-agent-request-time-v2' : 'codex-report-request-time-v1',
      maximumResponseBytes: this.maximumResponseBytes,
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
    let httpStatus: number | null = null;
    try {
      const normalized = codexInput(route, prompt, this.mode === 'agent');
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
            input.instructions ??
            (this.mode === 'agent'
              ? 'Follow the reviewed task using only locally available tools.'
              : 'Return the requested factual report only. Do not call tools.'),
          stream: true,
          store: false,
        }),
      });
      httpStatus = response.status;
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
      const chunks: Uint8Array[] = [];
      let completed: unknown;
      let completionSeen = false;
      const completedItems: z.infer<typeof responseSchema>['output'] = [];
      const completedItemIds = new Set<string>();
      const orderedItemIds: string[] = [];
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
        // The pinned endpoint may emit complete items but omit them from the
        // terminal response (canary 016). Never reconstruct from text deltas:
        // each item must be complete, schema-valid, uniquely identified and in
        // contiguous output order before the single terminal completion.
        if (
          completionSeen &&
          typeof event.type === 'string' &&
          event.type.startsWith('response.output')
        )
          throw new Error('incomplete');
        if (this.mode === 'report' && event.type === 'response.output_item.done') {
          const itemEvent = completedItemSchema.parse(event);
          if (
            itemEvent.output_index !== completedItems.length ||
            completedItemIds.has(itemEvent.item.id)
          )
            throw new Error('incomplete');
          const item = responseSchema.shape.output.element.parse(itemEvent.item);
          if (item.type === 'message' && itemEvent.item.status !== 'completed')
            throw new Error('incomplete');
          completedItems.push(item);
          completedItemIds.add(itemEvent.item.id);
          orderedItemIds.push(itemEvent.item.id);
        }
        if (event.type === 'response.completed') {
          if (completionSeen) throw new Error('duplicate-completion');
          completionSeen = true;
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
          if (bytes > AGENT_MAXIMUM_RESPONSE_BYTES) throw new Error('response-limit');
          chunks.push(part.value);
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
      if (this.mode === 'agent') {
        const result = z
          .object({
            model: z.string(),
            status: z.literal('completed'),
            usage: z.object({
              input_tokens: z.number().int().nonnegative().safe(),
              output_tokens: z.number().int().nonnegative().safe(),
              total_tokens: z.number().int().nonnegative().safe(),
            }),
          })
          .passthrough()
          .parse(completed);
        if (
          result.model !== route.model ||
          result.usage.total_tokens !== result.usage.input_tokens + result.usage.output_tokens
        )
          throw new Error('usage');
        const value = Buffer.concat(chunks).toString('utf8');
        if (!value || Buffer.byteLength(value) > this.maximumResponseBytes)
          throw new Error('output-size');
        return { value, consumedTokens: result.usage.total_tokens };
      }
      const result = responseSchema.parse(completed);
      if (completedItems.length) {
        if (result.output.length) {
          // A populated terminal response must agree with the completed items;
          // neither representation may override contradictory provider evidence.
          if (canonical(result.output) !== canonical(completedItems)) throw new Error('incomplete');
          const terminal = completed as { output: Array<{ id?: unknown }> };
          if (
            terminal.output.some(
              (item, index) => item.id !== undefined && item.id !== orderedItemIds[index],
            )
          )
            throw new Error('incomplete');
        } else {
          result.output = completedItems;
        }
      }
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
      if (Buffer.byteLength(value) > this.maximumResponseBytes) throw new Error('output-size');
      return { value, consumedTokens: result.usage.total_tokens };
    } catch (error) {
      // Never publish payloads, tokens, provider messages or schema issue values.
      const reason =
        error instanceof Error && failureReasons.has(error.message)
          ? (error.message as ChatGptFailureDiagnostic['reason'])
          : 'unclassified';
      const diagnostic = { phase, reason, httpStatus };
      try {
        this.onFailure?.(diagnostic);
      } catch {
        /* Diagnostics cannot alter outcome. */
      }
      throw new ManagedProviderFailure(diagnostic, 'managed-chatgpt-request-unavailable');
    }
  }
}
