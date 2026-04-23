import type { QualitySignals } from '@autopod/shared';

export interface ScoreInputs {
  signals: QualitySignals;
  /** Terminal status from `PodCompletedEvent`. */
  finalStatus: 'complete' | 'killed';
  /** Stop-phrase tells — 0 until Phase 2 lands. */
  tellsCount: number;
}

/**
 * Weighted 0..100 blend of the behavioural signals. Higher is better.
 *
 * The weights are a starting point — tune them from real data once the
 * table has a few hundred rows. The point of locking in *any* formula is
 * that it lets `pod_quality_scores` become a persisted time series we can
 * trend, leaderboard, and drift-alert against.
 *
 *   30  reading behavior    readEditRatio saturates at 5
 *   25  blind-edit penalty  zero at 0 blind edits, floor at 5
 *   20  stop-phrase tells   zero at 0, floor at 5 (always 0 until Phase 2)
 *   15  interrupt penalty   zero at 0, floor at 3
 *   10  made-it-to-complete bonus
 */
export function computeScore(inputs: ScoreInputs): number {
  const { signals, finalStatus, tellsCount } = inputs;

  // A research/no-edit pod can't really be scored on read:edit — give it the
  // full reading weight so those runs don't land at 0. Same idea as the
  // `grade()` short-circuit in quality-signals.ts.
  const readingScore = signals.editCount === 0 ? 30 : 30 * clamp01(signals.readEditRatio / 5);

  const blindEditScore = 25 * (1 - Math.min(signals.editsWithoutPriorRead / 5, 1));
  const tellsScore = 20 * (1 - Math.min(tellsCount / 5, 1));
  const interruptScore = 15 * (1 - Math.min(signals.userInterrupts / 3, 1));
  const completeBonus = finalStatus === 'complete' ? 10 : 0;

  const total = readingScore + blindEditScore + tellsScore + interruptScore + completeBonus;
  return Math.round(clamp(total, 0, 100));
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function clamp01(v: number): number {
  return clamp(v, 0, 1);
}
