import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRateLimiter } from './rate-limiter.js';

describe('RateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows sending when no previous sends', () => {
    const limiter = createRateLimiter();
    const result = limiter.canSend('session-1');
    expect(result.allowed).toBe(true);
  });

  it('enforces cooldown between sends for same session', () => {
    const limiter = createRateLimiter({ cooldownMs: 5000 });

    limiter.recordSent('session-1');

    const result = limiter.canSend('session-1');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Cooldown');

    // Advance past cooldown
    vi.advanceTimersByTime(5001);
    const result2 = limiter.canSend('session-1');
    expect(result2.allowed).toBe(true);
  });

  it('enforces max count per window', () => {
    const limiter = createRateLimiter({ maxPerSession: 3, cooldownMs: 0 });

    limiter.recordSent('session-1');
    limiter.recordSent('session-1');
    limiter.recordSent('session-1');

    const result = limiter.canSend('session-1');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Rate limit exceeded');
    expect(result.reason).toContain('3/3');
  });

  it('resets count when window expires', () => {
    const windowMs = 60_000;
    const limiter = createRateLimiter({ maxPerSession: 2, windowMs, cooldownMs: 0 });

    limiter.recordSent('session-1');
    limiter.recordSent('session-1');
    expect(limiter.canSend('session-1').allowed).toBe(false);

    // Advance past window
    vi.advanceTimersByTime(windowMs + 1);
    expect(limiter.canSend('session-1').allowed).toBe(true);
  });

  it('tracks sessions independently', () => {
    const limiter = createRateLimiter({ maxPerSession: 1, cooldownMs: 0 });

    limiter.recordSent('session-1');
    expect(limiter.canSend('session-1').allowed).toBe(false);
    expect(limiter.canSend('session-2').allowed).toBe(true);
  });

  it('reset clears state for a session', () => {
    const limiter = createRateLimiter({ maxPerSession: 1, cooldownMs: 0 });

    limiter.recordSent('session-1');
    expect(limiter.canSend('session-1').allowed).toBe(false);

    limiter.reset('session-1');
    expect(limiter.canSend('session-1').allowed).toBe(true);
  });

  it('uses default values when no options provided', () => {
    const limiter = createRateLimiter();

    // Should allow up to 10 sends
    for (let i = 0; i < 10; i++) {
      limiter.recordSent('session-1');
      // Advance past cooldown (30s default)
      vi.advanceTimersByTime(31_000);
    }

    expect(limiter.canSend('session-1').allowed).toBe(false);
  });
});
