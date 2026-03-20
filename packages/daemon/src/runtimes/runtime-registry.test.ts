import { RuntimeError } from '@autopod/shared';
import type { Runtime } from '@autopod/shared';
import { describe, expect, it, vi } from 'vitest';
import { createRuntimeRegistry } from './runtime-registry.js';

function mockRuntime(type: 'claude' | 'codex'): Runtime {
  return {
    type,
    spawn: vi.fn(async function* () {}),
    resume: vi.fn(async function* () {}),
    abort: vi.fn(async () => {}),
  };
}

describe('createRuntimeRegistry', () => {
  it('returns the correct runtime by type', () => {
    const claude = mockRuntime('claude');
    const codex = mockRuntime('codex');
    const registry = createRuntimeRegistry([claude, codex]);

    expect(registry.get('claude')).toBe(claude);
    expect(registry.get('codex')).toBe(codex);
  });

  it('throws RuntimeError for unknown type', () => {
    const registry = createRuntimeRegistry([mockRuntime('claude')]);
    expect(() => registry.get('codex')).toThrow(RuntimeError);
  });

  it('works with a single runtime', () => {
    const codex = mockRuntime('codex');
    const registry = createRuntimeRegistry([codex]);
    expect(registry.get('codex')).toBe(codex);
  });

  it('works with empty registry', () => {
    const registry = createRuntimeRegistry([]);
    expect(() => registry.get('claude')).toThrow(RuntimeError);
  });
});
