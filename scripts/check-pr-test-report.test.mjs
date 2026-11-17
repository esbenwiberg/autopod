import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { checkPrTestReport } from './check-pr-test-report.mjs';

const expected = ['src/pods/state-machine.test.ts', 'src/db/migrate.test.ts'];
const passing = () => ({
  success: true,
  testResults: expected.map((file) => ({
    name: `/checkout/packages/daemon/${file}`,
    status: 'passed',
    assertionResults: [{ status: 'passed' }],
  })),
});

test('PR smoke accepts the exact executed inventory', () => {
  checkPrTestReport(passing(), expected);
});

test('PR smoke rejects missing, extra, duplicated and empty files', () => {
  for (const change of [
    (report) => report.testResults.pop(),
    (report) => report.testResults.push({ ...report.testResults[0], name: '/extra.test.ts' }),
    (report) => {
      report.testResults[1] = report.testResults[0];
    },
    (report) => {
      report.testResults[0].assertionResults = [];
    },
  ]) {
    const report = passing();
    change(report);
    assert.throws(() => checkPrTestReport(report, expected));
  }
  assert.throws(() => checkPrTestReport(passing(), []));
  assert.throws(() => checkPrTestReport(passing(), [expected[0], expected[0]]));
});

test('PR smoke rejects failed reports/files and skipped, pending, todo or failed assertions', () => {
  const failed = passing();
  failed.success = false;
  assert.throws(() => checkPrTestReport(failed, expected));
  for (const status of ['failed', 'skipped', 'pending', 'todo']) {
    const report = passing();
    report.testResults[0].assertionResults[0].status = status;
    assert.throws(() => checkPrTestReport(report, expected));
    const fileReport = passing();
    fileReport.testResults[0].status = status;
    assert.throws(() => checkPrTestReport(fileReport, expected));
  }
});

test('PR smoke inventory exists and retains the lifecycle, DB and auth boundaries', () => {
  const script = readFileSync(new URL('./test-pr.sh', import.meta.url), 'utf8');
  const files = [...script.matchAll(/^ {2}(src\/.*\.test\.ts)$/gm)].map((match) => match[1]);
  assert.equal(files.length, 10);
  assert.equal(new Set(files).size, files.length);
  for (const file of files) {
    assert.ok(readFileSync(new URL(`../packages/daemon/${file}`, import.meta.url)).length > 0);
  }
  for (const file of [
    'src/pods/pod-lifecycle.e2e.test.ts',
    'src/pods/state-machine.test.ts',
    'src/db/migrate.test.ts',
    'src/api/plugins/auth.test.ts',
  ])
    assert.ok(files.includes(file));
  assert.match(script, /SKIP_DB_TESTS=0/);
  assert.match(script, /--maxWorkers=1 --passWithNoTests=false/);
  assert.match(script, /node scripts\/check-pr-test-report\.mjs/);
  assert.match(
    script,
    /node --test scripts\/\*\.test\.mjs packages\/desktop\/Tests\/VillageHost\/\*\.test\.mjs/,
  );
});
