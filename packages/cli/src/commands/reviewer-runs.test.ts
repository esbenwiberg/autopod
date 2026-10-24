import { Command } from 'commander';
import { afterEach, expect, it, vi } from 'vitest';
import type { AutopodClient, ReviewerRun } from '../api/client.js';
import { registerReviewerRunsCommand } from './reviewer-runs.js';

afterEach(() => vi.restoreAllMocks());

const run = {
  id: 'review-1',
  state: 'uncertain',
  cleanup: 'clean',
  runtime: 'codex',
  model: 'gpt-5',
  inputTokens: null,
  outputTokens: null,
  usageBasis: null,
  failureKind: 'timeout',
  reconciledAt: null,
  createdAt: 'now',
  requiresReconciliation: true,
} as ReviewerRun;

function setup() {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const client = {
    listReviewerRuns: vi.fn(async () => [run]),
    reconcileReviewerRun: vi.fn(async () => ({ ...run, requiresReconciliation: false })),
  };
  const program = new Command().exitOverride();
  registerReviewerRunsCommand(program, () => client as unknown as AutopodClient);
  const parse = (...args: string[]) =>
    program.parseAsync(['reviewer-runs', '12345678', ...args], { from: 'user' });
  return { client, log, parse };
}

it('lists runs and prints the reconcile command for a blocking run', async () => {
  const { client, log, parse } = setup();
  await parse();
  expect(client.listReviewerRuns).toHaveBeenCalledExactlyOnceWith('12345678');
  expect(log.mock.calls.flat().join('\n')).toContain(
    'ap reviewer-runs 12345678 --reconcile review-1',
  );
});

it('accepts unknown usage by default and passes reported usage only as a pair', async () => {
  const { client, parse } = setup();
  await parse('--reconcile', 'review-1', '--note', ' provider timed out ');
  await parse(
    '--reconcile',
    'review-1',
    '--note',
    'n',
    '--input-tokens',
    '5',
    '--output-tokens',
    '0',
  );
  expect(client.reconcileReviewerRun.mock.calls).toEqual([
    ['12345678', 'review-1', { note: 'provider timed out' }],
    ['12345678', 'review-1', { note: 'n', inputTokens: 5, outputTokens: 0 }],
  ]);
});

it.each([
  [['--reconcile', 'review-1'], '--note is required'],
  [['--reconcile', 'review-1', '--note', 'n', '--input-tokens', '5'], 'supplied together'],
  [
    ['--reconcile', 'review-1', '--note', 'n', '--input-tokens', '-1', '--output-tokens', '0'],
    'non-negative',
  ],
  [['--note', 'n'], 'require --reconcile'],
])('rejects malformed reconcile input %j', async (args, message) => {
  const { client, parse } = setup();
  await expect(parse(...args)).rejects.toThrow(message);
  expect(client.reconcileReviewerRun).not.toHaveBeenCalled();
});
