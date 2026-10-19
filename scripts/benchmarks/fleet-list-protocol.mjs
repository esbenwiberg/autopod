import assert from 'node:assert/strict';

export const PAGE_SIZE = 500;
export const SIZES = [100, 1_000, 10_000];
export const ROUNDS = 7;
export const TIE_SIZE = 37;
export const UNRELATED_MARKER = 'UNRELATED_VALIDATION_EVIDENCE';

export function summarize(values) {
  assert.ok(values.length > 0, 'Cannot summarize empty measurements');
  assert.ok(values.every((value) => Number.isFinite(value) && value >= 0));
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    count: sorted.length,
    min: sorted[0],
    median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    max: sorted.at(-1),
  };
}

export function assertPageBudget(pageCount, cursor, rowCount) {
  assert.ok(pageCount <= Math.ceil(rowCount / PAGE_SIZE), 'Page budget exceeded');
  if (pageCount === Math.ceil(rowCount / PAGE_SIZE)) {
    assert.equal(cursor, null, 'Non-null cursor would exceed the fixed page budget');
  }
}

// Runs after timing. Expected rows come from independently generated fixture IDs,
// timestamps and values, never from the route being qualified.
export function assertTraversal(pages, expected) {
  assert.equal(pages.length, Math.ceil(expected.length / PAGE_SIZE));
  const ids = [];
  const cursors = new Set();
  let offset = 0;
  for (const [pageIndex, page] of pages.entries()) {
    assert.equal(page.statusCode, 200);
    assert.ok(Array.isArray(page.body.pods));
    assert.ok(page.body.pods.length > 0 && page.body.pods.length <= PAGE_SIZE);
    const cursor = page.body.nextCursor;
    if (pageIndex === pages.length - 1) assert.equal(cursor, null);
    else {
      assert.equal(typeof cursor, 'string');
      assert.ok(cursor.length > 0);
      assert.ok(!cursors.has(cursor), 'Repeated cursor');
      cursors.add(cursor);
    }
    assert.ok(
      !page.rawBody.includes(UNRELATED_MARKER),
      'Unrelated evidence leaked into compact response',
    );
    for (const pod of page.body.pods) {
      const row = expected[offset++];
      assert.ok(row, 'Unexpected extra row');
      ids.push(pod.id);
      assert.equal(pod.id, row.id, 'Missing, repeated or reordered pod');
      assert.equal(pod.createdAt, row.createdAt);
      assert.equal(pod.status, row.status);
      assert.equal(pod.taskExcerpt, row.taskExcerpt);
      assert.equal(pod.title, row.title);
      assert.equal(pod.pendingEscalationSummary, row.question);
      assert.deepEqual(pod.finalization, row.finalization);
      assert.deepEqual(pod.recordDiagnostics, []);
      for (const forbidden of ['task', 'lastValidationResult', 'contract', 'specFiles']) {
        assert.ok(!Object.hasOwn(pod, forbidden), `Unexpected compact field ${forbidden}`);
      }
    }
  }
  assert.equal(offset, expected.length);
  assert.equal(new Set(ids).size, expected.length);
  // Explicit first/last tied groups, in addition to exact entire-order comparison.
  const firstGroup = expected.filter((row) => row.createdAt === expected[0].createdAt);
  const lastGroup = expected.filter((row) => row.createdAt === expected.at(-1).createdAt);
  assert.deepEqual(
    ids.slice(0, firstGroup.length),
    firstGroup.map((row) => row.id),
  );
  assert.deepEqual(
    ids.slice(-lastGroup.length),
    lastGroup.map((row) => row.id),
  );
}
