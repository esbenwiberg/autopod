import type { ActionDefinition, Pod, Profile } from '@autopod/shared';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock execFile BEFORE importing the handler so the promisify call picks it up.
const mockExecFile = vi.fn(
  (
    _cmd: string,
    _args: string[],
    _opts: unknown,
    cb: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    cb(null, '', '');
  },
);
vi.mock('node:child_process', () => ({ execFile: mockExecFile }));

const { createTestPipelineHandler, injectPatIntoAdoUrl } = await import(
  './test-pipeline-handler.js'
);

const logger = pino({ level: 'silent' });

function makePodRepo(pod: Partial<Pod> = {}) {
  return {
    getOrThrow: vi.fn(() => ({
      id: 'pod-1',
      profileName: 'test-profile',
      branch: 'feat/my-branch',
      worktreePath: '/tmp/autopod/pod-1',
      testRunBranches: null,
      ...pod,
    })) as unknown as (id: string) => Pod,
    update: vi.fn(),
  } as unknown as import('../../pods/pod-repository.js').PodRepository & {
    getOrThrow: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
}

function makeProfileStore(profile: Partial<Profile> = {}) {
  return {
    get: vi.fn(() => ({
      name: 'test-profile',
      adoPat: 'fake-pat',
      testPipeline: {
        enabled: true,
        testRepo: 'https://dev.azure.com/myorg/myproject/_git/test-repo',
        testPipelineId: 42,
      },
      ...profile,
    })) as unknown as (name: string) => Profile,
  } as unknown as import('../../profiles/index.js').ProfileStore & {
    get: ReturnType<typeof vi.fn>;
  };
}

const runAction: ActionDefinition = {
  name: 'ado_run_test_pipeline',
  description: '',
  group: 'ado-test-pipeline',
  handler: 'test-pipeline',
  params: {},
  response: { fields: ['runId', 'url', 'testBranch'] },
};

const statusAction: ActionDefinition = {
  name: 'ado_get_test_run_status',
  description: '',
  group: 'ado-test-pipeline',
  handler: 'test-pipeline',
  params: {},
  response: { fields: ['status', 'url'] },
};

describe('injectPatIntoAdoUrl', () => {
  it('embeds the PAT as x-access-token:PAT in an ADO repo URL', () => {
    const out = injectPatIntoAdoUrl(
      'https://dev.azure.com/myorg/myproject/_git/test-repo',
      'SUPERSECRET',
    );
    expect(out).toBe(
      'https://x-access-token:SUPERSECRET@dev.azure.com/myorg/myproject/_git/test-repo',
    );
  });
});

describe('test-pipeline handler', () => {
  beforeEach(() => {
    mockExecFile.mockClear();
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects when the profile has no testPipeline enabled', async () => {
    const handler = createTestPipelineHandler({
      logger,
      podRepo: makePodRepo(),
      profileStore: makeProfileStore({ testPipeline: null }),
    });
    await expect(handler.execute(runAction, {}, { podId: 'pod-1' })).rejects.toThrow(
      /testPipeline/,
    );
  });

  it('rejects when the profile has no adoPat', async () => {
    const handler = createTestPipelineHandler({
      logger,
      podRepo: makePodRepo(),
      profileStore: makeProfileStore({ adoPat: null }),
    });
    await expect(handler.execute(runAction, {}, { podId: 'pod-1' })).rejects.toThrow(/adoPat/);
  });

  it('rejects when podId context is missing', async () => {
    const handler = createTestPipelineHandler({
      logger,
      podRepo: makePodRepo(),
      profileStore: makeProfileStore(),
    });
    await expect(handler.execute(runAction, {})).rejects.toThrow(/pod context/);
  });

  it('enforces per-pod rate limit', async () => {
    const rateLimitState = new Map<string, number[]>();
    // Pre-seed 10 recent triggers → 11th call must be blocked.
    rateLimitState.set(
      'pod-1',
      Array.from({ length: 10 }, () => Date.now()),
    );
    const handler = createTestPipelineHandler({
      logger,
      podRepo: makePodRepo(),
      profileStore: makeProfileStore(),
      rateLimitState,
    });
    await expect(handler.execute(runAction, {}, { podId: 'pod-1' })).rejects.toThrow(/Rate limit/);
  });

  it('pushes the branch, triggers the pipeline, and returns runId + url + testBranch', async () => {
    const podRepo = makePodRepo();
    const handler = createTestPipelineHandler({
      logger,
      podRepo,
      profileStore: makeProfileStore(),
    });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      headers: new Map(),
      text: async () =>
        JSON.stringify({ id: 555, _links: { web: { href: 'https://dev.azure.com/run/555' } } }),
    });

    const out = (await handler.execute(runAction, {}, { podId: 'pod-1' })) as {
      runId: number;
      url: string;
      testBranch: string;
    };

    expect(out.runId).toBe(555);
    expect(out.url).toBe('https://dev.azure.com/run/555');
    expect(out.testBranch).toMatch(/^test-runs\/pod-1\/\d+$/);

    // git push was invoked with x-access-token-authenticated URL
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const args = mockExecFile.mock.calls[0]?.[1] as string[];
    expect(args[0]).toBe('-C');
    expect(args[1]).toBe('/tmp/autopod/pod-1');
    expect(args[2]).toBe('push');
    expect(args[3]).toBe('--force');
    expect(args[4]).toContain('x-access-token:fake-pat@dev.azure.com');
    // testBranch is recorded on the pod for cleanup later
    expect(podRepo.update).toHaveBeenCalledWith(
      'pod-1',
      expect.objectContaining({
        testRunBranches: expect.arrayContaining([expect.stringMatching(/^test-runs\//)]),
      }),
    );
  });

  it('get_test_run_status returns succeeded with duration when run completes', async () => {
    const handler = createTestPipelineHandler({
      logger,
      podRepo: makePodRepo(),
      profileStore: makeProfileStore(),
    });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      headers: new Map(),
      text: async () =>
        JSON.stringify({
          id: 555,
          state: 'completed',
          result: 'succeeded',
          createdDate: '2026-01-01T10:00:00Z',
          finishedDate: '2026-01-01T10:02:30Z',
          _links: { web: { href: 'https://dev.azure.com/run/555' } },
        }),
    });
    const out = (await handler.execute(statusAction, { run_id: 555 }, { podId: 'pod-1' })) as {
      status: string;
      durationSeconds?: number;
    };
    expect(out.status).toBe('succeeded');
    expect(out.durationSeconds).toBe(150);
  });
});
