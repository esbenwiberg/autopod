import type { InjectedClaudeMdSection, ProcessContentConfig } from '@autopod/shared';
import { collectPiiPatternNames, processContent } from '@autopod/shared';
import type { Logger } from 'pino';
import type { SafetyEventsRepository } from '../safety/safety-events-repository.js';

export interface ResolvedSection {
  heading: string;
  content: string;
  priority: number;
}

export interface ResolveSectionsOptions {
  /** Content processing config for sanitizing fetched content */
  contentProcessing?: ProcessContentConfig;
  /** Safety events repository for writing per-pattern detection rows */
  safetyEventsRepo?: SafetyEventsRepository;
  /** Pod id to attribute safety events to */
  podId?: string;
}

const DEFAULT_CONTENT_PROCESSING: ProcessContentConfig = {
  sanitization: { preset: 'standard' },
  quarantine: { enabled: true },
};

/**
 * Resolve CLAUDE.md sections — fetches remote content where configured.
 * Never throws. Failed fetches are logged and silently skipped (or fall back to static content).
 * Fetched content is always processed through quarantine + PII sanitization.
 */
export async function resolveSections(
  sections: InjectedClaudeMdSection[],
  logger: Logger,
  options?: ResolveSectionsOptions,
): Promise<ResolvedSection[]> {
  const results = await Promise.allSettled(sections.map((s) => resolveOne(s, logger, options)));

  return results
    .filter((r): r is PromiseFulfilledResult<ResolvedSection | null> => r.status === 'fulfilled')
    .map((r) => r.value)
    .filter((s): s is ResolvedSection => s !== null);
}

async function resolveOne(
  section: InjectedClaudeMdSection,
  logger: Logger,
  options?: ResolveSectionsOptions,
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
      const timeout = setTimeout(() => controller.abort(), section.fetch.timeoutMs ?? 10_000);

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (section.fetch.authorization) {
        headers.Authorization = section.fetch.authorization;
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
        const rawText = await res.text();
        // Always sanitize fetched content — external sources are untrusted
        const cfg = options?.contentProcessing ?? DEFAULT_CONTENT_PROCESSING;
        const processed = processContent(rawText, cfg);
        const text = processed.text;
        if (processed.quarantined) {
          logger.warn(
            { heading: section.heading },
            'Fetched CLAUDE.md section content quarantined',
          );
        }

        // Write per-pattern safety_events rows (non-fatal)
        if (options?.safetyEventsRepo && options.podId) {
          const repo = options.safetyEventsRepo;
          const podId = options.podId;
          const excerpt = text.slice(0, 256) || null;
          try {
            for (const threat of processed.threats) {
              repo.insert({
                podId,
                source: 'claude_md_section',
                kind: 'injection',
                patternName: threat.pattern,
                severity: threat.severity,
                payloadExcerpt: excerpt,
              });
            }
            if (processed.sanitized) {
              // PII: collect patterns from raw pre-sanitize text (written alongside any injection rows)
              for (const name of collectPiiPatternNames(rawText)) {
                repo.insert({
                  podId,
                  source: 'claude_md_section',
                  kind: 'pii',
                  patternName: name,
                  severity: null,
                  payloadExcerpt: excerpt,
                });
              }
            }
          } catch (err) {
            logger.warn(
              { err, heading: section.heading },
              'Failed to write safety events for section',
            );
          }
        }

        const truncated = truncateToTokenBudget(text, section.maxTokens ?? 4000);
        parts.push(truncated);
      }
    } catch (err) {
      logger.warn({ err, heading: section.heading }, 'CLAUDE.md section fetch error — skipping');
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
  return `${text.slice(0, maxChars)}\n\n(truncated)`;
}
