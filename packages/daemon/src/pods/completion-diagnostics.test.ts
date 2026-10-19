import type { ScanFinding } from '@autopod/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  createCompletionDiagnostics,
  describeSyncFailure,
  formatElapsedDuration,
  operatorErrorMessage,
  sanitizeFailureReason,
  sanitizeSecurityScanLogValue,
  summarizeAgentCompletionBlocker,
} from './completion-diagnostics.js';

describe('completion operator diagnostics', () => {
  it.each(['setup', 'agent', 'completion'] as const)('preserves the %s failure prefix', (phase) => {
    expect(operatorErrorMessage(new Error('Synthetic failure'), phase)).toContain(
      'Synthetic failure',
    );
    expect(operatorErrorMessage(new Error('Synthetic failure'), phase)).toContain(
      phase === 'setup'
        ? 'before the agent'
        : phase === 'agent'
          ? 'while the agent'
          : 'while finalizing',
    );
  });
  it.each([
    'bwrap: no permissions to create a new namespace',
    'blocked by the execution environment',
    "can't inspect files or edit code",
  ])('recognizes original environment blocker %s', (result) => {
    expect(summarizeAgentCompletionBlocker(result)).toEqual(expect.any(String));
  });
  it('retains bounds, normalization, fallback and original sync error identity rendering', () => {
    expect(sanitizeSecurityScanLogValue(' a\n b ', 'fallback')).toBe('a b');
    expect(sanitizeSecurityScanLogValue(' ', 'fallback')).toBe('fallback');
    expect(sanitizeSecurityScanLogValue('x'.repeat(450), 'fallback')).toHaveLength(400);
    expect(sanitizeFailureReason('x'.repeat(1400), 'Failure')).toHaveLength(1209);
    expect(describeSyncFailure(new TypeError('synthetic'))).toBe('TypeError: synthetic');
    expect(describeSyncFailure(7)).toBe('7');
    expect(formatElapsedDuration(1234)).toBe('1.2s');
    expect(summarizeAgentCompletionBlocker('Ordinary completion')).toBeNull();
  });
  it('emits only twenty bounded finding rows plus summary and omission count with fatal=false', () => {
    const emit = vi.fn();
    const owner = createCompletionDiagnostics({ emitActivityError: emit });
    const findings: ScanFinding[] = Array.from({ length: 22 }, (_, i) => ({
      severity: 'high',
      detector: 'secrets',
      snippet: '[redacted synthetic finding]',
      ruleId: `rule-${i}`,
      file: `file-${i}`,
      line: i + 1,
    }));
    owner.emitBlockingSecurityScanFindings('pod', findings);
    expect(emit).toHaveBeenCalledTimes(22);
    expect(emit.mock.calls.every((call) => call[0] === 'pod' && call[2] === false)).toBe(true);
    expect(emit.mock.calls.at(-1)?.[1]).toContain('2 additional security findings');
  });
});
