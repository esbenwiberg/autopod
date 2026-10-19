import type { Pod, PodStatus, ReviewFeedbackResponseItem } from '@autopod/shared';
import { processContent } from '@autopod/shared';
import type { PrMergeStatus } from '../interfaces/index.js';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import type { PodRepository } from './pod-repository.js';
import { isTerminalState } from './state-machine.js';

export const REVIEW_FEEDBACK_REPLY_MAX_CHARS = 2000;

export const FIX_DELIVERY_FAILED_PREFIX = 'Validated fix could not be pushed';

export function buildPrFixTask(
  pod: Pod,
  status: PrMergeStatus,
  podRepo: PodRepository,
  profile: PodExecutionSettings,
  userMessage?: string,
): string {
  // Walk linkedPodId back to the originating pod (fix→fix→…→original).
  // Prevents nested [PR FIX] boilerplate + duplicate review-comment blocks when a
  // fix pod somehow ends up spawning a sub-fixer. Series pods don't use
  // linkedPodId (they use dependsOnPodIds), so this loop is a no-op for them.
  let ancestor: Pod = pod;
  while (ancestor.linkedPodId) {
    try {
      ancestor = podRepo.getOrThrow(ancestor.linkedPodId);
    } catch {
      break;
    }
  }
  const attempt = pod.linkedPodId
    ? Math.max(ancestor.prFixAttempts ?? 0, 1)
    : (pod.prFixAttempts ?? 0) + 1;
  const iterationLabel = pod.linkedPodId ? `, iteration ${pod.fixIteration ?? 0}` : '';
  const prUrl = pod.prUrl ?? ancestor.prUrl;

  // Single-PR series pods share one branch and one PR, so the per-pod `task`
  // only describes one brief — the cross-brief framing the fixer needs lives
  // in seriesDescription (sourced from briefs/context.md). Stacked-PR series
  // keep their per-pod task because each pod owns its own scoped PR.
  const rootTask =
    ancestor.prMode === 'single' && ancestor.seriesDescription
      ? ancestor.seriesDescription
      : ancestor.task;

  // Sanitize a reviewer-supplied string: quarantine PI, strip PII.
  // Uses the profile's content-processing config when set; falls back to a
  // safe default that enables both PI detection and standard PII removal.
  const sanitizeExternal = (text: string): string =>
    processContent(text, {
      quarantine: profile.contentProcessing?.quarantine ?? { enabled: true },
      sanitization: profile.contentProcessing?.sanitization ?? { preset: 'standard' },
    }).text;

  const sections: string[] = [
    `[PR FIX] The pull request at ${prUrl} needs fixes (attempt ${attempt}${iterationLabel}).`,
    '',
    `Original task: ${rootTask}`,
    '',
    'Your job is to evaluate the failures listed below, fix the ones that make engineering sense, and push commits to the existing branch.',
    'Treat CI failures as objective unless you can show they are unrelated or flaky.',
    'Treat reviewer comments as feedback to assess: fix valid comments; for stale, incorrect, harmful, or out-of-scope comments, leave the code unchanged and explain why.',
    'Do NOT create a new PR — one already exists.',
    'Do NOT call PR/comment APIs from the container. If review comments include a feedbackId, report one `reviewFeedbackResponses` item per feedbackId in `report_task_summary`; the daemon host will post those replies.',
    'Use outcome `fixed` only when the requested change was actually made and verified. Only `fixed` means the daemon may resolve that PR review conversation; `not_applicable`, `needs_reviewer_decision`, and `could_not_verify` leave it open with your explanation.',
    '',
  ];

  if (status.ciFailures.length > 0) {
    sections.push('## CI Check Failures\n');
    for (const ci of status.ciFailures) {
      sections.push(`### ${ci.name} (${ci.conclusion})`);
      if (ci.detailsUrl) sections.push(`Details: ${ci.detailsUrl}`);
      if (ci.annotations.length > 0) {
        sections.push('Annotations:');
        for (const ann of ci.annotations) {
          sections.push(
            `  - ${sanitizeExternal(ann.path)}: ${sanitizeExternal(ann.message)} [${ann.annotationLevel}]`,
          );
        }
      }
      sections.push('');
    }
  }

  if (status.reviewComments.length > 0) {
    sections.push('## Review Comments\n');
    for (const rc of status.reviewComments) {
      const id = rc.id ? `[feedbackId: ${sanitizeExternal(rc.id)}] ` : '';
      const prefix = rc.path ? `\`${sanitizeExternal(rc.path)}\`: ` : '';
      sections.push(`${id}${prefix}${sanitizeExternal(rc.body)}`);
      sections.push('');
    }
  }

  if (userMessage) {
    sections.push('## Instructions from Reviewer\n');
    sections.push(userMessage.trim());
    sections.push('');
  }

  sections.push('After pushing your fixes, the PR will be re-evaluated automatically.');
  return sections.join('\n');
}

export function buildActionableFailureSummary(
  status: PrMergeStatus,
  profile: PodExecutionSettings,
): string {
  const sanitizeExternal = (text: string): string =>
    processContent(text, {
      quarantine: profile.contentProcessing?.quarantine ?? { enabled: true },
      sanitization: profile.contentProcessing?.sanitization ?? { preset: 'standard' },
    }).text;

  const sections: string[] = [];

  if (status.ciFailures.length > 0) {
    sections.push('## CI Check Failures\n');
    for (const ci of status.ciFailures) {
      sections.push(`### ${ci.name} (${ci.conclusion})`);
      if (ci.detailsUrl) sections.push(`Details: ${ci.detailsUrl}`);
      if (ci.annotations.length > 0) {
        sections.push('Annotations:');
        for (const ann of ci.annotations) {
          sections.push(
            `  - ${sanitizeExternal(ann.path)}: ${sanitizeExternal(ann.message)} [${ann.annotationLevel}]`,
          );
        }
      }
      sections.push('');
    }
  }

  if (status.reviewComments.length > 0) {
    sections.push('## Review Comments\n');
    for (const rc of status.reviewComments) {
      const id = rc.id ? `[feedbackId: ${sanitizeExternal(rc.id)}] ` : '';
      const prefix = rc.path ? `\`${sanitizeExternal(rc.path)}\`: ` : '';
      sections.push(`${id}${prefix}${sanitizeExternal(rc.body)}`);
      sections.push('');
    }
  }

  return sections.join('\n').trim();
}

export function formatReviewFeedbackReply(response: ReviewFeedbackResponseItem): string {
  const outcomeLabel: Record<ReviewFeedbackResponseItem['outcome'], string> = {
    fixed: 'Fixed',
    not_applicable: 'Not applicable',
    needs_reviewer_decision: 'Needs reviewer decision',
    could_not_verify: 'Could not verify',
  };
  const body = response.response.trim().slice(0, REVIEW_FEEDBACK_REPLY_MAX_CHARS);
  return `Autopod fix pod response: ${outcomeLabel[response.outcome]}\n\n${body}`;
}

export function createFixCyclePolicy() {
  const isFixCycleTerminal = (status: PodStatus): boolean =>
    isTerminalState(status) || status === 'failed';
  const isFixPodRecyclable = (status: PodStatus): boolean =>
    isFixCycleTerminal(status) || status === 'merge_pending';
  return { isFixCycleTerminal, isFixPodRecyclable };
}
