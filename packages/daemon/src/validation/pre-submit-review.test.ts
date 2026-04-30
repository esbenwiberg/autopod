import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../runtimes/run-claude-cli.js', () => ({
  runClaudeCli: vi.fn(),
}));

import { runClaudeCli } from '../runtimes/run-claude-cli.js';
import { hashDiff, runPreSubmitReview } from './pre-submit-review.js';

const mockRunClaudeCli = vi.mocked(runClaudeCli);

describe('runPreSubmitReview', () => {
  beforeEach(() => {
    mockRunClaudeCli.mockReset();
  });

  it('skips when there is no diff', async () => {
    const result = await runPreSubmitReview({
      task: 'Add a thing',
      diff: '',
      reviewerModel: 'sonnet',
    });

    expect(result.status).toBe('skipped');
    expect(result.skipReason).toBe('no-diff');
    expect(mockRunClaudeCli).not.toHaveBeenCalled();
  });

  it('skips when there is no task description', async () => {
    const result = await runPreSubmitReview({
      task: '',
      diff: 'diff --git a/foo b/foo',
      reviewerModel: 'sonnet',
    });

    expect(result.status).toBe('skipped');
    expect(result.skipReason).toBe('no-task');
  });

  it('returns the reviewer verdict on a clean pass', async () => {
    mockRunClaudeCli.mockResolvedValueOnce({
      stdout: JSON.stringify({
        status: 'pass',
        reasoning: 'Looks good — scope matches the task.',
        issues: [],
      }),
    });

    const result = await runPreSubmitReview({
      task: 'Add dark mode toggle',
      diff: 'diff --git a/app.tsx b/app.tsx\n+const [theme, setTheme] = useState("light")',
      reviewerModel: 'sonnet',
    });

    expect(result.status).toBe('pass');
    expect(result.issues).toEqual([]);
    expect(result.diffHash).toBeTruthy();
    expect(mockRunClaudeCli).toHaveBeenCalledTimes(1);
  });

  it('surfaces medium+ issues on a fail', async () => {
    mockRunClaudeCli.mockResolvedValueOnce({
      stdout: JSON.stringify({
        status: 'fail',
        reasoning: 'New endpoint is missing input validation.',
        issues: ['src/api/users.ts:42: Email field is not validated - add a Zod parse'],
      }),
    });

    const result = await runPreSubmitReview({
      task: 'Add user signup endpoint',
      diff: 'diff --git a/src/api/users.ts b/src/api/users.ts\n+app.post("/users", ...)',
      reviewerModel: 'sonnet',
    });

    expect(result.status).toBe('fail');
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toContain('Email field is not validated');
  });

  it('returns skipped when the model output cannot be parsed', async () => {
    mockRunClaudeCli.mockResolvedValueOnce({
      stdout: 'Sure, looks fine. No problems here.',
    });

    const result = await runPreSubmitReview({
      task: 'A task',
      diff: 'diff stuff',
      reviewerModel: 'sonnet',
    });

    expect(result.status).toBe('skipped');
    expect(result.skipReason).toBe('parse-failure');
  });

  it('returns skipped when the CLI fails / times out', async () => {
    mockRunClaudeCli.mockRejectedValueOnce(new Error('Command timed out after 90000ms'));

    const result = await runPreSubmitReview({
      task: 'A task',
      diff: 'diff stuff',
      reviewerModel: 'sonnet',
      timeoutMs: 90_000,
    });

    expect(result.status).toBe('skipped');
    expect(result.skipReason).toBe('cli-error');
    expect(result.reasoning).toContain('timed out');
  });

  it('forwards the planned summary and deviations into the prompt', async () => {
    mockRunClaudeCli.mockResolvedValueOnce({
      stdout: JSON.stringify({ status: 'pass', reasoning: 'ok', issues: [] }),
    });

    await runPreSubmitReview({
      task: 'Wire deploy step',
      diff: 'diff --git a/.github/workflows/deploy.yml',
      reviewerModel: 'sonnet',
      plannedSummary: 'Added GitHub Actions deploy step',
      plannedDeviations: [
        {
          step: 'Step 3',
          planned: 'Use existing AWS role',
          actual: 'Created a new role',
          reason: 'old role lacked S3:PutObject',
        },
      ],
    });

    const prompt = mockRunClaudeCli.mock.calls[0]?.[0].input ?? '';
    expect(prompt).toContain("AGENT'S PLANNED SUMMARY");
    expect(prompt).toContain('Added GitHub Actions deploy step');
    expect(prompt).toContain('AGENT-DISCLOSED DEVIATIONS');
    expect(prompt).toContain('Created a new role');
  });
});

describe('hashDiff', () => {
  it('produces stable hashes for identical diffs', () => {
    expect(hashDiff('foo bar baz')).toBe(hashDiff('foo bar baz'));
  });

  it('produces different hashes for different diffs', () => {
    expect(hashDiff('foo bar baz')).not.toBe(hashDiff('foo bar quux'));
  });

  it('handles the empty string', () => {
    expect(hashDiff('')).toBeTruthy();
  });
});

describe('pickCachedPreSubmit (Tier 1 cache hit logic)', () => {
  // Imported lazily so the runClaudeCli mock above doesn't pollute the
  // validation engine's import graph.
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import avoids hoist
  let pickCachedPreSubmit: any;
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import avoids hoist
  beforeEach(async () => {
    const mod = await import('./local-validation-engine.js');
    pickCachedPreSubmit = mod.pickCachedPreSubmit;
  });

  function makeConfig(diff: string, cache: unknown): Record<string, unknown> {
    return { diff, preSubmitReview: cache };
  }

  it('returns null when no cache is set', () => {
    expect(pickCachedPreSubmit(makeConfig('diff body', null))).toBeNull();
    expect(pickCachedPreSubmit(makeConfig('diff body', undefined))).toBeNull();
  });

  it('returns null when the cached status is not pass', () => {
    const cache = {
      status: 'fail',
      diffHash: hashDiff('diff body'),
      reasoning: 'oops',
      issues: ['x'],
      model: 'sonnet',
      checkedAt: new Date().toISOString(),
    };
    expect(pickCachedPreSubmit(makeConfig('diff body', cache))).toBeNull();
  });

  it('returns null when the cached hash does not match the current diff', () => {
    const cache = {
      status: 'pass',
      diffHash: hashDiff('OLD diff'),
      reasoning: 'looked good',
      issues: [],
      model: 'sonnet',
      checkedAt: new Date().toISOString(),
    };
    expect(pickCachedPreSubmit(makeConfig('NEW diff body', cache))).toBeNull();
  });

  it('returns the cached verdict when status=pass and the diff hash matches', () => {
    const diff = 'diff body unchanged';
    const cache = {
      status: 'pass',
      diffHash: hashDiff(diff),
      reasoning: 'matches scope, no logic issues',
      issues: [],
      model: 'sonnet',
      checkedAt: new Date().toISOString(),
    };
    const result = pickCachedPreSubmit(makeConfig(diff, cache));
    expect(result).not.toBeNull();
    expect(result.status).toBe('pass');
    expect(result.reasoning).toContain('matches scope');
  });
});
