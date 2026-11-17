import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

// yaml is an existing direct dependency of shared; the frozen workspace install
// provides it without introducing a separate workflow-test dependency.
const { parse } = createRequire(new URL('../packages/shared/package.json', import.meta.url))(
  'yaml',
);
const workflow = (name) =>
  parse(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));
const commands = (job) =>
  job.steps
    .filter((step) => step.run)
    .map((step) => step.run)
    .join('\n');

test('routine CI preserves check identity and static gates, but runs only the PR test lane', () => {
  const ci = workflow('ci');
  assert.equal(ci.name, 'CI');
  assert.deepEqual(Object.keys(ci.on).sort(), ['pull_request', 'push']);
  assert.deepEqual(ci.on.pull_request.branches, ['main', 'codex/reliability']);
  assert.equal(ci.on.pull_request.paths, undefined, 'required CI must not be path-skipped');
  assert.equal(ci.concurrency['cancel-in-progress'], true);
  const job = ci.jobs['build-and-test'];
  assert.equal(job['timeout-minutes'], 5);
  const runs = commands(job).split('\n');
  for (const command of [
    'pnpm install --frozen-lockfile',
    'pnpm lint',
    'pnpm build',
    'pnpm typecheck',
    'pnpm test:pr',
  ])
    assert.ok(runs.includes(command), command);
  assert.ok(!runs.includes('pnpm test'));
  assert.ok(!runs.some((run) => run.includes('pnpm audit')));
  assert.ok(ci.jobs['secret-scan'].steps.some((step) => step.uses?.startsWith('gitleaks/')));
});

test('full Linux and native coverage run nightly and manually, not on routine PRs', () => {
  const full = workflow('full');
  assert.deepEqual(Object.keys(full.on).sort(), ['schedule', 'workflow_dispatch']);
  assert.equal(full.on.schedule.length, 1);
  assert.equal(full.on.schedule[0].cron, '17 3 * * *');
  assert.equal(full.concurrency['cancel-in-progress'], false);
  assert.equal(full.jobs.linux.env.SKIP_DB_TESTS, '0');
  assert.ok(full.jobs.linux.steps.some((step) => step.uses?.startsWith('gitleaks/')));
  const runs = commands(full.jobs.linux);
  for (const command of [
    'pnpm lint',
    'pnpm build',
    'pnpm typecheck',
    'TURBO_FORCE=true pnpm test',
    'pnpm audit',
  ]) {
    assert.ok(runs.includes(command), command);
  }
  assert.ok(!runs.includes('pnpm test:pr'));
  const tests = full.jobs.linux.steps.find((step) => step.id === 'full-tests');
  assert.ok(tests.run.includes('TURBO_FORCE=true pnpm test'));
  const summary = full.jobs.linux.steps.find((step) => step.name === 'Validation summary');
  assert.equal(summary.if, 'always()');
  assert.match(summary.env.TEST_OUTCOME, /^\$\{\{ steps\.full-tests\.outcome \}\}$/);
  assert.match(summary.run, /skipped test step is not a pass/);
  assert.equal(full.jobs.desktop.uses, './.github/workflows/desktop.yml');
  const audit = full.jobs.linux.steps.find((step) => step.name === 'Dependency audit');
  assert.equal(audit['continue-on-error'], true);
  const artifact = full.jobs.linux.steps.find((step) =>
    step.uses?.startsWith('actions/upload-artifact@'),
  );
  assert.equal(artifact.if, 'always()');
  assert.equal(artifact.with.path, '.ci-results/');
  assert.match(full.jobs['nightly-report'].if, /github.event_name == 'schedule'/);
  assert.deepEqual(full.jobs['nightly-report'].needs, ['linux', 'desktop']);
  assert.equal(full.jobs['nightly-report'].permissions.issues, 'write');
  assert.equal(full.permissions.issues, undefined);
});

test('native workflow remains manually callable and retains Swift and Xcode proof', () => {
  const desktop = workflow('desktop');
  assert.deepEqual(Object.keys(desktop.on).sort(), ['workflow_call', 'workflow_dispatch']);
  const job = desktop.jobs['test-and-build'];
  assert.equal(job['runs-on'], 'macos-15');
  assert.equal(job.defaults.run.shell, 'bash', 'tee pipelines must retain bash pipefail');
  const runs = commands(job);
  assert.match(runs, /\.\/scripts\/test-desktop\.sh/);
  assert.match(runs, /xcodebuild/);
  assert.match(runs, /CODE_SIGNING_ALLOWED=NO/);
  assert.match(runs, /village:check/);
  assert.ok(
    job.steps.some(
      (step) => step.uses?.startsWith('actions/upload-artifact@') && step.if === 'always()',
    ),
  );
});

test('the default local test command remains full and serialized', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts['test:pr'], 'bash scripts/test-pr.sh');
  assert.equal(
    pkg.scripts.test,
    'turbo run test --concurrency=1 && node --test scripts/*.test.mjs && bash scripts/deploy-hosted-daemon.test.sh && bash scripts/cleanup-hosted-daemon.test.sh',
  );
});
