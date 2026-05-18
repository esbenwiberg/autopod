import { describe, expect, it } from 'vitest';
import {
  generateHistoryInstructions,
  getHistoryInstructionTarget,
} from './instructions-generator.js';

describe('instructions-generator', () => {
  it('generates runtime instructions with dataset stats', () => {
    const result = generateHistoryInstructions({
      totalSessions: 47,
      byStatus: { complete: 32, failed: 8, killed: 7 },
      totalCost: 23.45,
    });

    expect(result).toContain('47 pods');
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
    expect(result).toContain('agent-instruction improvements');
    expect(result).toContain('skill');
    expect(result).toContain('token waste');
  });

  it('uses Codex instruction targets when requested', () => {
    const target = getHistoryInstructionTarget('codex');
    const result = generateHistoryInstructions(
      {
        totalSessions: 3,
        byStatus: { complete: 3 },
        totalCost: 1.25,
      },
      target,
    );

    expect(target.path).toBe('/workspace/AGENTS.md');
    expect(result).toContain('You are Codex');
    expect(result).toContain('Suggested AGENTS.md addition');
  });

  it('keeps Claude instruction targets for Claude profiles', () => {
    const target = getHistoryInstructionTarget('claude');

    expect(target.path).toBe('/workspace/CLAUDE.md');
    expect(target.agentName).toBe('Claude Code');
  });

  it('handles zero pods gracefully', () => {
    const result = generateHistoryInstructions({
      totalSessions: 0,
      byStatus: {},
      totalCost: 0,
    });

    expect(result).toContain('0 pods');
    expect(result).toContain('0.0%');
  });
});
