import { describe, expect, it } from 'vitest';
import { generateHistoryInstructions } from './instructions-generator.js';

describe('instructions-generator', () => {
  it('generates CLAUDE.md with dataset stats', () => {
    const result = generateHistoryInstructions({
      totalSessions: 47,
      byStatus: { complete: 32, failed: 8, killed: 7 },
      totalCost: 23.45,
    });

    expect(result).toContain('47 sessions');
    expect(result).toContain('15 failed');
    expect(result).toContain('31.9%');
    expect(result).toContain('$23.45');
  });

  it('includes database schema documentation', () => {
    const result = generateHistoryInstructions({
      totalSessions: 10,
      byStatus: { complete: 10 },
      totalCost: 5.0,
    });

    expect(result).toContain('/history/history.db');
    expect(result).toContain('/history/summary.md');
    expect(result).toContain('/history/analysis-guide.md');
    expect(result).toContain('sqlite3');
  });

  it('includes analysis goals', () => {
    const result = generateHistoryInstructions({
      totalSessions: 5,
      byStatus: { failed: 5 },
      totalCost: 10.0,
    });

    expect(result).toContain('recurring failure patterns');
    expect(result).toContain('CLAUDE.md');
    expect(result).toContain('skill');
    expect(result).toContain('token waste');
  });

  it('handles zero sessions gracefully', () => {
    const result = generateHistoryInstructions({
      totalSessions: 0,
      byStatus: {},
      totalCost: 0,
    });

    expect(result).toContain('0 sessions');
    expect(result).toContain('0.0%');
  });
});
