import type { Logger } from 'pino';
import { z } from 'zod';
import {
  chatGptCredential,
  type ManagedProviderAccountReader,
} from '../managed/acceptance-config.js';
import { ManagedProviderFailure } from '../managed/bounded-provider.js';
import { digest } from '../managed/canonical.js';
import { ChatGptReportTransport } from '../managed/chatgpt-provider.js';
import {
  assertRouteAccountHealthy,
  type ProviderAccountHealthStore,
} from '../provider-accounts/provider-account-health.js';

export const inspectionCodexPin = z
  .object({
    kind: z.literal('inspection-codex-v1'),
    accountId: z.literal('openai-projectum'),
    model: z.literal('gpt-5.6-sol'),
    reasoning: z.literal('low'),
    budgetMode: z.literal('request-time'),
    timeoutMs: z.literal(30000),
  })
  .strict();
type Pin = z.infer<typeof inspectionCodexPin>;
const prompt = z
  .object({
    model: z.literal('gpt-5.6-sol'),
    max_tokens: z.literal(0),
    system: z.string().min(1),
    messages: z.tuple([z.object({ role: z.literal('user'), content: z.string().min(1) }).strict()]),
  })
  .strict();

const maxWireBytes = 8192;
interface InspectionContext {
  phase: string;
  results?: { finding?: { status: string; text?: string; truncated?: boolean } }[];
}

/** Fit only report excerpts. Keep metadata intact and measure the normalized transport
 * envelope, including JSON escaping of both the context and the input_text field. */
function boundedWire(body: string, ctx: InspectionContext) {
  if (Buffer.byteLength(body) <= maxWireBytes) return body;
  if (ctx.phase !== 'results') throw new Error('controller-request-limit');
  const excerpts = ctx.results?.flatMap(({ finding }) =>
    finding?.status === 'excerpt' && finding.text?.trim()
      ? [
          {
            finding,
            points: Array.from(finding.text.trimStart()),
            original: finding.text,
            wasTruncated: finding.truncated,
          },
        ]
      : [],
  );
  if (!excerpts?.length) throw new Error('controller-request-limit');
  const envelope = JSON.parse(body);
  let low = 1;
  let high = Math.max(...excerpts.map((e) => e.points.length));
  let fit: string | undefined;
  while (low <= high) {
    const n = Math.floor((low + high) / 2);
    for (const { finding, points, original, wasTruncated } of excerpts) {
      finding.text = points.slice(0, n).join('');
      finding.truncated = finding.text !== original || wasTruncated;
    }
    envelope.input[0].content[0].text = JSON.stringify(ctx);
    const candidate = JSON.stringify(envelope);
    if (Buffer.byteLength(candidate) <= maxWireBytes) {
      fit = candidate;
      low = n + 1;
    } else high = n - 1;
  }
  if (!fit) throw new Error('controller-request-limit');
  return fit;
}

// No profile lookup, env credentials, or provider calls during daemon composition.
export function bindInspectionCodex(
  pin: Pin,
  accounts: ManagedProviderAccountReader,
  health: Pick<ProviderAccountHealthStore, 'current'>,
  logger: Logger,
  wire: typeof fetch = fetch,
) {
  const p = inspectionCodexPin.parse(pin);
  const route = {
    providerAccountId: p.accountId,
    model: p.model,
    reasoning: p.reasoning,
    runtime: 'codex',
    executionTarget: 'local',
  } as const;
  const validate = () =>
    assertRouteAccountHealthy({ providerAccountId: p.accountId, failover: [] }, health);
  let sent = 0;
  return {
    model: p.model,
    async requestTimeTurn(
      body: unknown,
      reserve: (principalDigest: string) => void,
      wakeDigest: string,
    ) {
      const b = prompt.parse(body),
        ctx = JSON.parse(b.messages[0].content) as InspectionContext;
      if (!['kickoff', 'results'].includes(ctx.phase)) throw new Error('controller-request-shape');
      const deadline = performance.now() + p.timeoutMs;
      const signal = AbortSignal.timeout(p.timeoutMs);
      const checkTime = () => {
        signal.throwIfAborted();
        if (performance.now() >= deadline) throw new Error('controller-provider-aborted');
      };
      validate();
      const credential = () => chatGptCredential(accounts, p.accountId);
      let charged = false;
      const principal = credential().chatgptAccountId;
      const principalDigest = digest(['inspection-codex-principal/v1', p.accountId, principal]);
      const transport = new ChatGptReportTransport(
        route,
        principal,
        async () => credential(),
        async (url, init) => {
          if (
            String(url) !== 'https://chatgpt.com/backend-api/codex/responses' ||
            sent >= 2 ||
            init?.redirect !== 'error' ||
            init.signal !== signal ||
            typeof init.body !== 'string'
          )
            throw new Error('controller-request-limit');
          const outbound = boundedWire(init.body, ctx);
          validate();
          checkTime();
          reserve(principalDigest);
          charged = true;
          sent++;
          checkTime();
          return wire(url, { ...init, body: outbound });
        },
      );
      try {
        const { report } = await transport.generate(
          route,
          JSON.stringify({
            model: p.model,
            reasoning: { effort: p.reasoning },
            instructions: b.system,
            input: b.messages.map(({ role, content }) => ({
              type: 'message',
              role,
              content: [{ type: 'input_text', text: content }],
            })),
            stream: true,
            store: false,
          }),
          0,
          signal,
          checkTime,
        );
        if (!report) throw new Error('controller-provider-response-unreadable');
        return {
          content: [{ type: 'text' as const, text: report.text }],
          stop_reason: 'end_turn',
          usage: report.usage,
        };
      } catch (err) {
        const status = err instanceof ManagedProviderFailure ? err.diagnostic.httpStatus : null;
        const reason = !charged
          ? 'controller-request-not-sent'
          : status && status >= 300 && status <= 599
            ? `controller-provider-http-${status}`
            : signal.aborted || performance.now() >= deadline
              ? 'controller-provider-aborted'
              : status === null
                ? 'controller-provider-no-response'
                : 'controller-provider-response-unreadable';
        logger.warn(
          {
            reason,
            phase: ctx.phase,
            httpStatus: status,
            wakeDigest: /^sha256:[a-f0-9]{64}$/.test(wakeDigest) ? wakeDigest : undefined,
          },
          'Inspection controller request failed',
        );
        throw new Error(reason);
      }
    },
  };
}
