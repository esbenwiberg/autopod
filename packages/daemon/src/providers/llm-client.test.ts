import { describe, expect, it } from 'vitest';
import { resolveAnthropicModelId } from './llm-client.js';

describe('resolveAnthropicModelId', () => {
  it('expands defensive Claude aliases to current canonical profile targets', () => {
    expect(resolveAnthropicModelId('opus')).toBe('claude-opus-4-8');
    expect(resolveAnthropicModelId('sonnet')).toBe('claude-sonnet-4-6');
    expect(resolveAnthropicModelId('haiku')).toBe('claude-haiku-4-5');
  });

  it('passes canonical model IDs through unchanged', () => {
    expect(resolveAnthropicModelId('claude-opus-4-7')).toBe('claude-opus-4-7');
    expect(resolveAnthropicModelId('claude-opus-4-8')).toBe('claude-opus-4-8');
  });
});
