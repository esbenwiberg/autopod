import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { structuredFindingSourceId } from './finding-fingerprint.js';
import { createFrozenReviewPacket, runReviewBatch } from './review-batch-runner.js';

const packet = () =>
  createFrozenReviewPacket({
    diff: 'diff --git a/a.ts b/a.ts\n+++ b/a.ts\n+guard();\n',
    reviewedHead: 'abc',
    task: 'bounded task summary',
    context: 'bounded enriched codebase context',
    executableContract: 'bounded executable contract',
    initialFindings: [],
    validationSummary: 'bounded validation summary',
    factSummary: 'bounded fact summary',
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
      packet: {
        ...packet(),
        initialFindings: [{ id: 'broad-1', source: 'initial-review', issue: 'broad blocker' }],
      },
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
    const frozenContent = prompts.map((prompt) => prompt.slice(prompt.indexOf('Task: ')));
    expect(new Set(frozenContent).size).toBe(1);
    expect(frozenContent[0]).toContain('Task: bounded task summary');
    expect(frozenContent[0]).toContain('Contract: bounded executable contract');
    expect(frozenContent[0]).toContain('Initial broad-review inputs: [{"id":"broad-1"');
    expect(frozenContent[0]).toContain('Validation: bounded validation summary');
    expect(frozenContent[0]).toContain('Facts: bounded fact summary');
    expect(frozenContent[0]).toContain('Context: bounded enriched codebase context');
    expect(frozenContent[0]).toContain('+guard();');
    expect(prompts.map((prompt) => prompt.match(/You are the (.*?) reviewer/)?.[1]).sort()).toEqual(
      [
        'contract_completeness',
        'lifecycle_reliability',
        'persistence_reproducibility',
        'security_authority',
        'tests_integration',
      ],
    );
    expect(prompts).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          'Check every stated contract requirement, boundary, and completeness gap.',
        ),
        expect.stringContaining(
          'Check authentication, authorization, secrets, trust boundaries, and privilege escalation.',
        ),
        expect.stringContaining(
          'Check state transitions, retries, failure handling, concurrency, and cleanup.',
        ),
        expect.stringContaining(
          'Check durable data, migrations, determinism, replayability, and configuration.',
        ),
        expect.stringContaining(
          'Check test coverage, integration behavior, executable validation, and realistic failure modes.',
        ),
      ]),
    );
    expect(batch.axes).toHaveLength(5);
    expect(batch.axes.every((axis) => axis.durationMs !== undefined)).toBe(true);
  });

  it('retries one failed axis and fails closed when it remains unavailable', async () => {
    let calls = 0;
    const batch = await runReviewBatch({
      packet: packet(),
      model: 'test',
      execute: async (prompt, label) => {
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

  it('retries malformed output with a stable code without echoing model output', async () => {
    const prompts: string[] = [];
    let first = true;
    const batch = await runReviewBatch({
      packet: packet(),
      model: 'test',
      execute: async (prompt, label) => {
        if (label.includes('security_authority') && first) {
          first = false;
          prompts.push(prompt);
          return { stdout: '{malformed secret output' };
        }
        if (label.includes('security_authority')) prompts.push(prompt);
        return { stdout: response };
      },
    });
    expect(batch.axes.find((axis) => axis.axis === 'security_authority')).toMatchObject({
      status: 'completed',
      attempts: 2,
    });
    expect(prompts[1]).toContain('REVIEW_AXIS_RESPONSE_INVALID');
    expect(prompts[1]).not.toContain('malformed secret output');
  });

  it('records invalid response as a typed blocking axis failure', async () => {
    const batch = await runReviewBatch({
      packet: packet(),
      model: 'test',
      execute: async () => ({ stdout: '{bad' }),
    });
    expect(batch.axes[0]).toMatchObject({
      status: 'unavailable',
      attempts: 2,
      failure: { kind: 'invalid-response', code: 'REVIEW_AXIS_RESPONSE_INVALID' },
    });
    expect(batch.infrastructureUnavailable).toBe(true);
  });

  it.each([
    ['timed out', 'timeout'],
    ['provider authentication unavailable', 'provider-unavailable'],
    ['runner exploded', 'runner-failed'],
    ['reviewed HEAD changed during frozen batch', 'head-changed'],
  ] as const)('classifies %s as %s', async (message, kind) => {
    const batch = await runReviewBatch({
      packet: packet(),
      model: 'test',
      execute: async () => {
        throw new Error(message);
      },
    });
    expect(batch.axes[0]?.failure?.kind).toBe(kind);
  });

  it('does not retry an axis when prior runner termination is unconfirmed', async () => {
    let calls = 0;
    const batch = await runReviewBatch({
      packet: packet(),
      model: 'test',
      execute: async (_prompt, label) => {
        if (!label.includes('contract_completeness')) return { stdout: response };
        calls++;
        throw new Error('remote reviewer exit was not observed after kill');
      },
    });
    expect(calls).toBe(1);
    expect(batch.axes[0]).toMatchObject({
      status: 'unavailable',
      attempts: 1,
      failure: {
        kind: 'runner-failed',
        code: 'REVIEW_RUNNER_TERMINATION_UNCONFIRMED',
        retryable: false,
      },
    });
  });

  it('shares one deadline across axis calls and skips synthesis after an unavailable axis', async () => {
    const timeouts: number[] = [];
    let synthesized = false;
    const batch = await runReviewBatch({
      packet: packet(),
      model: 'test',
      timeoutMs: 1,
      execute: async (_prompt, label, timeoutMs) => {
        timeouts.push(timeoutMs);
        if (label.includes('contract_completeness')) throw new Error('reviewer unavailable');
        return { stdout: response };
      },
      synthesize: async () => {
        synthesized = true;
        return { stdout: '{"decisions":[]}' };
      },
    });
    expect(timeouts.every((timeout) => timeout <= 1)).toBe(true);
    expect(batch.infrastructureUnavailable).toBe(true);
    expect(synthesized).toBe(false);
  });

  it('retains distinct cross-axis sources for the same semantic finding', async () => {
    const batch = await runReviewBatch({
      packet: packet(),
      model: 'test',
      execute: async () => ({ stdout: response }),
    });
    expect(batch.synthesis).toBe('deterministic-fallback');
    expect(batch.candidates).toHaveLength(5);
    expect(batch.accepted).toHaveLength(5);
  });

  it('degrades and leaves the initial broad-review blocker for ledger fallback when synthesis fails', async () => {
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
    expect(batch.quality).toBe('degraded');
    expect(batch.degradationReasons).toContain('SYNTHESIS_INVALID');
    expect(batch.degradationReasons).toContain('INITIAL_FINDING_UNMATCHED');
    expect(batch.accepted.every((finding) => !('source' in finding))).toBe(true);
  });

  it('persists source-backed model accept and reject decisions', async () => {
    const initial = {
      id: 'broad-1',
      source: 'initial-review' as const,
      issue: 'broad blocker',
    };
    const candidateId = structuredFindingSourceId({
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
    expect(batch.quality).toBe('degraded');
    expect(batch.accepted).toEqual([]);
    expect(batch.rejected).toEqual([
      {
        sourceIds: [candidateId],
        reason: 'Duplicated by the broad review.',
      },
    ]);
  });
});
