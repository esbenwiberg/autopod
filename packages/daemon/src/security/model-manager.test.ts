import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { createModelManager } from './model-manager.js';

const logger = pino({ level: 'silent' });

describe('createModelManager', () => {
  it('returns the same load promise across concurrent calls', async () => {
    // We don't load a real model in tests; we just verify the caching shape.
    const mm = createModelManager({ logger });
    const a = mm.getInjectionClassifier();
    const b = mm.getInjectionClassifier();
    expect(a).toBe(b);
  });

  it('returns null when a model fails to load (no network in tests)', async () => {
    // Force a failing import path by passing a clearly invalid model name.
    // The real loader catches dynamic-import errors and returns null.
    const mm = createModelManager({
      logger,
      injectionModel: `not-a-real/model-${Math.random()}`,
    });
    const cls = await mm.getInjectionClassifier();
    expect(cls).toBeNull();
  });

  it('memoizes the failed result — does not retry', async () => {
    const mm = createModelManager({
      logger,
      injectionModel: `not-a-real/model-${Math.random()}`,
    });
    const first = await mm.getInjectionClassifier();
    const second = await mm.getInjectionClassifier();
    expect(first).toBeNull();
    expect(second).toBeNull();
    // Same promise = the dynamic import only happened once.
    expect(mm.getInjectionClassifier()).toBe(mm.getInjectionClassifier());
  });
});

describe('createModelManager logger', () => {
  it('logs a warning when load fails', async () => {
    const warn = vi.fn();
    const fakeLogger = {
      info: vi.fn(),
      warn,
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
      // biome-ignore lint/suspicious/noExplicitAny: minimal logger stub
    } as any;
    const mm = createModelManager({
      logger: fakeLogger,
      injectionModel: `not-a-real/model-${Math.random()}`,
    });
    await mm.getInjectionClassifier();
    expect(warn).toHaveBeenCalled();
  });
});
