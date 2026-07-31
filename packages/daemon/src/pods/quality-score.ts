import type { QualitySignals } from '@autopod/shared';

export type ProcessHealthSignalInputs = Pick<
  QualitySignals,
  | 'editCount'
  | 'modifiedFileCount'
  | 'readEditRatio'
  | 'editsWithoutPriorRead'
  | 'tellsCount'
  | 'userInterrupts'
  | 'editChurnCount'
>;

export interface ScoreInputs {
  signals: QualitySignals;
  /** Retained for call-site compatibility; v3 process health is outcome-independent. */
  stage: { kind: 'provisional' } | { kind: 'terminal'; finalStatus: 'complete' | 'killed' };
}

export interface QualityEligibilityInputs {
  signals: QualitySignals;
  hasPiAttempt: boolean;
  hasNonPiAttempt: boolean;
  historical?: boolean;
}

export function isQualityScoreEligible(inputs: QualityEligibilityInputs): boolean {
  if (inputs.signals.inspectionAvailability !== 'available') return false;
  if (inputs.hasPiAttempt && inputs.hasNonPiAttempt) return false;
  if (inputs.historical === true && inputs.hasPiAttempt) return false;
  return true;
}

/**
 * Version 3 process-health score (0..100). Higher means a cleaner observable
 * trajectory; it is deliberately not an end-result quality score.
 *
 *   30  inspection discipline  read/edit ratio, saturated at 3
 *   25  blind modification     rate over distinct modified existing files
 *   20  stop/confusion tells   zero at 0, floor at 5
 *   15  human interruptions    zero at 0, floor at 3
 *   10  edit churn             rate over distinct modified existing files
 *
 * Completion, killed state, validation, and PR-fix outcomes do not affect this
 * score. They remain separate outcome/reliability evidence.
 */
export function computeScore(inputs: ScoreInputs): number {
  return computeProcessHealthScore(inputs.signals);
}

export function computeProcessHealthScore(signals: ProcessHealthSignalInputs): number {
  // Read-only/research pods have no mutation discipline to assess.
  const readingScore =
    signals.editCount === 0 ? 30 : 30 * clamp01((signals.readEditRatio ?? 0) / 3);

  const modifiedDenominator = Math.max(signals.modifiedFileCount, 1);
  const blindRate = (signals.editsWithoutPriorRead ?? 0) / modifiedDenominator;
  const blindEditScore = 25 * (1 - clamp01(blindRate));
  const tellsScore = 20 * (1 - Math.min(signals.tellsCount / 5, 1));
  const interruptScore = 15 * (1 - Math.min(signals.userInterrupts / 3, 1));
  const churnRate = signals.editChurnCount / modifiedDenominator;
  const churnScore = 10 * (1 - clamp01(churnRate));

  return Math.round(
    clamp(readingScore + blindEditScore + tellsScore + interruptScore + churnScore, 0, 100),
  );
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function clamp01(v: number): number {
  return clamp(v, 0, 1);
}
