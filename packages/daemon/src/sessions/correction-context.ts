import type { Profile, Session, ValidationResult } from '@autopod/shared';
import { MAX_DIFF_LENGTH } from '@autopod/shared';
import type { ContainerManager } from '../interfaces/index.js';
import { formatFeedback } from './feedback-formatter.js';

export interface CorrectionContext {
  task: string;
  customInstructions: string | null;
  failedStep: 'build' | 'health' | 'smoke' | 'ac_validation' | 'task_review';
  validationResult: ValidationResult;
  previousDiff: string;
  screenshotDescriptions: string[];
  attempt: number;
  maxAttempts: number;
}

export async function buildCorrectionContext(
  session: Session,
  profile: Profile,
  validationResult: ValidationResult,
  containerManager: ContainerManager,
): Promise<CorrectionContext> {
  // 1. Get the diff from the container's worktree
  let previousDiff = '';
  if (session.containerId && session.worktreePath) {
    try {
      const result = await containerManager.execInContainer(
        session.containerId,
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
        screenshotDescriptions.push(
          `AC failed: "${check.criterion}" — ${check.reasoning}`,
        );
      }
    }
  }

  // Task review issues
  if (validationResult.taskReview?.status === 'fail') {
    screenshotDescriptions.push(...validationResult.taskReview.issues);
  }

  return {
    task: session.task,
    customInstructions: profile.customInstructions ?? null,
    failedStep,
    validationResult,
    previousDiff: truncateDiff(previousDiff, MAX_DIFF_LENGTH),
    screenshotDescriptions,
    attempt: session.validationAttempts,
    maxAttempts: session.maxValidationAttempts,
  };
}

export function determineFailedStep(result: ValidationResult): CorrectionContext['failedStep'] {
  if (result.smoke.build.status === 'fail') return 'build';
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
  session: Session,
  profile: Profile,
  validationResult: ValidationResult,
  containerManager: ContainerManager,
): Promise<string> {
  const context = await buildCorrectionContext(
    session,
    profile,
    validationResult,
    containerManager,
  );

  const feedback = formatFeedback({
    type: 'validation_failure',
    result: validationResult,
    task: session.task,
    attempt: session.validationAttempts,
    maxAttempts: session.maxValidationAttempts,
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

  return lines.join('\n');
}
