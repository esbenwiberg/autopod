import { createHash } from 'node:crypto';
import { type Pod, processContent, type RecoveryForkContext } from '@autopod/shared';
import type { EventRepository } from './event-repository.js';
import { recoveryForkError } from './recovery-fork-repository.js';

export function recoveryText(value: string, max: number): string {
  const safe = processContent(value.slice(0, max * 2), {
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
  return Buffer.from(safe)
    .subarray(0, max)
    .toString('utf8')
    .replace(/\uFFFD$/, '');
}
/** Allowlist visible text only. Credential escalations, reasoning and tool payloads never enter. */
export function recoveryForkContext(pod: Pod, events: EventRepository): RecoveryForkContext {
  const visible =
    events.getVisibleRecoveryText?.(pod.id) ??
    recoveryForkError('Bounded visible event projection unavailable');
  const messages: RecoveryForkContext['messages'] = [];
  let remaining = 24_000;
  let truncated = visible.truncated || visible.messages.length > 100;
  for (const row of visible.messages.slice(-100).reverse()) {
    const { text, role } = row;
    const safe = recoveryText(text, Math.min(4000, remaining));
    if (safe.length < text.length) truncated = true;
    remaining -= Buffer.byteLength(safe);
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
    messages: messages.reverse(),
    truncated,
    omissions: [
      'Bounded visible text only. Earlier history, reasoning, tools, credentials, runtime sessions and uncorrelated human replies are omitted. Known credential patterns are redacted; content is not guaranteed secret-free.',
    ],
    reports: [
      ['lastValidationResult.setup.output', pod.lastValidationResult?.setup?.output],
      ['lastValidationResult.smoke.build.output', pod.lastValidationResult?.smoke?.build?.output],
      ['lastValidationResult.test.stdout', pod.lastValidationResult?.test?.stdout],
      ['lastValidationResult.test.stderr', pod.lastValidationResult?.test?.stderr],
    ]
      .filter((row): row is [string, string] => typeof row[1] === 'string' && !!row[1])
      .map(([source, value]) => {
        const text = recoveryText(value, 1000);
        return {
          source,
          timestamp: pod.lastValidationResult!.timestamp,
          sha256: createHash('sha256').update(text).digest('hex'),
          text,
          omissions:
            'Sanitized excerpt, at most 1,000 UTF-8 bytes. Hash identifies this excerpt, not a passing report or the full original output.',
        };
      }),
  };
}
