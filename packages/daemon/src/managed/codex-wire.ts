import type { Route } from '@autopod/shared';
import { z } from 'zod';
import { digest } from './canonical.js';

const messageSchema = z
  .object({
    id: z.string().optional(),
    role: z.enum(['system', 'developer', 'user']),
    type: z.literal('message').optional(),
    content: z.union([
      z.string(),
      z.array(z.object({ type: z.literal('input_text'), text: z.string() }).strict()),
    ]),
  })
  .strict();
const toolsSchema = z
  .object({
    id: z.string().optional(),
    role: z.enum(['system', 'developer']).optional(),
    type: z.literal('additional_tools'),
    tools: z.array(z.unknown()).max(128),
  })
  .strict();
const requestSchema = z
  .object({
    model: z.string(),
    input: z.array(z.union([messageSchema, toolsSchema])).min(1),
    instructions: z.string().optional(),
    reasoning: z
      .object({
        effort: z.string(),
        summary: z.string().optional(),
        context: z.unknown().optional(),
      })
      .strict()
      .optional(),
    tools: z.array(z.unknown()).max(128).optional(),
    tool_choice: z.enum(['auto', 'none']).optional(),
    parallel_tool_calls: z.boolean().optional(),
    stream: z.literal(true),
    store: z.literal(false),
    text: z
      .object({ verbosity: z.enum(['low', 'medium', 'high']) })
      .strict()
      .optional(),
    include: z.array(z.literal('reasoning.encrypted_content')).optional(),
    prompt_cache_key: z.string().optional(),
    client_metadata: z.record(z.string()).optional(),
  })
  .strict();
/** Single report turn only. No tools, files, remote URLs, continuations or worker-selected route. */
export function codexInput(route: Route, raw: string) {
  const request = requestSchema.parse(JSON.parse(raw));
  if (
    route.runtime !== 'codex' ||
    request.model !== route.model ||
    request.reasoning?.effort !== route.reasoning
  )
    throw new Error('managed-codex-route-mismatch');
  // Codex versions encode tool declarations either at the top level or in an
  // additional_tools input item. This explicitly report-only channel strips both.
  const input = request.input.flatMap((item) =>
    item.type === 'additional_tools'
      ? []
      : [{ role: item.role, content: item.content, ...(item.type ? { type: item.type } : {}) }],
  );
  if (!input.length) throw new Error('managed-codex-messages-required');
  return {
    model: route.model,
    input,
    ...(request.instructions === undefined ? {} : { instructions: request.instructions }),
    reasoning: { effort: route.reasoning },
    tools: [],
    truncation: 'disabled',
    ...(request.text ? { text: request.text } : {}),
  };
}
export function codexSse(result: {
  model: string;
  status: 'completed';
  usage: { input_tokens: number; output_tokens: number; total_tokens: number };
  output: (
    | { type: 'message'; role: 'assistant'; content: { type: 'output_text'; text: string }[] }
    | { type: 'reasoning' }
  )[];
}): string {
  const text = result.output
    .flatMap((item) => (item.type === 'message' ? item.content.map((part) => part.text) : []))
    .join('\n');
  if (!text) throw new Error('managed-codex-empty-response');
  // Stable channel IDs identify this replayed representation, not provider receipt IDs.
  const id = digest(result).slice(7, 31);
  const item = {
    id: `msg_${id}`,
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
  const response = {
    id: `resp_${id}`,
    object: 'response',
    created_at: 0,
    model: result.model,
    status: 'completed',
    output: [item],
    usage: result.usage,
  };
  return [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
    {
      type: 'response.output_text.delta',
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  ]
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join('');
}
