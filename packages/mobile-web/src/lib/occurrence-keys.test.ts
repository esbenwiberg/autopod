import { describe, expect, it } from 'vitest';
import { withOccurrenceKeys } from './occurrence-keys.js';

describe('content occurrence keys', () => {
  it('retains every duplicate with unique deterministic keys', () => {
    const items = ['same', 'same', 'other', 'same'];
    const keyed = withOccurrenceKeys(items, (item) => item);
    expect(keyed.map(({ item }) => item)).toEqual(items);
    expect(new Set(keyed.map(({ key }) => key)).size).toBe(items.length);
    expect(withOccurrenceKeys(items, (item) => item)).toEqual(keyed);
  });

  it('does not change an item key when unrelated entries are inserted or reordered', () => {
    const before = withOccurrenceKeys(['a', 'b', 'a'], (item) => item);
    const after = withOccurrenceKeys(['b', 'new', 'a', 'a'], (item) => item);
    expect(after.filter(({ item }) => item === 'a')).toEqual(
      before.filter(({ item }) => item === 'a'),
    );
    expect(after[0]).toEqual(before[1]);
  });

  it('keeps distinct content identities separate even with key punctuation', () => {
    const keyed = withOccurrenceKeys(['a:1', 'a', 'a'], (item) => item);
    expect(new Set(keyed.map(({ key }) => key)).size).toBe(3);
    expect(withOccurrenceKeys([], String)).toEqual([]);
  });
});
