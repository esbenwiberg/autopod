import { expect, it } from 'vitest';
import { workerRetryDeadline } from './worker-retry-deadline.js';
const observed = Date.parse('2026-09-08T10:00:00.000Z');
it('anchors relative hints to error observation and preserves valid absolute deadlines', () => {
  expect(workerRetryDeadline('3600', observed)).toBe('2026-09-08T11:00:00.000Z');
  expect(workerRetryDeadline('2026-09-08T12:30Z', observed)).toBe('2026-09-08T12:30:00.000Z');
  expect(workerRetryDeadline('0', observed)).toBe('2026-09-08T10:00:00.000Z');
  expect(workerRetryDeadline('2026-09-07T12:30:00Z', observed)).toBe('2026-09-07T12:30:00.000Z');
});
it.each([
  null,
  {},
  'tomorrow',
  '-1',
  '1.5',
  '999999999',
  '2026-02-30T12:00:00Z',
  '2026-09-08T24:00:00Z',
  'x'.repeat(101),
])('does not invent a deadline from invalid hint %j', (hint) => {
  expect(workerRetryDeadline(hint, observed)).toBeNull();
});
