import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Vitest positional filters are substring matches. Prove the exact inventory ran,
// with assertions in every file and no skipped/todo tests, rather than trusting exit 0.
export function checkPrTestReport(report, expected) {
  assert.ok(expected.length > 0, 'PR smoke inventory must not be empty');
  assert.equal(new Set(expected).size, expected.length, 'Duplicate PR smoke files');
  assert.equal(report.success, true, 'PR smoke report did not succeed');
  assert.equal(report.testResults.length, expected.length, 'Unexpected PR smoke file count');
  for (const file of expected) {
    const suites = report.testResults.filter((suite) =>
      suite.name.replaceAll('\\', '/').endsWith(`/${file}`),
    );
    assert.equal(suites.length, 1, `PR smoke requires exactly one result for ${file}`);
    const [suite] = suites;
    assert.equal(suite.status, 'passed', `PR smoke file did not pass: ${file}`);
    assert.ok(suite.assertionResults.length > 0, `PR smoke file has no tests: ${file}`);
    assert.ok(
      suite.assertionResults.every((test) => test.status === 'passed'),
      `PR smoke requires executed passing tests (no skips/todos) in ${file}`,
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [path, ...expected] = process.argv.slice(2);
  checkPrTestReport(JSON.parse(readFileSync(path, 'utf8')), expected);
}
