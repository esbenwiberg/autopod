import { describe, expect, it } from 'vitest';
import { createAgentRunRegistry } from './agent-run-registry.js';
describe('agent run registry', () => {
  it('isolates owner instances and exposes the original mutable map references', () => {
    const a = createAgentRunRegistry();
    const b = createAgentRunRegistry();
    const token = Symbol('run');
    const owner = { token, settled: Promise.resolve() };
    const resolver = { token, resolve: () => {} };
    a.activeAgentRuns.set('pod', owner);
    a.activeAgentRunResolvers.set('pod', resolver);
    expect(a.activeAgentRuns.get('pod')).toBe(owner);
    expect(a.activeAgentRunResolvers.get('pod')).toBe(resolver);
    expect(b.activeAgentRuns.size).toBe(0);
    expect(b.activeAgentRunResolvers.size).toBe(0);
  });
});
