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
      tellsCount: 0,
    });
    // 30 (reading) + 25 (no blind) + 20 (no tells) + 15 (no interrupts) + 10 (complete) = 100
    expect(score).toBe(100);
  });

  it('subtracts the completion bonus when killed', () => {
    const score = computeScore({
      signals: signals({ readCount: 10, editCount: 2, readEditRatio: 5 }),
      finalStatus: 'killed',
      tellsCount: 0,
    });
    expect(score).toBe(90);
  });

  it('penalises blind edits linearly up to five', () => {
    const score = computeScore({
      signals: signals({ editsWithoutPriorRead: 5 }),
      finalStatus: 'complete',
      tellsCount: 0,
    });
    // 30 + 0 (blind) + 20 + 15 + 10 = 75
    expect(score).toBe(75);
  });

  it('saturates the reading score at ratio 5', () => {
    const tight = computeScore({
      signals: signals({ readCount: 25, editCount: 5, readEditRatio: 5 }),
      finalStatus: 'complete',
      tellsCount: 0,
    });
    const absurd = computeScore({
      signals: signals({ readCount: 1000, editCount: 5, readEditRatio: 200 }),
      finalStatus: 'complete',
      tellsCount: 0,
    });
    expect(tight).toBe(absurd);
  });

  it('penalises interrupts', () => {
    const score = computeScore({
      signals: signals({ userInterrupts: 3 }),
      finalStatus: 'complete',
      tellsCount: 0,
    });
    // 30 + 25 + 20 + 0 + 10 = 85
    expect(score).toBe(85);
  });

  it('does not crash a research pod with zero edits', () => {
    const score = computeScore({
      signals: signals({ readCount: 20, editCount: 0, readEditRatio: 0 }),
      finalStatus: 'complete',
      tellsCount: 0,
    });
    // reading short-circuits to full 30
    expect(score).toBe(100);
  });
});
