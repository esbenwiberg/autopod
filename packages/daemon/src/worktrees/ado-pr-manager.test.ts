import pino from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdoPrManager, parseAdoRepoUrl } from './ado-pr-manager.js';

const logger = pino({ level: 'silent' });

const BASE_CONFIG = {
  orgUrl: 'https://dev.azure.com/myorg',
  project: 'MyProject',
  repoName: 'MyRepo',
  pat: 'secret',
  logger,
};

const PR_URL = 'https://dev.azure.com/myorg/MyProject/_git/MyRepo/pullrequest/42';

/** Build a minimal fetch mock that returns different bodies per call. */
function makeFetch(responses: Array<{ ok: boolean; body: unknown }>) {
  let callIndex = 0;
  return vi.fn().mockImplementation(async () => {
    const res = responses[callIndex] ?? { ok: true, body: null };
    callIndex++;
    return {
      ok: res.ok,
      status: res.ok ? 200 : 422,
      text: async () => (res.body !== null ? JSON.stringify(res.body) : ''),
    };
  });
}

describe('parseAdoRepoUrl', () => {
  it('parses dev.azure.com URL', () => {
    const result = parseAdoRepoUrl(
      'https://dev.azure.com/myorg/MyProject/_git/MyRepo',
    );
    expect(result).toEqual({
      orgUrl: 'https://dev.azure.com/myorg',
      project: 'MyProject',
      repoName: 'MyRepo',
    });
  });

  it('parses visualstudio.com URL', () => {
    const result = parseAdoRepoUrl(
      'https://myorg.visualstudio.com/MyProject/_git/MyRepo',
    );
    expect(result).toEqual({
      orgUrl: 'https://dev.azure.com/myorg',
      project: 'MyProject',
      repoName: 'MyRepo',
    });
  });
});

describe('AdoPrManager.getPrStatus', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns merged:true when PR is completed', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch([{ ok: true, body: { status: 'completed' } }]),
    );
    const manager = new AdoPrManager(BASE_CONFIG);
    const status = await manager.getPrStatus({ prUrl: PR_URL });
    expect(status).toEqual({
      merged: true,
      open: false,
      blockReason: null,
      ciFailures: [],
      reviewComments: [],
    });
  });

  it('returns open:false when PR is abandoned', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch([{ ok: true, body: { status: 'abandoned' } }]),
    );
    const manager = new AdoPrManager(BASE_CONFIG);
    const status = await manager.getPrStatus({ prUrl: PR_URL });
    expect(status.merged).toBe(false);
    expect(status.open).toBe(false);
    expect(status.blockReason).toBe('PR was abandoned');
  });

  it('does NOT report ciFailures when CI is in-progress (pending state)', async () => {
    // PR metadata, then statuses (SonarCloud pending, Build failed), then threads (empty)
    vi.stubGlobal(
      'fetch',
      makeFetch([
        { ok: true, body: { status: 'active', mergeStatus: 'notSet' } },
        {
          ok: true,
          body: {
            value: [
              { context: { name: 'SonarCloud' }, state: 'pending' },
              { context: { name: 'quality_gate' }, state: 'failed' },
            ],
          },
        },
        { ok: true, body: { value: [] } },
      ]),
    );

    const manager = new AdoPrManager(BASE_CONFIG);
    const status = await manager.getPrStatus({ prUrl: PR_URL });

    expect(status.ciFailures).toEqual([]);
    expect(status.blockReason).toContain('CI in progress');
    expect(status.blockReason).toContain('SonarCloud');
    // quality_gate failure is suppressed because CI is still running
    expect(status.blockReason).not.toContain('quality_gate');
  });

  it('does NOT report ciFailures when CI has notSet status (just started)', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch([
        { ok: true, body: { status: 'active', mergeStatus: 'notSet' } },
        {
          ok: true,
          body: {
            value: [{ context: { name: 'Build' }, state: 'notSet' }],
          },
        },
        { ok: true, body: { value: [] } },
      ]),
    );

    const manager = new AdoPrManager(BASE_CONFIG);
    const status = await manager.getPrStatus({ prUrl: PR_URL });

    expect(status.ciFailures).toEqual([]);
    expect(status.blockReason).toContain('CI in progress');
  });

  it('reports ciFailures when all checks are terminal and some failed', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch([
        { ok: true, body: { status: 'active', mergeStatus: 'notSet' } },
        {
          ok: true,
          body: {
            value: [
              { context: { name: 'SonarCloud' }, state: 'failed' },
              { context: { name: 'Build' }, state: 'succeeded' },
              { context: { name: 'Lint' }, state: 'error' },
            ],
          },
        },
        { ok: true, body: { value: [] } },
      ]),
    );

    const manager = new AdoPrManager(BASE_CONFIG);
    const status = await manager.getPrStatus({ prUrl: PR_URL });

    expect(status.ciFailures).toHaveLength(2);
    expect(status.ciFailures.map((f) => f.name)).toEqual(['SonarCloud', 'Lint']);
    expect(status.blockReason).toContain('SonarCloud');
    expect(status.blockReason).toContain('Lint');
  });

  it('reports reviewComments from active threads', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch([
        { ok: true, body: { status: 'active', mergeStatus: 'notSet' } },
        { ok: true, body: { value: [] } }, // no CI failures
        {
          ok: true,
          body: {
            value: [
              {
                status: 'active',
                isDeleted: false,
                pullRequestThreadContext: { filePath: 'src/foo.ts' },
                comments: [{ author: { displayName: 'Bob' }, content: 'Fix this' }],
              },
              {
                status: 'fixed', // resolved — should be ignored
                isDeleted: false,
                pullRequestThreadContext: null,
                comments: [{ author: { displayName: 'Alice' }, content: 'Old comment' }],
              },
            ],
          },
        },
      ]),
    );

    const manager = new AdoPrManager(BASE_CONFIG);
    const status = await manager.getPrStatus({ prUrl: PR_URL });

    expect(status.reviewComments).toHaveLength(1);
    expect(status.reviewComments[0]).toEqual({
      author: 'Bob',
      body: 'Fix this',
      path: 'src/foo.ts',
    });
  });

  it('skips deleted threads', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch([
        { ok: true, body: { status: 'active', mergeStatus: 'notSet' } },
        { ok: true, body: { value: [] } },
        {
          ok: true,
          body: {
            value: [
              {
                status: 'active',
                isDeleted: true, // deleted — must be skipped
                pullRequestThreadContext: null,
                comments: [{ author: { displayName: 'Bob' }, content: 'Deleted comment' }],
              },
            ],
          },
        },
      ]),
    );

    const manager = new AdoPrManager(BASE_CONFIG);
    const status = await manager.getPrStatus({ prUrl: PR_URL });

    expect(status.reviewComments).toEqual([]);
  });

  it('handles ADO integer status 1 (active) for threads', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch([
        { ok: true, body: { status: 'active', mergeStatus: 'notSet' } },
        { ok: true, body: { value: [] } },
        {
          ok: true,
          body: {
            value: [
              {
                status: 1, // integer 1 = active in some ADO API versions
                isDeleted: false,
                pullRequestThreadContext: null,
                comments: [{ author: { displayName: 'Eve' }, content: 'Needs refactor' }],
              },
            ],
          },
        },
      ]),
    );

    const manager = new AdoPrManager(BASE_CONFIG);
    const status = await manager.getPrStatus({ prUrl: PR_URL });

    expect(status.reviewComments).toHaveLength(1);
    expect(status.reviewComments[0]?.body).toBe('Needs refactor');
  });

  it('reports merge conflicts in blockReason', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch([
        { ok: true, body: { status: 'active', mergeStatus: 'conflicts' } },
        { ok: true, body: { value: [] } }, // no CI failures
        { ok: true, body: { value: [] } }, // no threads
      ]),
    );

    const manager = new AdoPrManager(BASE_CONFIG);
    const status = await manager.getPrStatus({ prUrl: PR_URL });

    expect(status.blockReason).toContain('Merge conflicts');
    expect(status.ciFailures).toEqual([]);
  });
});
