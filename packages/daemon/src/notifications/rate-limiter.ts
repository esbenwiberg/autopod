export interface RateLimiterOptions {
  maxPerSession?: number;
  windowMs?: number;
  cooldownMs?: number;
}

interface SessionRateState {
  count: number;
  windowStart: number;
  lastSentAt: number;
}

const DEFAULT_MAX_PER_SESSION = 10;
const DEFAULT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_COOLDOWN_MS = 30 * 1000; // 30 seconds

export interface RateLimiter {
  canSend(sessionId: string): { allowed: boolean; reason?: string };
  recordSent(sessionId: string): void;
  reset(sessionId: string): void;
}

export function createRateLimiter(options?: RateLimiterOptions): RateLimiter {
  const maxPerSession = options?.maxPerSession ?? DEFAULT_MAX_PER_SESSION;
  const windowMs = options?.windowMs ?? DEFAULT_WINDOW_MS;
  const cooldownMs = options?.cooldownMs ?? DEFAULT_COOLDOWN_MS;

  const states = new Map<string, SessionRateState>();

  function getState(sessionId: string): SessionRateState {
    const now = Date.now();
    let state = states.get(sessionId);

    if (!state) {
      state = { count: 0, windowStart: now, lastSentAt: 0 };
      states.set(sessionId, state);
      return state;
    }

    // Reset window if expired
    if (now - state.windowStart >= windowMs) {
      state.count = 0;
      state.windowStart = now;
    }

    return state;
  }

  return {
    canSend(sessionId: string): { allowed: boolean; reason?: string } {
      const now = Date.now();
      const state = getState(sessionId);

      if (state.count >= maxPerSession) {
        return {
          allowed: false,
          reason: `Rate limit exceeded: ${state.count}/${maxPerSession} notifications in window`,
        };
      }

      if (state.lastSentAt > 0 && now - state.lastSentAt < cooldownMs) {
        const remainingMs = cooldownMs - (now - state.lastSentAt);
        return {
          allowed: false,
          reason: `Cooldown active: ${Math.ceil(remainingMs / 1000)}s remaining`,
        };
      }

      return { allowed: true };
    },

    recordSent(sessionId: string): void {
      const state = getState(sessionId);
      state.count++;
      state.lastSentAt = Date.now();
    },

    reset(sessionId: string): void {
      states.delete(sessionId);
    },
  };
}
