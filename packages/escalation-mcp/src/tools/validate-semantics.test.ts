import { describe, expect, it, vi } from 'vitest';
import type { SemanticValidationInput, SemanticValidationResult } from '../pod-bridge.js';
import { validateSemantics } from './validate-semantics.js';

describe('validateSemantics', () => {
  it('defaults to all semantic phases', async () => {
    const runSemanticValidation = vi
      .fn<(podId: string, input: SemanticValidationInput) => Promise<SemanticValidationResult>>()
      .mockResolvedValue({
        passed: true,
        results: [
          { phase: 'health', configured: true, status: 'pass', passed: true },
          { phase: 'pages', configured: false, status: 'skip', passed: true },
          { phase: 'facts', configured: false, status: 'skip', passed: true },
          { phase: 'review', configured: true, status: 'pass', passed: true },
        ],
      });

    const raw = await validateSemantics('pod-1', {}, { runSemanticValidation } as never);
    const result = JSON.parse(raw);

    expect(result.passed).toBe(true);
    expect(runSemanticValidation).toHaveBeenCalledWith('pod-1', {
      phases: ['health', 'pages', 'facts', 'review'],
    });
  });

  it('deduplicates requested phases before calling the bridge', async () => {
    const runSemanticValidation = vi
      .fn<(podId: string, input: SemanticValidationInput) => Promise<SemanticValidationResult>>()
      .mockResolvedValue({
        passed: false,
        results: [{ phase: 'facts', configured: true, status: 'fail', passed: false }],
      });

    const raw = await validateSemantics(
      'pod-1',
      { phases: ['facts', 'facts'], plannedSummary: 'Implemented the feature' },
      { runSemanticValidation } as never,
    );
    const result = JSON.parse(raw);

    expect(result.passed).toBe(false);
    expect(runSemanticValidation).toHaveBeenCalledWith('pod-1', {
      phases: ['facts'],
      plannedSummary: 'Implemented the feature',
    });
  });
});
