import { describe, expect, it } from 'vitest';
import { calculateColumns } from '../utils/layout.js';

describe('calculateColumns', () => {
  it('calculates columns for a standard 120-wide terminal', () => {
    const cols = calculateColumns(120);
    expect(cols.id).toBe(5);
    expect(cols.profile).toBe(12);
    expect(cols.model).toBe(7);
    expect(cols.status).toBe(14);
    // Fixed total: 5+12+7+14 + 2(prefix) + 4*2(gaps) = 48
    // Task = 120 - 48 = 72
    expect(cols.task).toBe(72);
  });

  it('calculates columns for a standard 80-wide terminal', () => {
    const cols = calculateColumns(80);
    // Task = 80 - 48 = 32
    expect(cols.task).toBe(32);
  });

  it('enforces minimum task width of 15', () => {
    // Need terminal width where remainder < 15
    // 48 + 15 = 63, so width 50 => remainder = 2, clamped to 15
    const cols = calculateColumns(50);
    expect(cols.task).toBe(15);
  });

  it('fixed columns remain constant across widths', () => {
    for (const width of [80, 100, 120, 200]) {
      const cols = calculateColumns(width);
      expect(cols.id).toBe(5);
      expect(cols.profile).toBe(12);
      expect(cols.model).toBe(7);
      expect(cols.status).toBe(14);
    }
  });

  it('handles very large terminal widths', () => {
    const cols = calculateColumns(300);
    expect(cols.task).toBe(300 - 48);
  });
});
