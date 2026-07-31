import { describe, expect, it } from 'vitest';
import { parseAgenticReviewOutput } from './review-agentic-runner.js';

describe('parseAgenticReviewOutput', () => {
  it('extracts the verdict and telemetry from Claude JSON output', () => {
    const result = parseAgenticReviewOutput(
      JSON.stringify({
        result: '{"status":"pass","reasoning":"clean","issues":[]}',
        usage: {
          input_tokens: 300,
          cache_read_input_tokens: 120,
          cache_creation_input_tokens: 80,
          output_tokens: 30,
        },
        total_cost_usd: 0.012,
      }),
    );

    expect(result).toEqual({
      stdout: '{"status":"pass","reasoning":"clean","issues":[]}',
      tokenUsage: {
        inputTokens: 500,
        cachedInputTokens: 120,
        cacheCreationInputTokens: 80,
        outputTokens: 30,
        costUsd: 0.012,
      },
    });
  });
});
