import { describe, expect, it } from 'vitest';
import { calculateColumns } from '../utils/layout.js';

describe('calculateColumns', () => {
  it('calculates columns for a standard 120-wide terminal', () => {
    const cols = calculateColumns(120);
    expect(cols.id).toBe(5);
    expect(cols.profile).toBe(12);
    expect(cols.model).toBe(7);
    expect(cols.target).toBe(5);
    expect(cols.status).toBe(14);
    // Fixed total: 5+12+7+5+14 + 2(prefix) + 5*2(gaps) = 55
    // Task = min(60, 120 - 55) = 60
    expect(cols.task).toBe(60);
  });

  it('calculates columns for a standard 80-wide terminal', () => {
    const cols = calculateColumns(80);
    // Task = max(15, 80 - 55) = 25
    expect(cols.task).toBe(25);
  });

  it('enforces minimum task width of 15', () => {
    // Need terminal width where remainder < 15
    // 55 + 15 = 70, so width 50 => remainder = -5, clamped to 15
    const cols = calculateColumns(50);
    expect(cols.task).toBe(15);
  });

  it('fixed columns remain constant across widths', () => {
    for (const width of [80, 100, 120, 200]) {
      const cols = calculateColumns(width);
      expect(cols.id).toBe(5);
      expect(cols.profile).toBe(12);
      expect(cols.model).toBe(7);
      expect(cols.target).toBe(5);
      expect(cols.status).toBe(14);
    }
  });

  it('caps task width at 60 for very large terminal widths', () => {
    const cols = calculateColumns(300);
    expect(cols.task).toBe(60);
  });
});
