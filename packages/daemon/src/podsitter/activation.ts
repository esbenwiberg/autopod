import {
  type PodsitterActivation,
  type PodsitterActivationEvaluation,
  type PodsitterAuthorization,
  podsitterActivationSchema,
} from '@autopod/shared';
import cronParser from 'cron-parser';

const { parseExpression } = cronParser;

export const MAX_PODSITTER_ACTIVATION_DURATION_MINUTES = 7 * 24 * 60;

function assertIanaTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
  } catch {
    throw new Error(`Invalid IANA time zone: "${timeZone}"`);
  }
}

export function validatePodsitterActivation(activation: PodsitterActivation): void {
  const parsed = podsitterActivationSchema.parse(activation);
  if (parsed.mode === 'always') return;
  if (parsed.cronExpression.trim().split(/\s+/).length !== 5) {
    throw new Error('Podsitter recurring activation requires a five-field cron expression');
  }
  if (parsed.durationMinutes > MAX_PODSITTER_ACTIVATION_DURATION_MINUTES) {
    throw new Error(
      `Podsitter activation duration cannot exceed ${MAX_PODSITTER_ACTIVATION_DURATION_MINUTES} minutes`,
    );
  }
  assertIanaTimeZone(parsed.timeZone);
  try {
    parseExpression(parsed.cronExpression, { tz: parsed.timeZone });
  } catch {
    throw new Error(`Invalid Podsitter cron expression: "${parsed.cronExpression}"`);
  }
}

export function evaluatePodsitterActivation(
  authorization: PodsitterAuthorization,
  at: Date = new Date(),
): PodsitterActivationEvaluation {
  if (!authorization.enabled) {
    return inactive('disabled');
  }
  const authorizedUntil = authorization.authorizedUntil
    ? new Date(authorization.authorizedUntil)
    : null;
  if (authorizedUntil && at.getTime() >= authorizedUntil.getTime()) {
    return inactive('expired');
  }
  validatePodsitterActivation(authorization.activation);

  if (authorization.activation.mode === 'always') {
    const end = authorizedUntil?.toISOString() ?? null;
    return {
      active: true,
      windowId: `always:g${authorization.generation}`,
      windowStartedAt: null,
      windowEndsAt: end,
      reason: 'active',
    };
  }

  const activation = authorization.activation;
  let occurrence: Date;
  try {
    occurrence = parseExpression(activation.cronExpression, {
      currentDate: new Date(at.getTime() + 1),
      tz: activation.timeZone,
    })
      .prev()
      .toDate();
  } catch {
    return inactive('outside_window');
  }
  const intervalEnd = new Date(occurrence.getTime() + activation.durationMinutes * 60_000);
  const effectiveEnd =
    authorizedUntil && authorizedUntil.getTime() < intervalEnd.getTime()
      ? authorizedUntil
      : intervalEnd;
  if (at.getTime() < occurrence.getTime() || at.getTime() >= effectiveEnd.getTime()) {
    return inactive('outside_window');
  }
  const occurrenceId = occurrence.toISOString();
  return {
    active: true,
    windowId: `recurring:g${authorization.generation}:${occurrenceId}`,
    windowStartedAt: occurrenceId,
    windowEndsAt: effectiveEnd.toISOString(),
    reason: 'active',
  };
}

function inactive(
  reason: Exclude<PodsitterActivationEvaluation['reason'], 'active'>,
): PodsitterActivationEvaluation {
  return {
    active: false,
    windowId: null,
    windowStartedAt: null,
    windowEndsAt: null,
    reason,
  };
}
