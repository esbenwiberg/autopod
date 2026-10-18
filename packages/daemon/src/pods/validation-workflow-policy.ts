import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Pod, PodOptions, ValidationPhase, ValidationResult } from '@autopod/shared';
import { AutopodError, mergeValidationPhaseSkips } from '@autopod/shared';
import type { Logger } from 'pino';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';

/** Single-line per-phase summary used in activity log lines. Covers all active
 * phases the validation engine produces — partial summaries can otherwise
 * contradict an `overall: fail` (e.g. tests/pages failed but only build/health
 * shown). Order matches pipeline order so the first `fail` is the failing gate. */
export function summarizeValidationPhases(result: ValidationResult): string {
  const setupStatus = result.setup?.status ?? 'skip';
  const lintStatus = result.lint?.status ?? 'skip';
  const sastStatus = result.sast?.status ?? 'skip';
  const buildStatus = setupStatus === 'fail' ? 'skip' : result.smoke.build.status;
  const infrastructurePhase = result.infrastructureFailure?.phase;
  const setupDisplay = infrastructurePhase === 'setup' ? 'infrastructure_error' : setupStatus;
  const lintDisplay = infrastructurePhase === 'lint' ? 'infrastructure_error' : lintStatus;
  const sastDisplay = infrastructurePhase === 'sast' ? 'infrastructure_error' : sastStatus;
  const buildDisplay = infrastructurePhase === 'build' ? 'infrastructure_error' : buildStatus;
  const testStatus =
    infrastructurePhase === 'test' ? 'infrastructure_error' : (result.test?.status ?? 'skip');
  const healthStatus =
    infrastructurePhase === 'health' ? 'infrastructure_error' : result.smoke.health.status;
  const pagesStatus =
    result.smoke.pages.length === 0
      ? 'skip'
      : result.smoke.pages.every((p) => p.status === 'pass')
        ? 'pass'
        : 'fail';
  const factsStatus =
    infrastructurePhase === 'facts'
      ? 'infrastructure_error'
      : (result.factValidation?.status ?? 'skip');
  const reviewStatus = result.taskReview?.status ?? 'skip';
  return (
    `setup: ${setupDisplay}, lint: ${lintDisplay}, sast: ${sastDisplay}, build: ${buildDisplay}, ` +
    `tests: ${testStatus}, health: ${healthStatus}, pages: ${pagesStatus}, ` +
    `facts: ${factsStatus}, review: ${reviewStatus}`
  );
}

export function failedValidationPhases(result: ValidationResult | null): string[] {
  if (!result) return [];
  const failed: string[] = [];
  if (result.setup?.status === 'fail') failed.push('setup');
  if (result.lint?.status === 'fail') failed.push('lint');
  if (result.sast?.status === 'fail') failed.push('sast');
  if (result.smoke.build.status === 'fail') failed.push('build');
  if (result.test?.status === 'fail') failed.push('tests');
  if (result.smoke.health.status === 'fail') failed.push('health');
  if (result.smoke.pages.some((p) => p.status === 'fail')) failed.push('pages');
  if (result.factValidation?.status === 'fail') failed.push('facts');
  if (result.taskReview && result.taskReview.status !== 'pass') failed.push('review');
  return failed;
}

export function failedFactIds(result: ValidationResult | null): string[] {
  return (
    result?.factValidation?.results
      .filter((fact) => fact.status === 'fail' || fact.passed === false)
      .map((fact) => fact.factId) ?? []
  );
}

export function hasPendingFactDecision(result: ValidationResult | null): boolean {
  return (
    result?.factValidation?.results.some(
      // Exit 127 means the validator discovered a missing command/toolchain.
      // Let the agent see that feedback so it can file the factDeviation request.
      (fact) => fact.status === 'pending_human' && fact.exitCode !== 127,
    ) === true
  );
}

/** Load a repo-specific code-review skill from standard locations in the worktree. */
export async function loadCodeReviewSkill(
  worktreePath: string,
  log?: Logger,
): Promise<string | undefined> {
  const candidates = ['skills/code-review.md', '.claude/skills/code-review.md'];
  for (const relative of candidates) {
    const fullPath = path.join(worktreePath, relative);
    try {
      const content = await readFile(fullPath, 'utf-8');
      log?.info({ path: fullPath }, 'loaded repo-specific code-review skill');
      return content;
    } catch {
      // not found — try next
    }
  }
  return undefined;
}

export function getPodValidationSuite(pod: Pod): NonNullable<PodOptions['validationSuite']> {
  return pod.options.validationSuite ?? (pod.options.validate === false ? 'off' : 'full');
}

export function isPodValidationDisabled(pod: Pod): boolean {
  return (
    pod.skipValidation || pod.options.validate === false || getPodValidationSuite(pod) === 'off'
  );
}

export function getPodValidationSkipPhases(
  profile: PodExecutionSettings,
  pod: Pod,
): ValidationPhase[] {
  return mergeValidationPhaseSkips(getPodValidationSuite(pod), profile.skipValidationPhases);
}

export function protectedOperationalPathReason(pathname: string): string | null {
  if (
    pathname === '.mcp.json' ||
    pathname.startsWith('.husky/') ||
    pathname.startsWith('.githooks/') ||
    pathname.startsWith('.git/hooks/') ||
    pathname.startsWith('.claude/') ||
    pathname.startsWith('.codex/')
  ) {
    return 'agent/runtime operational path';
  }
  return null;
}

export function podExplicitlyScopesOperationalPaths(pod: Pod): boolean {
  const haystack = [
    pod.task,
    pod.taskSummary?.actualSummary,
    pod.taskSummary?.how,
    ...(pod.touches ?? []),
  ]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
  return [
    '.husky',
    '.githooks',
    '.git/hooks',
    '.claude',
    '.codex',
    '.mcp.json',
    'pre-commit',
    'commit-msg',
    'git hook',
    'agent config',
    'agent tooling',
    'mcp',
  ].some((needle) => haystack.includes(needle));
}

export function assertProtectedOperationalPathsInScope(pod: Pod, changedPaths: string[]): void {
  const changed = changedPaths.filter((p) => protectedOperationalPathReason(p));
  if (changed.length === 0 || podExplicitlyScopesOperationalPaths(pod)) return;
  throw new AutopodError(
    `Protected operational files changed without explicit task scope: ${changed.join(', ')}. Revert these hook/agent-config changes or disclose explicit scope for them before validation.`,
    'PROTECTED_OPERATIONAL_PATHS_CHANGED',
    422,
  );
}

export function makeUnexpectedValidationFailureResult(
  podId: string,
  attempt: number,
  validateErr: unknown,
): ValidationResult {
  const isContainerStopped =
    validateErr instanceof Error &&
    (validateErr.message.includes('container stopped/paused') ||
      (validateErr as NodeJS.ErrnoException & { statusCode?: number }).statusCode === 409);
  const buildOutput = isContainerStopped
    ? 'Container exited before validation could run — check agent logs for errors'
    : String(validateErr);

  return {
    podId,
    attempt,
    timestamp: new Date().toISOString(),
    overall: 'fail',
    smoke: {
      status: 'fail',
      build: { status: 'fail', output: buildOutput, duration: 0 },
      health: { status: 'fail', url: '', responseCode: null, duration: 0 },
      pages: [],
    },
    taskReview: null,
    duration: 0,
  };
}
