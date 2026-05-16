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

  it('projects through arrays for paths like `array.field`', () => {
    // Regression: getNestedValue used to treat arrays as plain objects, so
    // `comments.content` on { comments: [...] } silently returned undefined
    // and the field was dropped from the output entirely.
    const obj = {
      id: 1,
      comments: [
        { content: 'first', author: { name: 'a' } },
        { content: 'second', author: { name: 'b' } },
      ],
    };
    expect(pickFields(obj, ['id', 'comments.content', 'comments.author.name'])).toEqual({
      id: 1,
      'comments.content': ['first', 'second'],
      'comments.author.name': ['a', 'b'],
    });
  });

  it('skips array elements where the path resolves to undefined', () => {
    const obj = {
      comments: [{ content: 'has it' }, { other: 'missing content' }, { content: 'also has it' }],
    };
    expect(pickFields(obj, ['comments.content'])).toEqual({
      'comments.content': ['has it', 'also has it'],
    });
  });

  it('omits array-projected field entirely when no element matches', () => {
    const obj = { comments: [{ a: 1 }, { b: 2 }] };
    // Result is an empty array — still a defined value, so the key appears.
    // Consumers can distinguish "no matches" (empty array) from "field absent".
    expect(pickFields(obj, ['comments.content'])).toEqual({ 'comments.content': [] });
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
