import type { QualitySignals } from '@autopod/shared';
import { describe, expect, it } from 'vitest';
import { computeScore, isQualityScoreEligible } from './quality-score.js';

function signals(overrides: Partial<QualitySignals> = {}): QualitySignals {
  return {
    podId: 'pod-1',
    inspectionAvailability: 'available',
    inspectionUnavailableReason: null,
    ambiguousInspectionCount: 0,
    readCount: 10,
    editCount: 2,
    modifiedFileCount: 2,
    readEditRatio: 5,
    editsWithoutPriorRead: 0,
    userInterrupts: 0,
    editChurnCount: 0,
    tellsCount: 0,
    prFixAttempts: 0,
    validationPassed: null,
    browserChecks: null,
    tokens: { input: 0, output: 0, costUsd: 0 },
    grade: 'green',
    score: null,
    model: 'claude-opus-5',
    ...overrides,
  };
}

describe('computeScore v3 process health', () => {
  it('process-score-excludes-outcomes', () => {
    const process = signals({
      readEditRatio: 1.5,
      editsWithoutPriorRead: 1,
      editChurnCount: 1,
      prFixAttempts: 4,
      validationPassed: false,
    });

    const completed = computeScore({
      signals: process,
      stage: { kind: 'terminal', finalStatus: 'complete' },
    });
    const killed = computeScore({
      signals: { ...process, validationPassed: true, prFixAttempts: 0 },
      stage: { kind: 'terminal', finalStatus: 'killed' },
    });
    const provisional = computeScore({ signals: process, stage: { kind: 'provisional' } });

    expect(completed).toBe(killed);
    expect(killed).toBe(provisional);
  });

  it('process-score-normalizes-task-size', () => {
    const small = computeScore({
      signals: signals({
        modifiedFileCount: 5,
        editsWithoutPriorRead: 4,
        editChurnCount: 4,
      }),
      stage: { kind: 'provisional' },
    });
    const large = computeScore({
      signals: signals({
        modifiedFileCount: 50,
        editsWithoutPriorRead: 4,
        editChurnCount: 4,
      }),
      stage: { kind: 'provisional' },
    });

    expect(large).toBeGreaterThan(small);
  });

  it('awards 100 to a clean observable trajectory', () => {
    expect(computeScore({ signals: signals(), stage: { kind: 'provisional' } })).toBe(100);
  });

  it('saturates inspection discipline at a read/edit ratio of three', () => {
    const three = computeScore({
      signals: signals({ readEditRatio: 3 }),
      stage: { kind: 'provisional' },
    });
    const twenty = computeScore({
      signals: signals({ readEditRatio: 20 }),
      stage: { kind: 'provisional' },
    });
    expect(three).toBe(twenty);
  });

  it('keeps read-only pods neutral', () => {
    expect(
      computeScore({
        signals: signals({ editCount: 0, modifiedFileCount: 0, readEditRatio: 0 }),
        stage: { kind: 'provisional' },
      }),
    ).toBe(100);
  });
});

describe('isQualityScoreEligible', () => {
  it('rejects unavailable, mixed Pi, and historical Pi evidence', () => {
    expect(
      isQualityScoreEligible({ signals: signals(), hasPiAttempt: false, hasNonPiAttempt: true }),
    ).toBe(true);
    expect(
      isQualityScoreEligible({
        signals: signals({ inspectionAvailability: 'unavailable' }),
        hasPiAttempt: false,
        hasNonPiAttempt: true,
      }),
    ).toBe(false);
    expect(
      isQualityScoreEligible({ signals: signals(), hasPiAttempt: true, hasNonPiAttempt: true }),
    ).toBe(false);
    expect(
      isQualityScoreEligible({
        signals: signals(),
        hasPiAttempt: true,
        hasNonPiAttempt: false,
        historical: true,
      }),
    ).toBe(false);
  });
});
