import { describe, expect, it } from 'vitest';
import { buildDetachedMcpFallbackMessage } from './operator-policy.js';
describe('detached MCP fallback text', () => {
  it('preserves the labelled response and duplicate guidance', () => {
    expect(buildDetachedMcpFallbackMessage('ask_human', 'Saved answer')).toBe(
      'Fallback response for the previous ask_human MCP call:\n\nSaved answer\n\nThe original MCP response stream closed before this answer could be delivered. If you already received the same answer directly from the tool call, ignore this duplicate.',
    );
    expect(buildDetachedMcpFallbackMessage(undefined, 'Answer')).toContain('previous MCP call:');
  });
});
