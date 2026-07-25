import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import type { AgentEvent } from '@autopod/shared';
import type { Logger } from 'pino';

/**
 * Parses plain-text output from `copilot -p --no-ask-user` into normalized AgentEvent types.
 *
 * Copilot CLI does not emit structured JSON — output is plain text lines. Each non-empty
 * line is emitted as a status event. The complete event is synthesized when the stream ends.
 */
async function* parse(
  stream: Readable,
  podId: string,
  logger: Logger,
  synthesizeComplete = true,
): AsyncIterable<AgentEvent> {
  const rl = createInterface({ input: stream });
  let hasOutput = false;

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    hasOutput = true;
    logger.debug({
      component: 'copilot-stream-parser',
      podId,
      line: trimmed.slice(0, 200),
      msg: 'Copilot output line',
    });

    yield {
      type: 'status',
      timestamp: new Date().toISOString(),
      message: trimmed.slice(0, 2000),
    };
  }

  if (!synthesizeComplete) return;

  // Standalone parser callers may synthesize completion. The runtime suppresses
  // this until it has authoritative process-exit evidence.
  yield {
    type: 'complete',
    timestamp: new Date().toISOString(),
    result: hasOutput ? 'Copilot agent completed' : 'Copilot agent completed (no output)',
  };
}

export const CopilotStreamParser = { parse } as const;
