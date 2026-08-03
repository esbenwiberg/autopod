import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { structuredFindingId } from './finding-fingerprint.js';
import { createFrozenReviewPacket, runReviewBatch } from './review-batch-runner.js';

const packet = () =>
  createFrozenReviewPacket({
    diff: 'diff --git a/a.ts b/a.ts\n+++ b/a.ts\n',
    reviewedHead: 'abc',
    task: 'task',
    context: 'context',
    initialFindings: [],
    promptVersion: 'v1',
    schemaVersion: 'v1',
  });
const response = JSON.stringify({
  findings: [
    {
      severity: 'HIGH',
      path: 'a.ts',
      claim: 'missing authorization',
      evidence: 'route has no guard',
      remediation: 'add guard',
      confidence: 0.9,
    },
  ],
});

describe('runReviewBatch', () => {
  it('derives packet identity from its frozen diff instead of caller metadata', () => {
    const frozen = createFrozenReviewPacket({
      ...packet(),
      diffHash: 'tampered',
    } as never);
    expect(frozen.diffHash).toBe(createHash('sha256').update(frozen.diff).digest('hex'));
  });

  it('shares one frozen packet and limits concurrency to three', async () => {
    let active = 0;
    let max = 0;
    const ids: string[] = [];
    const hashes: string[] = [];
    const heads: string[] = [];
    const prompts: string[] = [];
    const batch = await runReviewBatch({
      packet: packet(),
      model: 'test',
      execute: async (prompt) => {
        active++;
        max = Math.max(max, active);
        ids.push(prompt.match(/id=([^ ]+)/)?.[1] ?? '');
        hashes.push(prompt.match(/diffHash=([^ ]+)/)?.[1] ?? '');
        heads.push(prompt.match(/head=([^ ]+)/)?.[1] ?? '');
        prompts.push(prompt);
        await Promise.resolve();
        active--;
        return { stdout: response };
      },
    });
    expect(max).toBeLessThanOrEqual(3);
    expect(new Set(ids)).toEqual(new Set([batch.id]));
    expect(new Set(hashes)).toEqual(new Set([batch.diffHash]));
    expect(new Set(heads)).toEqual(new Set([batch.reviewedHead]));
    expect(new Set(prompts.map((prompt) => prompt.match(/Context: (.*)/)?.[1]))).toEqual(
      new Set(['context']),
    );
    expect(
      new Set(prompts.map((prompt) => prompt.match(/You are the (.*?) reviewer/)?.[1])).size,
    ).toBe(5);
    expect(batch.axes).toHaveLength(5);
  });

  it('retries one failed axis and fails closed when it remains unavailable', async () => {
    let calls = 0;
    const batch = await runReviewBatch({
      packet: packet(),
      model: 'test',
      execute: async (_prompt, label) => {
        if (label.includes('security_authority')) {
          calls++;
          throw new Error('offline');
        }
        return { stdout: response };
      },
    });
    expect(calls).toBe(2);
    expect(batch.infrastructureUnavailable).toBe(true);
    expect(batch.axes.find((axis) => axis.axis === 'security_authority')).toMatchObject({
      status: 'unavailable',
      attempts: 2,
    });
  });

  it('keeps a deterministic union when candidates overlap', async () => {
    const batch = await runReviewBatch({
      packet: packet(),
      model: 'test',
      execute: async () => ({ stdout: response }),
    });
    expect(batch.synthesis).toBe('deterministic-fallback');
    expect(batch.candidates).toHaveLength(5);
    expect(batch.accepted).toHaveLength(5);
  });

  it('keeps the initial broad-review blocker when synthesis fails', async () => {
    const initial = {
      id: 'broad-1',
      source: 'initial-review' as const,
      issue: 'broad blocker',
    };
    const batch = await runReviewBatch({
      packet: { ...packet(), initialFindings: [initial] },
      model: 'test',
      execute: async () => ({ stdout: response }),
      synthesize: async () => ({ stdout: '{malformed' }),
    });
    expect(batch.synthesis).toBe('deterministic-fallback');
    expect(batch.accepted.map((finding) => finding.id)).toContain('broad-1');
  });

  it('persists source-backed model accept and reject decisions', async () => {
    const initial = {
      id: 'broad-1',
      source: 'initial-review' as const,
      issue: 'broad blocker',
    };
    const candidateId = structuredFindingId({
      axis: 'contract_completeness',
      path: 'a.ts',
      claim: 'missing authorization',
    });
    const batch = await runReviewBatch({
      packet: { ...packet(), initialFindings: [initial] },
      model: 'test',
      execute: async (_prompt, label) => ({
        stdout: label.includes('contract_completeness') ? response : '{"findings":[]}',
      }),
      synthesize: async () => ({
        stdout: JSON.stringify({
          decisions: [
            { action: 'accept', sourceIds: ['broad-1'], finding: initial },
            {
              action: 'reject',
              sourceIds: [candidateId],
              reason: 'Duplicated by the broad review.',
            },
          ],
        }),
      }),
    });
    expect(batch.synthesis).toBe('model');
    expect(batch.accepted).toEqual([initial]);
    expect(batch.rejected).toEqual([
      {
        sourceIds: [candidateId],
        reason: 'Duplicated by the broad review.',
      },
    ]);
  });
});
