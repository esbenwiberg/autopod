import type { Pod, Profile, ValidationResult } from '@autopod/shared';
import { MAX_DIFF_LENGTH } from '@autopod/shared';
import type { ContainerManager } from '../interfaces/index.js';
import { compactText } from './feedback-compactor.js';
import { formatFeedback } from './feedback-formatter.js';

export interface CorrectionContext {
  task: string;
  customInstructions: string | null;
  failedStep:
    | 'setup'
    | 'lint'
    | 'sast'
    | 'build'
    | 'tests'
    | 'health'
    | 'smoke'
    | 'fact_validation'
    | 'task_review';
  validationResult: ValidationResult;
  previousDiff: string;
  screenshotDescriptions: string[];
  attempt: number;
  maxAttempts: number;
}

const REWORK_DIFF_BUDGET = 12_000;
const CUSTOM_INSTRUCTIONS_BUDGET = 6_000;

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

  // Setup failures
  if (validationResult.setup?.status === 'fail') {
    const out = validationResult.setup.output?.trim();
    screenshotDescriptions.push(out ? `Setup failed:\n${out.slice(0, 2_000)}` : 'Setup failed');
  }

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
  if (result.setup?.status === 'fail') return 'setup';
  if (result.lint?.status === 'fail') return 'lint';
  if (result.sast?.status === 'fail') return 'sast';
  if (result.smoke.build.status === 'fail') return 'build';
  if (result.test?.status === 'fail') return 'tests';
  if (result.smoke.health.status === 'fail') return 'health';
  const hasPageFailure = result.smoke.pages.some((p) => p.status === 'fail');
  if (hasPageFailure) return 'smoke';
  if (result.factValidation?.status === 'fail') return 'fact_validation';
  return 'task_review';
}

export function truncateDiff(diff: string, maxLength: number): string {
  if (diff.length <= maxLength) return diff;
  return `${diff.slice(0, maxLength)}\n... (truncated)`;
}

function changedFilesFromDiff(diff: string): string[] {
  const files = new Set<string>();
  for (const line of diff.split('\n')) {
    if (!line.startsWith('+++ b/') && !line.startsWith('--- a/')) continue;
    const file = line.slice('+++ b/'.length).trim();
    if (file && file !== '/dev/null') files.add(file);
  }
  return [...files].sort();
}

export function isCapsuleCoverageFailure(validationResult: ValidationResult): boolean {
  const output = validationResult.lint?.output ?? '';
  return /capsule check failed|non-capsule commits not covered|changed source\/context files need a capsule/i.test(
    output,
  );
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

  if (isCapsuleCoverageFailure(validationResult)) {
    lines.push('');
    lines.push('### Capsule Coverage Guidance');
    lines.push(
      'Fix the capsule metadata for the final branch state. Extend the relevant capsule `commit_range` so it covers every commit through current `HEAD`, then re-run the same capsule check command.',
    );
    lines.push(
      'Do not archive, move, or rename parent/previous capsules just to satisfy a single-active-capsule check. In a single-PR series, multiple pod capsules may be legitimate; use the repo-supported multi-capsule path when available, or update the shared series capsule.',
    );
  }

  // Add diff context so agent knows what it already changed
  if (context.previousDiff) {
    lines.push('');
    lines.push('### Your Changes So Far');
    const changedFiles = changedFilesFromDiff(context.previousDiff);
    if (changedFiles.length > 0) {
      lines.push('Changed files:');
      for (const file of changedFiles.slice(0, 50)) {
        lines.push(`- ${file}`);
      }
      if (changedFiles.length > 50) {
        lines.push(`- ... ${changedFiles.length - 50} more file(s) omitted`);
      }
      lines.push('');
    }
    lines.push('Compact diff excerpt:');
    lines.push('```diff');
    lines.push(compactText(context.previousDiff, { maxChars: REWORK_DIFF_BUDGET }));
    lines.push('```');
  }

  // Add custom instructions reminder
  if (context.customInstructions) {
    lines.push('');
    lines.push('### Project Instructions (reminder)');
    lines.push(compactText(context.customInstructions, { maxChars: CUSTOM_INSTRUCTIONS_BUDGET }));
  }

  return lines.join('\n');
}
