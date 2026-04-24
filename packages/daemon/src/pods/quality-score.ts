import type { QualitySignals } from '@autopod/shared';

export interface ScoreInputs {
  signals: QualitySignals;
  /** Terminal status from `PodCompletedEvent`. */
  finalStatus: 'complete' | 'killed';
}

/**
 * Weighted 0..100 blend of the behavioural signals. Higher is better.
 *
 * The weights are a starting point — tune from real data once the table has
 * a few hundred rows.
 *
 *   30  reading behavior      readEditRatio saturates at 5
 *   20  blind-edit penalty    zero at 0 blind edits, floor at 5
 *   20  stop-phrase tells     zero at 0, floor at 5
 *   15  interrupt penalty     zero at 0, floor at 3
 *   10  complete bonus
 *   10  edit churn penalty    0 churned files = full, 2+ = zero
 *  ±5  validation outcome    +5 if passed, −5 if failed
 *  −20  PR fix attempt cap    −5 per fix cycle, max −20
 */
export function computeScore(inputs: ScoreInputs): number {
  const { signals, finalStatus } = inputs;

  // A research/no-edit pod can't really be scored on read:edit — give it the
  // full reading weight so those runs don't land at 0.
  const readingScore = signals.editCount === 0 ? 30 : 30 * clamp01(signals.readEditRatio / 5);

  const blindEditScore = 20 * (1 - Math.min(signals.editsWithoutPriorRead / 5, 1));
  const tellsScore = 20 * (1 - Math.min(signals.tellsCount / 5, 1));
  const interruptScore = 15 * (1 - Math.min(signals.userInterrupts / 3, 1));
  const completeBonus = finalStatus === 'complete' ? 10 : 0;

  // Edit churn: 0 churned files → 10pts; 1 → 5pts; 2+ → 0pts.
  const churnScore = signals.editChurnCount === 0 ? 10 : signals.editChurnCount === 1 ? 5 : 0;

  // Validation outcome: binary ±5 on top of base score.
  const validationBonus =
    signals.validationPassed === true ? 5 : signals.validationPassed === false ? -5 : 0;

  // PR fix penalty: -5 per fix cycle, capped at -20.
  const fixPenalty = -Math.min(signals.prFixAttempts * 5, 20);

  const total =
    readingScore +
    blindEditScore +
    tellsScore +
    interruptScore +
    completeBonus +
    churnScore +
    validationBonus +
    fixPenalty;
  return Math.round(clamp(total, 0, 100));
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function clamp01(v: number): number {
  return clamp(v, 0, 1);
}
