import type { Session, ValidationResult, Profile } from '@autopod/shared';
import { MAX_DIFF_LENGTH } from '@autopod/shared';
import type { ContainerManager } from '../interfaces/index.js';
import { formatFeedback } from './feedback-formatter.js';

export interface CorrectionContext {
  task: string;
  customInstructions: string | null;
  failedStep: 'build' | 'health' | 'smoke' | 'task_review';
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
        { cwd: session.worktreePath },
      );
      previousDiff = result.stdout;
    } catch {
      // Container might not have commits yet — that's fine
      previousDiff = '';
    }
  }

  // 2. Determine which step failed first
  const failedStep = determineFailedStep(validationResult);

  // 3. If task review failed, grab text descriptions of what went wrong
  const screenshotDescriptions: string[] = [];
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
  const hasPageFailure = result.smoke.pages.some(p => p.status === 'fail');
  if (hasPageFailure) return 'smoke';
  return 'task_review';
}

export function truncateDiff(diff: string, maxLength: number): string {
  if (diff.length <= maxLength) return diff;
  return diff.slice(0, maxLength) + '\n... (truncated)';
}

export async function buildCorrectionMessage(
  session: Session,
  profile: Profile,
  validationResult: ValidationResult,
  containerManager: ContainerManager,
): Promise<string> {
  const context = await buildCorrectionContext(
    session, profile, validationResult, containerManager,
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
