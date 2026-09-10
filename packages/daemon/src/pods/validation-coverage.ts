/** Parse historical evidence defensively without turning absent or skipped checks into passes. */
export type ExecutedStage =
  | 'build'
  | 'health'
  | 'smoke'
  | 'test'
  | 'lint'
  | 'sast'
  | 'facts'
  | 'taskReview';
export type StageEvidence = { stage: ExecutedStage; executed: boolean; failed: boolean };

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function validationCoverage(value: unknown): StageEvidence[] {
  const result = record(value);
  const smoke = record(result.smoke);
  const pages = Array.isArray(smoke.pages) ? smoke.pages : [];
  const entries: Array<[ExecutedStage, unknown[]]> = [
    ['build', [smoke.build]],
    ['health', [smoke.health]],
    ['smoke', pages],
    ['test', [result.test]],
    ['lint', [result.lint]],
    ['sast', [result.sast]],
    ['facts', [result.factValidation]],
    ['taskReview', [result.taskReview]],
  ];
  return entries.map(([stage, values]) => {
    const statuses = values.map((v) => record(v).status);
    const currentExecutions = values
      .filter((v) => !record(v).reusedEvidence)
      .map((v) => record(v).status);
    return {
      stage,
      executed: currentExecutions.some((s) => s === 'pass' || s === 'fail'),
      failed: statuses.includes('fail'),
    };
  });
}

export function isExecutedFirstPass(raw: string | null): boolean {
  if (!raw) return false;
  try {
    const value: unknown = JSON.parse(raw);
    const coverage = validationCoverage(value);
    return (
      record(value).overall === 'pass' &&
      coverage.some((s) => s.executed) &&
      !coverage.some((s) => s.failed)
    );
  } catch {
    return false;
  }
}
