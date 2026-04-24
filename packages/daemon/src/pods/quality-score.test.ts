import type { QualitySignals } from '@autopod/shared';
import { describe, expect, it } from 'vitest';
import { computeScore } from './quality-score.js';

function signals(overrides: Partial<QualitySignals> = {}): QualitySignals {
  return {
    podId: 'pod-1',
    readCount: 10,
    editCount: 2,
    readEditRatio: 5,
    editsWithoutPriorRead: 0,
    userInterrupts: 0,
    editChurnCount: 0,
    tellsCount: 0,
    prFixAttempts: 0,
    validationPassed: null,
    tokens: { input: 0, output: 0, costUsd: 0 },
    grade: 'green',
    score: null,
    model: 'claude-opus-4-7',
    ...overrides,
  };
}

describe('computeScore', () => {
  it('awards a high score to a disciplined completed pod', () => {
    const score = computeScore({
      signals: signals({ readCount: 10, editCount: 2, readEditRatio: 5 }),
      finalStatus: 'complete',
    });
    // 30 (reading) + 20 (no blind) + 20 (no tells) + 15 (no interrupts) + 10 (complete) + 10 (no churn) = 105 → 100
    expect(score).toBe(100);
  });

  it('subtracts the completion bonus when killed', () => {
    const score = computeScore({
      signals: signals({ readCount: 10, editCount: 2, readEditRatio: 5 }),
      finalStatus: 'killed',
    });
    // 30 + 20 + 20 + 15 + 0 (killed) + 10 = 95
    expect(score).toBe(95);
  });

  it('penalises blind edits linearly up to five', () => {
    const score = computeScore({
      signals: signals({ editsWithoutPriorRead: 5 }),
      finalStatus: 'complete',
    });
    // 30 + 0 (blind) + 20 + 15 + 10 + 10 = 85
    expect(score).toBe(85);
  });

  it('saturates the reading score at ratio 5', () => {
    const tight = computeScore({
      signals: signals({ readCount: 25, editCount: 5, readEditRatio: 5 }),
      finalStatus: 'complete',
    });
    const absurd = computeScore({
      signals: signals({ readCount: 1000, editCount: 5, readEditRatio: 200 }),
      finalStatus: 'complete',
    });
    expect(tight).toBe(absurd);
  });

  it('penalises interrupts', () => {
    const score = computeScore({
      signals: signals({ userInterrupts: 3 }),
      finalStatus: 'complete',
    });
    // 30 + 20 + 20 + 0 (interrupts) + 10 + 10 = 90
    expect(score).toBe(90);
  });

  it('does not crash a research pod with zero edits', () => {
    const score = computeScore({
      signals: signals({ readCount: 20, editCount: 0, readEditRatio: 0 }),
      finalStatus: 'complete',
    });
    // reading short-circuits to full 30; 30+20+20+15+10+10 = 105 → 100
    expect(score).toBe(100);
  });

  it('penalises edit churn', () => {
    const score = computeScore({
      signals: signals({ editChurnCount: 2 }),
      finalStatus: 'complete',
    });
    // 30 + 20 + 20 + 15 + 10 + 0 (churn) = 95
    expect(score).toBe(95);
  });

  it('penalises PR fix attempts up to -20', () => {
    const oneFixScore = computeScore({
      signals: signals({ prFixAttempts: 1 }),
      finalStatus: 'complete',
    });
    const fourFixScore = computeScore({
      signals: signals({ prFixAttempts: 4 }),
      finalStatus: 'complete',
    });
    // 4+ fix attempts cap at -20, same as exactly 4
    const fiveFixScore = computeScore({
      signals: signals({ prFixAttempts: 5 }),
      finalStatus: 'complete',
    });
    // 1 fix: 105 - 5 = 100; 4 fix: 105 - 20 = 85; 5 fix: 105 - 20 = 85 (capped)
    expect(oneFixScore).toBe(100);
    expect(fourFixScore).toBe(85);
    expect(fiveFixScore).toBe(85);
  });

  it('applies validation bonus and penalty', () => {
    // Use an imperfect pod (3 blind edits) so the ±5 is visible.
    // blindEditScore = 20*(1-3/5) = 8; base = 30+8+20+15+10+10 = 93
    const passed = computeScore({
      signals: signals({ editsWithoutPriorRead: 3, validationPassed: true }),
      finalStatus: 'complete',
    });
    const failed = computeScore({
      signals: signals({ editsWithoutPriorRead: 3, validationPassed: false }),
      finalStatus: 'complete',
    });
    const none = computeScore({
      signals: signals({ editsWithoutPriorRead: 3, validationPassed: null }),
      finalStatus: 'complete',
    });
    expect(passed).toBe(98); // 93 + 5
    expect(failed).toBe(88); // 93 - 5
    expect(none).toBe(93);   // 93 ± 0
  });

  it('applies tell penalties per distinct pattern', () => {
    const score = computeScore({
      signals: signals({ tellsCount: 5 }),
      finalStatus: 'complete',
    });
    // tells 20 * (1 - 5/5) = 0; 30+0+0+15+10+10 = 65... wait:
    // 30 + 20 (blind) + 0 (tells) + 15 + 10 + 10 = 85
    expect(score).toBe(85);
  });
});
