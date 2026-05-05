import type { Pod, Profile, ValidationResult } from '@autopod/shared';
import { MAX_DIFF_LENGTH } from '@autopod/shared';
import type { ContainerManager } from '../interfaces/index.js';
import { formatFeedback } from './feedback-formatter.js';

export interface CorrectionContext {
  task: string;
  customInstructions: string | null;
  failedStep:
    | 'lint'
    | 'sast'
    | 'build'
    | 'tests'
    | 'health'
    | 'smoke'
    | 'ac_validation'
    | 'task_review';
  validationResult: ValidationResult;
  previousDiff: string;
  screenshotDescriptions: string[];
  attempt: number;
  maxAttempts: number;
}

export async function buildCorrectionContext(
  pod: Pod,
  profile: Profile,
  validationResult: ValidationResult,
  containerManager: ContainerManager,
): Promise<CorrectionContext> {
  // 1. Get the diff from the container's worktree
  let previousDiff = '';
  if (pod.containerId && pod.worktreePath) {
    try {
      const result = await containerManager.execInContainer(
        pod.containerId,
        ['git', 'diff', 'HEAD~1'],
        { cwd: '/workspace' },
      );
      previousDiff = result.stdout;
    } catch {
      // Container might not have commits yet — that's fine
      previousDiff = '';
    }
  }

  // 2. Determine which step failed first
  const failedStep = determineFailedStep(validationResult);

  // 3. Grab text descriptions of what went wrong
  const screenshotDescriptions: string[] = [];

  // Lint failures
  if (validationResult.lint?.status === 'fail') {
    const out = validationResult.lint.output?.trim();
    screenshotDescriptions.push(out ? `Lint failed:\n${out.slice(0, 2_000)}` : 'Lint failed');
  }

  // SAST failures
  if (validationResult.sast?.status === 'fail') {
    const out = validationResult.sast.output?.trim();
    screenshotDescriptions.push(
      out ? `Security scan failed:\n${out.slice(0, 2_000)}` : 'Security scan failed',
    );
  }

  // Test failures
  if (validationResult.test?.status === 'fail') {
    const testOutput = [validationResult.test.stdout, validationResult.test.stderr]
      .filter(Boolean)
      .join('\n')
      .trim();
    screenshotDescriptions.push(
      testOutput ? `Tests failed:\n${testOutput.slice(0, 2_000)}` : 'Tests failed',
    );
  }

  // Page validation failures
  const failedPages = validationResult.smoke.pages.filter((p) => p.status === 'fail');
  for (const page of failedPages) {
    const parts: string[] = [`Page ${page.path} failed:`];
    if (page.consoleErrors.length > 0) {
      parts.push(`  Console errors: ${page.consoleErrors.slice(0, 5).join('; ')}`);
    }
    const failedAssertions = page.assertions.filter((a) => !a.passed);
    for (const a of failedAssertions) {
      parts.push(
        `  Assertion failed: ${a.selector} (${a.type}) — expected "${a.expected}", got "${a.actual}"`,
      );
    }
    screenshotDescriptions.push(parts.join('\n'));
  }

  // AC validation failures
  if (validationResult.acValidation?.status === 'fail') {
    for (const check of validationResult.acValidation.results) {
      if (!check.passed) {
        screenshotDescriptions.push(`AC failed: "${check.criterion}" — ${check.reasoning}`);
      }
    }
  }

  // Task review issues
  if (validationResult.taskReview?.status === 'fail') {
    screenshotDescriptions.push(...validationResult.taskReview.issues);
  }

  return {
    task: pod.task,
    customInstructions: profile.customInstructions ?? null,
    failedStep,
    validationResult,
    previousDiff: truncateDiff(previousDiff, MAX_DIFF_LENGTH),
    screenshotDescriptions,
    attempt: pod.validationAttempts,
    maxAttempts: pod.maxValidationAttempts,
  };
}

export function determineFailedStep(result: ValidationResult): CorrectionContext['failedStep'] {
  // Order matches the validation engine's pipeline order so the first failing
  // gate wins — that's the one the agent should focus on fixing first.
  if (result.lint?.status === 'fail') return 'lint';
  if (result.sast?.status === 'fail') return 'sast';
  if (result.smoke.build.status === 'fail') return 'build';
  if (result.test?.status === 'fail') return 'tests';
  if (result.smoke.health.status === 'fail') return 'health';
  const hasPageFailure = result.smoke.pages.some((p) => p.status === 'fail');
  if (hasPageFailure) return 'smoke';
  if (result.acValidation?.status === 'fail') return 'ac_validation';
  return 'task_review';
}

export function truncateDiff(diff: string, maxLength: number): string {
  if (diff.length <= maxLength) return diff;
  return `${diff.slice(0, maxLength)}\n... (truncated)`;
}

export async function buildCorrectionMessage(
  pod: Pod,
  profile: Profile,
  validationResult: ValidationResult,
  containerManager: ContainerManager,
): Promise<string> {
  const context = await buildCorrectionContext(pod, profile, validationResult, containerManager);

  const feedback = formatFeedback({
    type: 'validation_failure',
    result: validationResult,
    task: pod.task,
    attempt: pod.validationAttempts,
    maxAttempts: pod.maxValidationAttempts,
  });

  const lines: string[] = [feedback];

  // Add diff context so agent knows what it already changed
  if (context.previousDiff) {
    lines.push('');
    lines.push('### Your Changes So Far');
    lines.push('```diff');
    lines.push(context.previousDiff);
    lines.push('```');
  }

  // Add custom instructions reminder
  if (context.customInstructions) {
    lines.push('');
    lines.push('### Project Instructions (reminder)');
    lines.push(context.customInstructions);
  }

  // Surface AC self-verification discrepancies
  const selfReport = pod.acSelfReport;
  if (selfReport?.length && validationResult.acValidation?.status === 'fail') {
    const failingCriteria = validationResult.acValidation.results
      .filter((r) => r.status === 'fail')
      .map((r) => r.criterion);

    const falsePositives = selfReport.filter(
      (r) => r.verified && failingCriteria.some((f) => f === r.criterion),
    );

    if (falsePositives.length) {
      lines.push('');
      lines.push('### Self-Verification Discrepancy');
      lines.push('You marked these criteria as verified, but the automated validator disagrees:');
      for (const r of falsePositives) {
        lines.push(`- ${r.criterion}${r.notes ? ` (your notes: ${r.notes})` : ''}`);
      }
      lines.push('Revise your implementation — these are not passing.');
    }
  }

  return lines.join('\n');
}
