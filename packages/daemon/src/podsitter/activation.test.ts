import type { PodsitterAuthorization } from '@autopod/shared';
import { describe, expect, it } from 'vitest';
import { evaluatePodsitterActivation, validatePodsitterActivation } from './activation.js';

function authorization(overrides: Partial<PodsitterAuthorization> = {}): PodsitterAuthorization {
  return {
    enabled: true,
    activation: { mode: 'always' },
    authorizedUntil: null,
    generation: 4,
    profileScope: null,
    ...overrides,
  };
}

describe('Podsitter activation', () => {
  it('evaluates disabled, always-on, and expired authorization', () => {
    expect(evaluatePodsitterActivation(authorization({ enabled: false }))).toMatchObject({
      active: false,
      reason: 'disabled',
    });
    expect(evaluatePodsitterActivation(authorization(), new Date('2026-07-29T12:00:00Z'))).toEqual({
      active: true,
      windowId: 'always:g4',
      windowStartedAt: null,
      windowEndsAt: null,
      reason: 'active',
    });
    expect(
      evaluatePodsitterActivation(
        authorization({ authorizedUntil: '2026-07-29T11:59:59.000Z' }),
        new Date('2026-07-29T12:00:00Z'),
      ),
    ).toMatchObject({ active: false, reason: 'expired' });
  });

  it('treats recurring cron occurrences as intervals, including cross-midnight', () => {
    const recurring = authorization({
      activation: {
        mode: 'recurring',
        cronExpression: '0 20 * * *',
        durationMinutes: 12 * 60,
        timeZone: 'Europe/Copenhagen',
      },
    });
    const inside = evaluatePodsitterActivation(recurring, new Date('2026-01-15T03:00:00Z'));
    expect(inside).toMatchObject({
      active: true,
      windowStartedAt: '2026-01-14T19:00:00.000Z',
      windowEndsAt: '2026-01-15T07:00:00.000Z',
    });
    expect(inside.windowId).toContain('2026-01-14T19:00:00.000Z');
    expect(evaluatePodsitterActivation(recurring, new Date('2026-01-15T12:00:00Z'))).toMatchObject({
      active: false,
      reason: 'outside_window',
    });
  });

  it('uses stable UTC occurrence identities across DST timezone changes', () => {
    const recurring = authorization({
      activation: {
        mode: 'recurring',
        cronExpression: '30 1 * * *',
        durationMinutes: 120,
        timeZone: 'Europe/Copenhagen',
      },
    });
    const beforeDst = evaluatePodsitterActivation(recurring, new Date('2026-03-28T01:00:00Z'));
    const afterDst = evaluatePodsitterActivation(recurring, new Date('2026-03-30T00:15:00Z'));
    expect(beforeDst).toMatchObject({
      active: true,
      windowStartedAt: '2026-03-28T00:30:00.000Z',
    });
    expect(afterDst).toMatchObject({
      active: true,
      windowStartedAt: '2026-03-29T23:30:00.000Z',
    });
    expect(afterDst.windowId).toContain('2026-03-29T23:30:00.000Z');
  });

  it('validates five-field cron, bounded duration, and IANA timezone', () => {
    expect(() =>
      validatePodsitterActivation({
        mode: 'recurring',
        cronExpression: '0 20 * * * *',
        durationMinutes: 60,
        timeZone: 'UTC',
      }),
    ).toThrow(/five-field/);
    expect(() =>
      validatePodsitterActivation({
        mode: 'recurring',
        cronExpression: '0 20 * * *',
        durationMinutes: 60,
        timeZone: 'Mars/Olympus',
      }),
    ).toThrow(/IANA/);
    expect(() =>
      validatePodsitterActivation({
        mode: 'recurring',
        cronExpression: 'invalid cron',
        durationMinutes: 60,
        timeZone: 'UTC',
      }),
    ).toThrow();
  });
});
