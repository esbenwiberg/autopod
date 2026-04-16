import type { EscalationResponse, ValidationResult } from '@autopod/shared';

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
  previousStatus: 'validated' | 'failed';
}

export interface EscalationFeedback {
  type: 'escalation_response';
  question: string;
  response: EscalationResponse;
}

export type FeedbackInput = ValidationFeedback | RejectionFeedback | EscalationFeedback;

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

  // Build errors
  if (result.smoke.build.status === 'fail') {
    lines.push('### Build Errors');
    lines.push('```');
    lines.push(result.smoke.build.output);
    lines.push('```');
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
      lines.push(result.smoke.health.startOutput);
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
      lines.push(testOutput.slice(0, 10_000));
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
          lines.push(`- ${err}`);
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

  // AC validation failures
  if (result.acValidation && result.acValidation.status === 'fail') {
    const failed = result.acValidation.results.filter((r) => !r.passed);
    if (failed.length > 0) {
      lines.push('### Acceptance Criteria Failures');
      for (const check of failed) {
        lines.push(`**${check.criterion}**:`);
        lines.push(`- ${check.reasoning}`);
      }
      lines.push('');
    }
  }

  // Unmet "none" ACs surfaced by the AI reviewer
  if (result.taskReview?.requirementsCheck) {
    const unmetNoneAcs = result.taskReview.requirementsCheck.filter((r) => !r.met);
    if (unmetNoneAcs.length > 0) {
      lines.push('### Unmet Acceptance Criteria (code review)');
      lines.push('The following criteria were not met according to the code reviewer:');
      for (const item of unmetNoneAcs) {
        lines.push(`**${item.criterion}**:`);
        lines.push(`- ${item.note ?? 'Not implemented or evidence absent in the diff'}`);
      }
      lines.push('');
    }
  }

  // Task review issues
  if (result.taskReview && result.taskReview.status !== 'pass') {
    lines.push('### Task Review Issues');
    lines.push(result.taskReview.reasoning);
    if (result.taskReview.issues.length > 0) {
      lines.push('');
      lines.push('Specific issues:');
      for (const issue of result.taskReview.issues) {
        lines.push(`- ${issue}`);
      }
    }
    lines.push('');
  }

  // Reminder of original task
  lines.push('### Original Task');
  lines.push(task);

  return lines.join('\n');
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
