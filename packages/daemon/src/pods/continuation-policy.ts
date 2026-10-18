import type { Pod } from '@autopod/shared';
import { processContent } from '@autopod/shared';
import { formatFeedback } from './feedback-formatter.js';

export const REWORK_IN_PROGRESS_PREFIX = '[REWORK IN PROGRESS]';

export function sanitizeSecurityReworkValue(value: string | undefined, fallback: string): string {
  const normalized = value?.replace(/\s+/g, ' ').trim().slice(0, 400);
  if (!normalized) return fallback;
  const processed = processContent(normalized, {
    quarantine: { enabled: true },
    sanitization: { preset: 'standard' },
  });
  if (processed.quarantined) return fallback;
  const sanitized = processed.text.trim();
  return sanitized || fallback;
}

export function buildManualReworkReason(
  pod: Pod,
  blockedPushScan?: import('../security/index.js').StoredScan,
): string {
  const fallback =
    pod.status === 'failed'
      ? 'Your previous attempt failed. Review what went wrong and try again.'
      : pod.status === 'review_required'
        ? 'Your previous attempt exhausted its validation attempts. Review what went wrong and try again with extended attempts.'
        : pod.status === 'killed'
          ? 'Your previous pod was killed. Start the task fresh.'
          : 'Your previous work needs revision. Review and improve it.';

  if (pod.lastValidationResult?.overall === 'fail') {
    const feedback = formatFeedback({
      type: 'validation_failure',
      result: pod.lastValidationResult,
      task: pod.task,
      attempt: pod.lastValidationResult.attempt ?? pod.validationAttempts,
      maxAttempts: pod.maxValidationAttempts,
    });

    return [
      pod.status === 'review_required'
        ? 'Manual rework after validation attempts were exhausted. Fix the failed validation and review items below.'
        : 'Manual rework after validation failure. Fix the failed validation and review items below.',
      '',
      feedback,
    ].join('\n');
  }

  if (blockedPushScan?.decision !== 'block') return fallback;

  return [
    'Manual rework after the pre-push security scan blocked this pod.',
    '',
    'Inspect and fix the underlying code or fixture while preserving its intended behavior. Then let the normal pre-push security scan verify the remediation.',
    'Do not bypass, disable, or suppress the scanner, and do not weaken security policy or tests merely to pass.',
    '',
    'Blocked findings (structured metadata only; no matched content):',
    ...blockedPushScan.findings.map((finding, index) => {
      const detector = sanitizeSecurityReworkValue(finding.detector, 'unknown detector');
      const severity = sanitizeSecurityReworkValue(finding.severity, 'unknown severity');
      const rule = finding.ruleId
        ? `; rule=${sanitizeSecurityReworkValue(finding.ruleId, 'unknown rule')}`
        : '';
      const file = sanitizeSecurityReworkValue(finding.file, 'unknown file');
      const line = finding.line === undefined ? '' : `:${finding.line}`;
      return `${index + 1}. detector=${detector}; severity=${severity}${rule}; location=${file}${line}`;
    }),
  ].join('\n');
}

/** Render the in-workspace pi-handoff.md file body. A short managed-file banner
 * makes clear to the human/agent that it is Autopod-managed and git-excluded,
 * followed by the raw persisted instructions verbatim. */
export function renderPiHandoffFile(instructions: string): string {
  return [
    "<!-- Autopod-managed: a copy of this pod's handoff instructions.",
    '     Git-excluded — edits here are not tracked and will not be committed',
    '     unless you `git add -f` this path. -->',
    '',
    '# Pi handoff',
    '',
    instructions.trim(),
    '',
  ].join('\n');
}
