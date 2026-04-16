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
function makeFetch(responses: Array<{ ok: boolean; body: unknown; status?: number }>) {
  let callIndex = 0;
  return vi.fn().mockImplementation(async () => {
    const res = responses[callIndex] ?? { ok: true, body: null };
    callIndex++;
    return {
      ok: res.ok,
      status: res.status ?? (res.ok ? 200 : 422),
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

/** Minimal active PR body with repository.id for policy evaluations fetch. */
const ACTIVE_PR = { status: 'active', mergeStatus: 'notSet', repository: { id: 'repo-guid-123' } };

/** Policy evaluation entry builder. */
function policyEval(
  displayName: string,
  status: string,
  isBlocking: boolean,
): { policyEvaluationId: string; status: string; configuration: { isBlocking: boolean; settings: { displayName: string } } } {
  return {
    policyEvaluationId: `eval-${displayName}`,
    status,
    configuration: { isBlocking, settings: { displayName } },
  };
}

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

  it('does NOT report ciFailures when a required policy is still running', async () => {
    // A required policy is running — old failures on other checks are potentially stale.
    vi.stubGlobal(
      'fetch',
      makeFetch([
        { ok: true, body: ACTIVE_PR },
        {
          ok: true,
          body: {
            value: [
              policyEval('Build', 'running', true),
              policyEval('Quality Gate', 'rejected', true),
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
    expect(status.blockReason).toContain('Build');
    // quality gate failure is suppressed because CI is still running
    expect(status.blockReason).not.toContain('Quality Gate');
  });

  it('does NOT report ciFailures when a required policy is queued (just started)', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch([
        { ok: true, body: ACTIVE_PR },
        {
          ok: true,
          body: {
            value: [policyEval('Build', 'queued', true)],
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

  it('reports ciFailures from required policies when all required checks have settled', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch([
        { ok: true, body: ACTIVE_PR },
        {
          ok: true,
          body: {
            value: [
              policyEval('Unit Tests', 'rejected', true),
              policyEval('Build', 'approved', true),
              policyEval('Lint', 'broken', true),
            ],
          },
        },
        { ok: true, body: { value: [] } },
      ]),
    );

    const manager = new AdoPrManager(BASE_CONFIG);
    const status = await manager.getPrStatus({ prUrl: PR_URL });

    expect(status.ciFailures).toHaveLength(2);
    expect(status.ciFailures.map((f) => f.name)).toEqual(['Unit Tests', 'Lint']);
    expect(status.blockReason).toContain('Unit Tests');
    expect(status.blockReason).toContain('Lint');
  });

  it('does NOT suppress ciFailures when only optional policies are still queued', async () => {
    // This is the exact scenario from the bug: optional "AI Code Review" stays Queued
    // while required "teamplanner unit PR validation" has already rejected.
    vi.stubGlobal(
      'fetch',
      makeFetch([
        { ok: true, body: ACTIVE_PR },
        {
          ok: true,
          body: {
            value: [
              policyEval('teamplanner unit PR validation', 'rejected', true),
              policyEval('AI Code Review', 'queued', false),      // optional — must not block
              policyEval('Agent SDK Reviewer', 'queued', false),  // optional — must not block
            ],
          },
        },
        { ok: true, body: { value: [] } },
      ]),
    );

    const manager = new AdoPrManager(BASE_CONFIG);
    const status = await manager.getPrStatus({ prUrl: PR_URL });

    expect(status.ciFailures).toHaveLength(1);
    expect(status.ciFailures[0]?.name).toBe('teamplanner unit PR validation');
    expect(status.blockReason).toContain('teamplanner unit PR validation');
  });

  it('reports reviewComments from active threads', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch([
        { ok: true, body: ACTIVE_PR },
        { ok: true, body: { value: [] } }, // no policy failures
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
        { ok: true, body: ACTIVE_PR },
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
        { ok: true, body: ACTIVE_PR },
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

  it('silently continues when policy evaluations returns 404 (no branch policies)', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch([
        { ok: true, body: ACTIVE_PR },
        { ok: false, status: 404, body: { message: "Artifact id '...' does not exist or you do not have permission to view it." } },
        { ok: true, body: { value: [] } }, // threads
      ]),
    );

    const manager = new AdoPrManager(BASE_CONFIG);
    const status = await manager.getPrStatus({ prUrl: PR_URL });

    // 404 = no policies configured — should not block, no CI failures
    expect(status.ciFailures).toEqual([]);
    expect(status.blockReason).toBe('Waiting for policies to pass');
    expect(status.open).toBe(true);
    expect(status.merged).toBe(false);
  });

  it('reports merge conflicts in blockReason', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch([
        { ok: true, body: { ...ACTIVE_PR, mergeStatus: 'conflicts' } },
        { ok: true, body: { value: [] } }, // no policy failures
        { ok: true, body: { value: [] } }, // no threads
      ]),
    );

    const manager = new AdoPrManager(BASE_CONFIG);
    const status = await manager.getPrStatus({ prUrl: PR_URL });

    expect(status.blockReason).toContain('Merge conflicts');
    expect(status.ciFailures).toEqual([]);
  });

  it('uses the correct policy evaluations URL with repository id and PR id', async () => {
    const fetchMock = makeFetch([
      { ok: true, body: ACTIVE_PR },
      { ok: true, body: { value: [] } },
      { ok: true, body: { value: [] } },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const manager = new AdoPrManager(BASE_CONFIG);
    await manager.getPrStatus({ prUrl: PR_URL });

    // Second call must be the policy evaluations endpoint at project scope
    const calls = fetchMock.mock.calls as Array<[string, ...unknown[]]>;
    const policyUrl = calls[1]?.[0] ?? '';
    expect(policyUrl).toContain('/_apis/policy/evaluations');
    expect(policyUrl).toContain('repo-guid-123');
    expect(policyUrl).toContain('42'); // PR id
  });
});
