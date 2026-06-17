import type { EscalationResponse, ValidationResult } from '@autopod/shared';
import { compactText } from './feedback-compactor.js';

export interface FeedbackOptions {
  task: string;
  attempt: number;
  maxAttempts: number;
}

export interface ValidationFeedback extends FeedbackOptions {
  type: 'validation_failure';
  result: ValidationResult;
}

export interface RejectionFeedback extends FeedbackOptions {
  type: 'human_rejection';
  feedback: string;
  previousStatus: 'validated' | 'failed' | 'review_required';
}

export interface EscalationFeedback {
  type: 'escalation_response';
  question: string;
  response: EscalationResponse;
}

export type FeedbackInput = ValidationFeedback | RejectionFeedback | EscalationFeedback;

const COMMAND_OUTPUT_BUDGET = 6_000;
const REVIEW_TEXT_BUDGET = 4_000;
const ORIGINAL_TASK_BUDGET = 4_000;

export function formatFeedback(input: FeedbackInput): string {
  switch (input.type) {
    case 'validation_failure':
      return formatValidationFailure(input);
    case 'human_rejection':
      return formatHumanRejection(input);
    case 'escalation_response':
      return formatEscalationResponse(input);
  }
}

function formatValidationFailure(input: ValidationFeedback): string {
  const { result, task, attempt, maxAttempts } = input;
  const lines: string[] = [];

  lines.push(`## Validation Failed (attempt ${attempt}/${maxAttempts})`);
  lines.push('');
  lines.push('Your changes did not pass validation. Fix the issues below and try again.');
  lines.push('');

  // Setup errors
  if (result.setup?.status === 'fail') {
    lines.push('### Setup Errors');
    if (result.setup.output) {
      lines.push('```');
      lines.push(compactText(result.setup.output, { maxChars: COMMAND_OUTPUT_BUDGET }));
      lines.push('```');
    }
    lines.push('');
  }

  // Build errors
  if (result.smoke.build.status === 'fail') {
    lines.push('### Build Errors');
    lines.push('```');
    lines.push(compactText(result.smoke.build.output, { maxChars: COMMAND_OUTPUT_BUDGET }));
    lines.push('```');
    lines.push('');
    lines.push(
      'After fixing, re-run the build phase with `validate_locally({ "phases": ["build"] })`.',
    );
    lines.push('');
  }

  // Health check failure
  if (result.smoke.health.status === 'fail') {
    lines.push('### Health Check Failed');
    lines.push(`The app did not respond at \`${result.smoke.health.url}\` within the timeout.`);
    lines.push(`Response code: ${result.smoke.health.responseCode ?? 'none'}`);

    // Include the start command output — this is where the actual crash/error reason lives
    if (result.smoke.health.startOutput) {
      lines.push('');
      lines.push('**Start command output** (from the process that should have started your app):');
      lines.push('```');
      lines.push(compactText(result.smoke.health.startOutput, { maxChars: COMMAND_OUTPUT_BUDGET }));
      lines.push('```');
    }

    // Detect native binding errors and tell the agent to stop trying to fix them
    if (
      result.smoke.health.startOutput &&
      looksLikeNativeBindingError(result.smoke.health.startOutput)
    ) {
      lines.push(
        '**⚠ This looks like a native module infrastructure error (e.g. better-sqlite3 bindings).** ' +
          'Do NOT attempt to fix this yourself — do not run node-gyp, install headers, or modify .npmrc. ' +
          'Call `report_blocker` with the error output above. This is an environment issue, not a code issue.',
      );
    }

    lines.push('');
  }

  // Test failures
  if (result.test?.status === 'fail') {
    lines.push('### Test Failures');
    const testOutput = [result.test.stdout, result.test.stderr].filter(Boolean).join('\n').trim();
    if (testOutput) {
      lines.push('```');
      lines.push(compactText(testOutput, { maxChars: COMMAND_OUTPUT_BUDGET }));
      lines.push('```');
    }
    lines.push(
      'After fixing, re-run the test phase with `validate_locally({ "phases": ["tests"] })`.',
    );
    lines.push('');
  }

  // Lint failures
  if (result.lint?.status === 'fail') {
    lines.push('### Lint Failures');
    if (result.lint.output) {
      lines.push('```');
      lines.push(compactText(result.lint.output, { maxChars: COMMAND_OUTPUT_BUDGET }));
      lines.push('```');
    }
    lines.push(
      'After fixing, re-run the lint phase with `validate_locally({ "phases": ["lint"] })`.',
    );
    lines.push('');
  }

  // SAST failures
  if (result.sast?.status === 'fail') {
    lines.push('### Security Scan Failures');
    if (result.sast.output) {
      lines.push('```');
      lines.push(compactText(result.sast.output, { maxChars: COMMAND_OUTPUT_BUDGET }));
      lines.push('```');
    }
    lines.push('');
  }

  // Page-level failures
  const failedPages = result.smoke.pages.filter((p) => p.status === 'fail');
  if (failedPages.length > 0) {
    lines.push('### Page Failures');
    for (const page of failedPages) {
      lines.push(`**${page.path}**:`);
      if (page.consoleErrors.length > 0) {
        lines.push('Console errors:');
        for (const err of page.consoleErrors) {
          lines.push(`- ${compactText(err, { maxChars: 1_000 })}`);
        }
      }
      const failedAssertions = page.assertions.filter((a) => !a.passed);
      if (failedAssertions.length > 0) {
        lines.push('Failed assertions:');
        for (const a of failedAssertions) {
          lines.push(
            `- \`${a.selector}\` (${a.type}): expected \`${a.expected}\`, got \`${a.actual}\``,
          );
        }
      }
      lines.push('');
    }
  }

  // Required fact failures
  if (result.factValidation) {
    const unavailableFacts = result.factValidation.results.filter(isUnavailableRequiredFact);
    if (unavailableFacts.length > 0) {
      lines.push('### Required Fact Deviation Requests Needed');
      lines.push(
        'These required facts could not run in this validation environment. Do not report these as ordinary plan deviations. Call `report_task_summary` again with `factDeviations` for each fact below, using `action: "waive"` unless you added a replacement proof that can run here.',
      );
      lines.push('');
      for (const check of unavailableFacts) {
        lines.push(`**${check.factId}** (\`${check.artifactPath}\`):`);
        lines.push(`- ${compactText(check.reasoning, { maxChars: 1_000 })}`);
        lines.push('- Suggested `factDeviations` entry:');
        lines.push('```json');
        lines.push(
          JSON.stringify(
            {
              factId: check.factId,
              action: 'waive',
              reason: 'The required fact command cannot run in this validation environment.',
              whyImpossible: check.reasoning,
            },
            null,
            2,
          ),
        );
        lines.push('```');
      }
      lines.push('');
    }

    const failed = result.factValidation.results.filter(
      (r) => !r.passed && r.status !== 'pending_human',
    );
    if (failed.length > 0) {
      lines.push('### Required Fact Failures');
      for (const check of failed) {
        lines.push(`**${check.factId}** (\`${check.artifactPath}\`):`);
        lines.push(`- ${compactText(check.reasoning, { maxChars: 1_000 })}`);
        const commandOutput = formatFactCommandOutput(check.stdout, check.stderr, 5_000);
        if (commandOutput) {
          lines.push('```');
          lines.push(commandOutput);
          lines.push('```');
        }
      }
      lines.push('');
    }
  }

  // Unmet human-review requirements surfaced by the AI reviewer
  if (result.taskReview?.requirementsCheck) {
    const unmetRequirements = result.taskReview.requirementsCheck.filter((r) => !r.met);
    if (unmetRequirements.length > 0) {
      lines.push('### Unmet Human Review Requirements');
      lines.push('The following requirements were not met according to the code reviewer:');
      for (const item of unmetRequirements) {
        lines.push(`**${item.criterion}**:`);
        lines.push(
          `- ${compactText(item.note ?? 'Not implemented or evidence absent in the diff', {
            maxChars: 1_000,
          })}`,
        );
      }
      lines.push('');
    }
  }

  // Task review issues
  if (result.taskReview && result.taskReview.status !== 'pass') {
    lines.push('### Task Review Issues');
    lines.push(compactText(result.taskReview.reasoning, { maxChars: REVIEW_TEXT_BUDGET }));
    if (result.taskReview.issues.length > 0) {
      lines.push('');
      lines.push('Specific issues:');
      for (const issue of result.taskReview.issues.slice(0, 25)) {
        lines.push(`- ${compactText(issue, { maxChars: 1_000 })}`);
      }
      if (result.taskReview.issues.length > 25) {
        lines.push(`- ... ${result.taskReview.issues.length - 25} more issue(s) omitted`);
      }
    }
    lines.push('');
  }

  if (
    result.taskReview === null &&
    (result.reviewSkipKind === 'review-failed' || result.reviewSkipKind === 'review-timeout') &&
    result.reviewSkipReason
  ) {
    lines.push('### Review Execution Failure');
    lines.push(compactText(result.reviewSkipReason, { maxChars: REVIEW_TEXT_BUDGET }));
    lines.push('');
    lines.push(
      'This is a validation infrastructure failure, not an actionable code-review finding. Do not change unrelated code for this reviewer execution failure.',
    );
    lines.push('');
  }

  // When Facts + Review were gated out by tier-1 failures, tell the agent why
  // those sections are missing — otherwise it may assume those checks passed.
  if (
    result.reviewSkipKind === 'upstream-failed' &&
    result.taskReview === null &&
    result.factValidation?.status === 'skip'
  ) {
    lines.push(
      'Note: required facts and AI code review were skipped because earlier validation phases failed. They will run automatically once the issues above are fixed.',
    );
    lines.push('');
  }

  // Reminder of original task
  lines.push('### Original Task');
  lines.push(compactText(task, { maxChars: ORIGINAL_TASK_BUDGET }));

  return lines.join('\n');
}

function isUnavailableRequiredFact(
  check: NonNullable<ValidationResult['factValidation']>['results'][number],
): boolean {
  return check.status === 'pending_human' && check.exitCode === 127;
}

function formatFactCommandOutput(
  stdout: string | undefined,
  stderr: string | undefined,
  limit: number,
): string {
  const trimmedStdout = stdout?.trim();
  const trimmedStderr = stderr?.trim();

  if (trimmedStdout && trimmedStderr) {
    return compactText([`stderr:\n${trimmedStderr}`, `stdout:\n${trimmedStdout}`].join('\n\n'), {
      maxChars: limit,
    });
  }

  return compactText(trimmedStderr || trimmedStdout || '', { maxChars: limit });
}

function formatHumanRejection(input: RejectionFeedback): string {
  const { feedback, task, previousStatus, maxAttempts } = input;
  const lines: string[] = [];

  lines.push('## Changes Rejected by Reviewer');
  lines.push('');

  if (previousStatus === 'validated') {
    lines.push('Your changes passed validation but the reviewer wants changes.');
  } else {
    lines.push('The reviewer is giving you another chance after validation failure.');
  }

  lines.push('');
  lines.push('### Reviewer Feedback');
  lines.push(feedback);
  lines.push('');
  lines.push('### Original Task');
  lines.push(task);
  lines.push('');
  lines.push(`Attempt budget reset. You have ${maxAttempts} validation attempts.`);

  return lines.join('\n');
}

const NATIVE_ERROR_PATTERNS = [
  'MODULE_NOT_FOUND',
  'was compiled against a different Node.js version',
  'NODE_MODULE_VERSION',
  'node-gyp',
  'better-sqlite3',
  'better_sqlite3.node',
  'binding.node',
  'prebuild-install',
  'node-pre-gyp',
];

function looksLikeNativeBindingError(output: string): boolean {
  return NATIVE_ERROR_PATTERNS.some((p) => output.includes(p));
}

function formatEscalationResponse(input: EscalationFeedback): string {
  const { question, response } = input;
  const lines: string[] = [];

  lines.push('## Response to Your Question');
  lines.push('');
  lines.push(`**Your question**: ${question}`);
  lines.push('');
  lines.push(
    `**Response** (from ${response.respondedBy}${response.model ? `, ${response.model}` : ''}):`,
  );
  lines.push(response.response);

  return lines.join('\n');
}
