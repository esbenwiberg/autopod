import { describe, expect, it } from 'vitest';
import { pickFields, pickFieldsArray, resolveResultPath } from './handler.js';

describe('pickFields', () => {
  it('picks top-level fields', () => {
    const obj = { title: 'Bug', body: 'Details', secret: 'hidden', extra: 123 };
    const result = pickFields(obj, ['title', 'body']);
    expect(result).toEqual({ title: 'Bug', body: 'Details' });
  });

  it('picks nested fields via dot notation', () => {
    const obj = {
      id: 1,
      fields: {
        'System.Title': 'Work Item',
        'System.State': 'Active',
        'System.AssignedTo': 'alice',
      },
    };
    const result = pickFields(obj, ['id', 'fields.System.Title', 'fields.System.State']);
    expect(result).toEqual({
      id: 1,
      'fields.System.Title': 'Work Item',
      'fields.System.State': 'Active',
    });
  });

  it('skips missing fields', () => {
    const obj = { title: 'Bug' };
    const result = pickFields(obj, ['title', 'missing_field']);
    expect(result).toEqual({ title: 'Bug' });
  });

  it('handles null/undefined input', () => {
    expect(pickFields(null, ['title'])).toEqual({});
    expect(pickFields(undefined, ['title'])).toEqual({});
  });

  it('handles empty fields array', () => {
    expect(pickFields({ a: 1 }, [])).toEqual({});
  });
});

describe('pickFieldsArray', () => {
  it('applies field picking to each item', () => {
    const items = [
      { title: 'Issue 1', secret: 'x', state: 'open' },
      { title: 'Issue 2', secret: 'y', state: 'closed' },
    ];
    const result = pickFieldsArray(items, ['title', 'state']);
    expect(result).toEqual([
      { title: 'Issue 1', state: 'open' },
      { title: 'Issue 2', state: 'closed' },
    ]);
  });
});

describe('resolveResultPath', () => {
  it('resolves nested path', () => {
    const obj = { data: { results: [1, 2, 3] } };
    expect(resolveResultPath(obj, 'data.results')).toEqual([1, 2, 3]);
  });

  it('returns whole object when no path', () => {
    const obj = { data: 123 };
    expect(resolveResultPath(obj, undefined)).toEqual(obj);
  });

  it('returns undefined for missing path', () => {
    const obj = { data: { nested: 'value' } };
    expect(resolveResultPath(obj, 'data.missing.deep')).toBeUndefined();
  });
});
