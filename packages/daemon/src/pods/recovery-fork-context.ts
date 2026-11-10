import { type Pod, processContent, type RecoveryForkContext } from '@autopod/shared';
import type { EventRepository } from './event-repository.js';
import { recoveryForkError } from './recovery-fork-repository.js';

export function recoveryText(value: string, max: number): string {
  return processContent(value.slice(0, max * 2), {
    sanitization: { preset: 'standard' },
    quarantine: { enabled: true },
  })
    .text.replace(
      /\b((?:api[_-]?key|token|password|secret|authorization)\s*[:=]\s*)[^\s,;]+/gi,
      '$1[redacted]',
    )
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, 'https://[redacted]@')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
    .slice(0, max);
}
/** Allowlist visible text only. Credential escalations, reasoning and tool payloads never enter. */
export function recoveryForkContext(pod: Pod, events: EventRepository): RecoveryForkContext {
  const visible =
    events.getVisibleRecoveryText?.(pod.id) ??
    recoveryForkError('Bounded visible event projection unavailable');
  const messages: RecoveryForkContext['messages'] = [];
  let remaining = 24_000;
  let truncated = visible.truncated;
  for (const row of visible.messages) {
    const { text, role } = row;
    const safe = recoveryText(text, Math.min(4000, remaining));
    if (safe.length < text.length) truncated = true;
    remaining -= safe.length;
    if (safe) messages.push({ role, text: safe, timestamp: row.timestamp, eventId: row.eventId });
    if (remaining <= 0) {
      truncated = true;
      break;
    }
  }
  return {
    summary: recoveryText(
      `Original task (${pod.id}): ${pod.task}\n${pod.taskSummary?.actualSummary ?? ''}\nOriginal history: /pods/${pod.id}`,
      8000,
    ),
    failure: recoveryText(
      pod.failureReason ?? pod.lastCorrectionMessage ?? 'No visible failure description recorded.',
      4000,
    ),
    messages,
    truncated,
    omissions: [
      'Bounded visible text only. Earlier history, reasoning, tools, credentials, runtime sessions and uncorrelated human replies are omitted. Known credential patterns are redacted; content is not guaranteed secret-free.',
    ],
  };
}
