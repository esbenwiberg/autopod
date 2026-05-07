import pino from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScreenshotRef } from '@autopod/shared';
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

/** Minimal mock screenshot store. */
function makeMockStore(readBytes: Buffer = Buffer.from('fake-png')) {
  return {
    write: vi.fn(),
    read: vi.fn().mockResolvedValue(readBytes),
    list: vi.fn(),
    delete: vi.fn(),
  };
}

const MOCK_REF_1: ScreenshotRef = {
  podId: 'pod-test',
  source: 'smoke',
  filename: '0-root.png',
  relativePath: 'screenshots/pod-test/smoke/0-root.png',
};

const MOCK_REF_2: ScreenshotRef = {
  podId: 'pod-test',
  source: 'smoke',
  filename: '1-about.png',
  relativePath: 'screenshots/pod-test/smoke/1-about.png',
};

const RAW_SCREENSHOTS = [
  { pagePath: '/', ref: MOCK_REF_1 },
  { pagePath: '/about', ref: MOCK_REF_2 },
];

// Minimal CreatePrConfig used across createPr tests
const MINIMAL_CONFIG = {
  worktreePath: '/tmp/wt',
  branch: 'autopod/test',
  baseBranch: 'main',
  podId: 'pod-test',
  task: 'Test task',
  profileName: 'test-profile',
  // biome-ignore lint/suspicious/noExplicitAny: test stub
  profile: {} as any,
  podModel: 'sonnet',
  validationResult: null,
  filesChanged: 1,
  linesAdded: 10,
  linesRemoved: 5,
  previewUrl: null,
};

// Mock the LLM generator functions so createPr tests don't make real API calls
vi.mock('./pr-description-generator.js', () => ({
  generatePrTitle: vi.fn().mockResolvedValue({
    title: 'feat: test task',
    usedFallback: false,
  }),
  generatePrNarrative: vi.fn().mockResolvedValue({
    narrative: { why: 'Test why', what: 'Test what' },
    usedFallback: false,
  }),
}));

describe('parseAdoRepoUrl', () => {
  it('parses dev.azure.com URL', () => {
    const result = parseAdoRepoUrl('https://dev.azure.com/myorg/MyProject/_git/MyRepo');
    expect(result).toEqual({
      orgUrl: 'https://dev.azure.com/myorg',
      project: 'MyProject',
      repoName: 'MyRepo',
    });
  });

  it('parses visualstudio.com URL', () => {
    const result = parseAdoRepoUrl('https://myorg.visualstudio.com/MyProject/_git/MyRepo');
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
): {
  policyEvaluationId: string;
  status: string;
  configuration: { isBlocking: boolean; settings: { displayName: string } };
} {
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
    vi.stubGlobal('fetch', makeFetch([{ ok: true, body: { status: 'completed' } }]));
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
    vi.stubGlobal('fetch', makeFetch([{ ok: true, body: { status: 'abandoned' } }]));
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
              policyEval('AI Code Review', 'queued', false), // optional — must not block
              policyEval('Agent SDK Reviewer', 'queued', false), // optional — must not block
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
        {
          ok: false,
          status: 404,
          body: {
            message: "Artifact id '...' does not exist or you do not have permission to view it.",
          },
        },
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

describe('AdoPrManager.createPr — screenshot attachments', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('happy path: uploads two screenshots and patches PR body with attachment URLs', async () => {
    const fetchMock = makeFetch([
      { ok: true, body: { pullRequestId: 42, webUrl: PR_URL } }, // PR creation
      { ok: true, body: { url: 'https://dev.azure.com/myorg/42/1' } }, // upload smoke-0-root.png
      { ok: true, body: { url: 'https://dev.azure.com/myorg/42/2' } }, // upload smoke-1-about.png
      { ok: true, body: {} }, // PATCH description
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const store = makeMockStore();
    const manager = new AdoPrManager({ ...BASE_CONFIG, screenshotStore: store });

    const result = await manager.createPr({ ...MINIMAL_CONFIG, rawScreenshots: RAW_SCREENSHOTS });

    expect(result.url).toBe(PR_URL);
    // 4 calls: create + 2 uploads + patch
    expect(fetchMock).toHaveBeenCalledTimes(4);
    // store.read called once per screenshot
    expect(store.read).toHaveBeenCalledTimes(2);
    expect(store.read).toHaveBeenCalledWith(MOCK_REF_1);
    expect(store.read).toHaveBeenCalledWith(MOCK_REF_2);

    // PATCH body must contain both attachment URLs
    const patchCall = (fetchMock.mock.calls as Array<[string, { body?: string }]>)[3];
    const patchBody = JSON.parse(patchCall?.[1]?.body ?? '{}') as { description: string };
    expect(patchBody.description).toContain('https://dev.azure.com/myorg/42/1');
    expect(patchBody.description).toContain('https://dev.azure.com/myorg/42/2');
  });

  it('two-pass order: PR creation is the first API call; attachment uploads come after', async () => {
    const fetchMock = makeFetch([
      { ok: true, body: { pullRequestId: 42, webUrl: PR_URL } },
      { ok: true, body: { url: 'https://dev.azure.com/myorg/42/1' } },
      { ok: true, body: {} },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const store = makeMockStore();
    const manager = new AdoPrManager({ ...BASE_CONFIG, screenshotStore: store });

    await manager.createPr({
      ...MINIMAL_CONFIG,
      rawScreenshots: [{ pagePath: '/', ref: MOCK_REF_1 }],
    });

    const calls = fetchMock.mock.calls as Array<[string, { method: string }]>;
    // First call creates the PR
    expect(calls[0]?.[0]).toContain('/pullrequests?');
    expect(calls[0]?.[1]?.method).toBe('POST');
    // Second call uploads the attachment (requires the PR ID from the first call)
    expect(calls[1]?.[0]).toContain('/pullRequests/42/attachments/');
    expect(calls[1]?.[1]?.method).toBe('POST');
  });

  it('upload failure: PR is still created; failed screenshot is omitted from body; no throw', async () => {
    const warnSpy = vi.spyOn(logger, 'warn');
    const fetchMock = makeFetch([
      { ok: true, body: { pullRequestId: 42, webUrl: PR_URL } }, // PR creation
      { ok: false, status: 500, body: { message: 'Internal error' } }, // first upload fails
      { ok: true, body: { url: 'https://dev.azure.com/myorg/42/2' } }, // second upload succeeds
      { ok: true, body: {} }, // PATCH with only the successful URL
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const store = makeMockStore();
    const manager = new AdoPrManager({ ...BASE_CONFIG, screenshotStore: store });

    await expect(
      manager.createPr({ ...MINIMAL_CONFIG, rawScreenshots: RAW_SCREENSHOTS }),
    ).resolves.not.toThrow();

    // PR was created (first fetch call happened)
    expect(fetchMock.mock.calls[0]?.[0]).toContain('/pullrequests?');

    // Warning was logged for the failed upload
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ pagePath: '/' }),
      expect.stringContaining('ADO screenshot attachment upload failed'),
    );

    // PATCH still happened with the successful screenshot's URL
    const patchCall = (fetchMock.mock.calls as Array<[string, { body?: string }]>)[3];
    const patchBody = JSON.parse(patchCall?.[1]?.body ?? '{}') as { description: string };
    expect(patchBody.description).toContain('https://dev.azure.com/myorg/42/2');
    expect(patchBody.description).not.toContain('42/1'); // failed upload not present
  });

  it('auth: attachment upload POST carries the same Authorization header as PR creation', async () => {
    const fetchMock = makeFetch([
      { ok: true, body: { pullRequestId: 42, webUrl: PR_URL } },
      { ok: true, body: { url: 'https://dev.azure.com/myorg/42/1' } },
      { ok: true, body: {} },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const store = makeMockStore();
    const manager = new AdoPrManager({ ...BASE_CONFIG, screenshotStore: store });

    await manager.createPr({
      ...MINIMAL_CONFIG,
      rawScreenshots: [{ pagePath: '/', ref: MOCK_REF_1 }],
    });

    const expectedAuth = `Basic ${Buffer.from(':secret').toString('base64')}`;
    const calls = fetchMock.mock.calls as Array<[string, { headers?: Record<string, string> }]>;
    // All calls (create, upload, patch) must carry the same auth header
    for (const [, opts] of calls) {
      expect(opts?.headers?.Authorization).toBe(expectedAuth);
    }
  });

  it('attachment filename uses source prefix to avoid bucket collisions', async () => {
    const fetchMock = makeFetch([
      { ok: true, body: { pullRequestId: 42, webUrl: PR_URL } },
      { ok: true, body: { url: 'https://dev.azure.com/myorg/42/1' } },
      { ok: true, body: {} },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const store = makeMockStore();
    const manager = new AdoPrManager({ ...BASE_CONFIG, screenshotStore: store });

    await manager.createPr({
      ...MINIMAL_CONFIG,
      rawScreenshots: [{ pagePath: '/', ref: MOCK_REF_1 }],
    });

    // Attachment URL must contain `smoke-0-root.png` (source prefix + original filename)
    const uploadCall = (fetchMock.mock.calls as Array<[string, unknown]>)[1];
    expect(uploadCall?.[0]).toContain('smoke-0-root.png');
  });

  it('no-screenshot pod: zero attachment calls; PR body has no screenshots section', async () => {
    const fetchMock = makeFetch([
      { ok: true, body: { pullRequestId: 42, webUrl: PR_URL } }, // only PR creation
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const manager = new AdoPrManager(BASE_CONFIG); // no screenshotStore
    await manager.createPr(MINIMAL_CONFIG); // no rawScreenshots

    // Only the PR creation call fired; no uploads, no PATCH
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('no-screenshot pod with store: empty rawScreenshots skips all attachment logic', async () => {
    const fetchMock = makeFetch([
      { ok: true, body: { pullRequestId: 42, webUrl: PR_URL } },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const store = makeMockStore();
    const manager = new AdoPrManager({ ...BASE_CONFIG, screenshotStore: store });
    await manager.createPr({ ...MINIMAL_CONFIG, rawScreenshots: [] });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.read).not.toHaveBeenCalled();
  });
});
