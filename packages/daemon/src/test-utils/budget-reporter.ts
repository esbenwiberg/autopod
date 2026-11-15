import { appendFileSync } from 'node:fs';
import { relative } from 'node:path';
import type { Reporter, TestCase } from 'vitest/node';
import { experimental_getRunnerTask } from 'vitest/node';

/** A finished test with the deadline it actually ran under. */
export interface BudgetRecord {
  name: string;
  state: 'passed' | 'failed' | 'skipped' | 'pending';
  startTime: number;
  duration: number;
  timeout: number;
  error?: string;
}

/** Tests that used at least this share of their own deadline are listed after every run. */
export const BUDGET_PRESSURE = 0.5;
const PREFIX = '[test-budget]';

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/**
 * Stable, greppable end-of-run lines: totals, every failed test with its first error line, and
 * the tests closest to their deadline. Validation output keeps its head and tail, so these
 * lines remain visible even when the default reporter's middle section is truncated.
 */
export function formatBudgetSummary(records: readonly BudgetRecord[], limit = 25): string[] {
  const count = (state: BudgetRecord['state']) => records.filter((r) => r.state === state).length;
  const lines = [
    `${PREFIX} tests: ${count('passed')} passed, ${count('failed')} failed, ${count('skipped')} skipped`,
  ];
  for (const r of records.filter((record) => record.state === 'failed'))
    lines.push(
      `${PREFIX} FAILED ${r.name} (${seconds(r.duration)} of ${seconds(r.timeout)})${r.error ? `: ${r.error}` : ''}`,
    );
  const pressured = records
    .filter(
      (r) => r.state !== 'skipped' && r.timeout > 0 && r.duration >= r.timeout * BUDGET_PRESSURE,
    )
    .sort((a, b) => b.duration / b.timeout - a.duration / a.timeout);
  if (pressured.length) {
    lines.push(
      `${PREFIX} ${pressured.length} test(s) used >= ${BUDGET_PRESSURE * 100}% of their timeout:`,
    );
    for (const r of pressured.slice(0, limit))
      lines.push(
        `${PREFIX}   ${Math.round((r.duration / r.timeout) * 100)}% ${seconds(r.duration)}/${seconds(r.timeout)} ${r.name}`,
      );
    if (pressured.length > limit) lines.push(`${PREFIX}   ... ${pressured.length - limit} more`);
  }
  return lines;
}

/**
 * Prints `formatBudgetSummary` after the default reporter. With VITEST_BUDGET_LOG set it also
 * appends one JSON line per finished test (start, duration, deadline) for offline analysis.
 */
export default class BudgetReporter implements Reporter {
  private readonly records: BudgetRecord[] = [];

  onTestCaseResult(testCase: TestCase): void {
    const result = testCase.result();
    const diagnostic = testCase.diagnostic();
    // The resolved per-test deadline (explicit argument, suite option or config default).
    const timeout = experimental_getRunnerTask(testCase).timeout;
    const file = relative(testCase.project.config.root, testCase.module.moduleId);
    const record: BudgetRecord = {
      name: `${file} > ${testCase.fullName}`,
      state: result.state,
      startTime: diagnostic?.startTime ?? 0,
      duration: diagnostic?.duration ?? 0,
      timeout: typeof timeout === 'number' ? timeout : testCase.project.config.testTimeout,
      error: result.errors?.[0]?.message?.split('\n')[0]?.slice(0, 200),
    };
    this.records.push(record);
    const log = process.env.VITEST_BUDGET_LOG;
    if (log) appendFileSync(log, `${JSON.stringify(record)}\n`);
  }

  onTestRunEnd(): void {
    if (!this.records.length) return;
    process.stdout.write(`\n${formatBudgetSummary(this.records).join('\n')}\n`);
  }
}
