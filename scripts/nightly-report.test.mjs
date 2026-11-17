import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const { parse } = createRequire(new URL('../packages/shared/package.json', import.meta.url))(
  'yaml',
);
const workflow = parse(
  readFileSync(new URL('../.github/workflows/full.yml', import.meta.url), 'utf8'),
);
const script = workflow.jobs['nightly-report'].steps[0].with.script;
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

async function report(linux, desktop, issues = []) {
  const calls = [];
  const record = (name) => async (args) => {
    calls.push({ name, args });
  };
  const github = {
    paginate: async () => issues,
    rest: {
      issues: {
        listForRepo() {},
        create: record('create'),
        createComment: record('comment'),
        update: record('update'),
      },
    },
  };
  await new AsyncFunction('github', 'context', 'process', script)(
    github,
    {
      repo: { owner: 'esbenwiberg', repo: 'autopod' },
      serverUrl: 'https://github.com',
      runId: 123,
      sha: 'abc123',
    },
    { env: { LINUX_RESULT: linux, DESKTOP_RESULT: desktop } },
  );
  return calls;
}

test('nightly failures notify one owner issue, including both job outcomes and evidence', async () => {
  for (const results of [
    ['failure', 'success'],
    ['success', 'failure'],
    ['success', 'cancelled'],
  ]) {
    const calls = await report(...results);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'create');
    assert.deepEqual(calls[0].args.assignees, ['esbenwiberg']);
    assert.match(calls[0].args.body, /abc123/);
    assert.match(calls[0].args.body, /actions\/runs\/123/);
    assert.ok(calls[0].args.body.includes(`Linux: ${results[0]}; Desktop: ${results[1]}`));
  }
  const issue = { number: 42, title: '[CI] Nightly full validation failed' };
  const calls = await report('failure', 'success', [issue]);
  assert.deepEqual(
    calls.map((call) => call.name),
    ['comment'],
  );
  assert.equal(calls[0].args.issue_number, 42);
});

test('a recovered nightly closes the existing issue and a healthy nightly stays quiet', async () => {
  assert.deepEqual(await report('success', 'success'), []);
  const calls = await report('success', 'success', [
    { number: 42, title: '[CI] Nightly full validation failed' },
  ]);
  assert.deepEqual(
    calls.map((call) => call.name),
    ['comment', 'update'],
  );
  assert.equal(calls[1].args.state, 'closed');
  assert.equal(calls[1].args.issue_number, 42);
});
