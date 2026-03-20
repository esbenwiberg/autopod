import { describe, expect, it } from 'vitest';
import { truncate } from '../utils/truncate.js';

describe('truncate', () => {
  it('returns original text when shorter than maxLength', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('returns original text when exactly maxLength', () => {
    expect(truncate('hello', 5)).toBe('hello');
  });

  it('truncates with ellipsis when longer than maxLength', () => {
    const result = truncate('hello world', 6);
    expect(result).toBe('hello\u2026');
    expect(result.length).toBe(6);
  });

  it('handles maxLength of 1', () => {
    expect(truncate('hello', 1)).toBe('h');
  });

  it('handles maxLength of 0', () => {
    expect(truncate('hello', 0)).toBe('');
  });

  it('handles empty string', () => {
    expect(truncate('', 5)).toBe('');
  });

  it('handles maxLength of 3 (edge case for ellipsis)', () => {
    expect(truncate('hello', 3)).toBe('he\u2026');
  });

  it('handles maxLength of 2', () => {
    expect(truncate('hello', 2)).toBe('he');
  });
});
