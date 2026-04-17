import type { PodStatus } from '@autopod/shared';
import { describe, expect, it } from 'vitest';
import { formatDuration, formatDurationFromDates, formatStatus, getStatusStyle } from './colors.js';

const ALL_STATUSES: PodStatus[] = [
  'queued',
  'provisioning',
  'running',
  'awaiting_input',
  'validating',
  'validated',
  'failed',
  'review_required',
  'approved',
  'merging',
  'complete',
  'killing',
  'killed',
];

describe('colors', () => {
  describe('getStatusStyle', () => {
    it('returns a style for every status', () => {
      for (const status of ALL_STATUSES) {
        const style = getStatusStyle(status);
        expect(style).toBeDefined();
        expect(style.symbol).toBeTruthy();
        expect(style.label).toBeTruthy();
        expect(typeof style.color).toBe('function');
      }
    });
  });

  describe('formatStatus', () => {
    it('returns a non-empty string for every status', () => {
      for (const status of ALL_STATUSES) {
        const result = formatStatus(status);
        expect(result.length).toBeGreaterThan(0);
      }
    });
  });

  describe('formatDuration', () => {
    it('formats seconds', () => {
      expect(formatDuration(5000)).toBe('5s');
    });

    it('formats minutes and seconds', () => {
      expect(formatDuration(125_000)).toBe('2m 5s');
    });

    it('formats hours and minutes', () => {
      expect(formatDuration(3_725_000)).toBe('1h 2m');
    });

    it('returns dash for null', () => {
      expect(formatDuration(null)).toBe('-');
    });
  });

  describe('formatDurationFromDates', () => {
    it('returns dash for null start', () => {
      expect(formatDurationFromDates(null, null)).toBe('-');
    });

    it('calculates duration from start to end', () => {
      const start = '2024-01-01T00:00:00.000Z';
      const end = '2024-01-01T00:05:00.000Z';
      expect(formatDurationFromDates(start, end)).toBe('5m 0s');
    });
  });
});
