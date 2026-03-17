import type { Logger } from 'pino';
import type { InjectedClaudeMdSection } from '@autopod/shared';

export interface ResolvedSection {
  heading: string;
  content: string;
  priority: number;
}

/**
 * Resolve CLAUDE.md sections — fetches dynamic content where configured.
 * Never throws. Failed fetches are logged and silently skipped (or fall back to static content).
 */
export async function resolveSections(
  sections: InjectedClaudeMdSection[],
  logger: Logger,
): Promise<ResolvedSection[]> {
  const results = await Promise.allSettled(
    sections.map(s => resolveOne(s, logger)),
  );

  return results
    .filter((r): r is PromiseFulfilledResult<ResolvedSection | null> => r.status === 'fulfilled')
    .map(r => r.value)
    .filter((s): s is ResolvedSection => s !== null);
}

async function resolveOne(
  section: InjectedClaudeMdSection,
  logger: Logger,
): Promise<ResolvedSection | null> {
  const parts: string[] = [];

  // Static content
  if (section.content) {
    parts.push(section.content);
  }

  // Dynamic fetch
  if (section.fetch) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        section.fetch.timeoutMs ?? 10_000,
      );

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (section.fetch.authorization) {
        headers['Authorization'] = section.fetch.authorization;
      }

      const res = await fetch(section.fetch.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(section.fetch.body ?? {}),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!res.ok) {
        logger.warn(
          { heading: section.heading, status: res.status },
          'CLAUDE.md section fetch failed',
        );
      } else {
        const text = await res.text();
        const truncated = truncateToTokenBudget(text, section.maxTokens ?? 4000);
        parts.push(truncated);
      }
    } catch (err) {
      logger.warn(
        { err, heading: section.heading },
        'CLAUDE.md section fetch error — skipping',
      );
    }
  }

  if (parts.length === 0) return null;

  return {
    heading: section.heading,
    content: parts.join('\n\n'),
    priority: section.priority ?? 50,
  };
}

/** ~4 chars per token heuristic (same as Prism's truncator) */
function truncateToTokenBudget(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '\n\n(truncated)';
}
