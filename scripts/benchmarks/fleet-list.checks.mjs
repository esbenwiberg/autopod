import assert from 'node:assert/strict';
import { it } from 'vitest';
import { assertPageBudget, assertTraversal, summarize } from './fleet-list-protocol.mjs';

it('keeps nearest-rank p95, median and input samples honest', () => {
  const values = [9, 0, 2, 5, 100, 3, 4];
  assert.deepEqual(summarize(values), { count: 7, min: 0, median: 4, p95: 100, max: 100 });
  assert.deepEqual(values, [9, 0, 2, 5, 100, 3, 4]);
  assert.equal(summarize([10, 2]).median, 6);
  assert.throws(() => summarize([]));
  assert.throws(() => summarize([Number.NaN]));
});

it('rejects faulty pagination without relying on the benchmark timeout', () => {
  const expected = Array.from({ length: 1_001 }, (_, i) => ({
    id: `pod-${String(1_001 - i).padStart(6, '0')}`,
    createdAt: '2026-10-15T00:00:00.000Z',
    status: 'running',
    taskExcerpt: 'task',
    title: 'task',
    question: null,
    finalization: null,
  }));
  const pages = [0, 500, 1_000].map((start, index) => ({
    statusCode: 200,
    rawBody: '',
    body: {
      pods: expected.slice(start, start + 500).map((row) => ({
        ...row,
        pendingEscalationSummary: row.question,
        recordDiagnostics: [],
      })),
      nextCursor: index === 2 ? null : `cursor-${index}`,
    },
  }));
  assertTraversal(pages, expected);
  const reject = (mutate) => {
    const broken = structuredClone(pages);
    mutate(broken);
    assert.throws(() => assertTraversal(broken, expected));
  };
  reject((p) => {
    p[1] = p[0];
  });
  reject((p) => {
    p[0].body.pods.pop();
  });
  reject((p) => {
    p[0].body.pods[1] = p[0].body.pods[0];
  });
  reject((p) => {
    p[0].body.pods.reverse();
  });
  reject((p) => {
    p[1].body.nextCursor = p[0].body.nextCursor;
  });
  reject((p) => {
    p[0].statusCode = 500;
  });
  reject((p) => {
    p[0].rawBody = 'UNRELATED_VALIDATION_EVIDENCE';
  });
  assertPageBudget(1, 'continue', 1_000);
  assertPageBudget(2, null, 1_000);
  assert.throws(() => assertPageBudget(2, 'repeat', 1_000));
  assert.throws(() => assertPageBudget(3, null, 1_000));
});
