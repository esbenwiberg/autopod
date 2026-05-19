import type { PodBridge } from '@autopod/escalation-mcp';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, insertTestProfile, logger } from '../test-utils/mock-helpers.js';
import { type SessionBridgeDependencies, createSessionBridge } from './pod-bridge-impl.js';

vi.mock('../validation/pre-submit-review.js', async () => {
  const actual = await vi.importActual<typeof import('../validation/pre-submit-review.js')>(
    '../validation/pre-submit-review.js',
  );
  return { ...actual, runPreSubmitReview: vi.fn() };
});

import { runPreSubmitReview } from '../validation/pre-submit-review.js';

const mockRunPreSubmitReview = vi.mocked(runPreSubmitReview);

type Deps = SessionBridgeDependencies;

interface BuildOpts {
  profileOverrides?: Parameters<typeof insertTestProfile>[1];
  execImpl?: (
    containerId: string,
    command: string[],
    options?: { cwd?: string; timeout?: number; env?: Record<string, string> },
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

function buildBridge(opts: BuildOpts = {}): {
  bridge: PodBridge;
  execMock: ReturnType<typeof vi.fn>;
  podId: string;
} {
  const db = createTestDb();
  const podId = 'sess-1';
  insertTestProfile(db, { name: 'proj', ...opts.profileOverrides });

  db.prepare(
    `INSERT INTO pods (id, profile_name, task, model, branch, user_id, container_id)
     VALUES (@id, 'proj', 't', 'opus', 'main', 'u', @containerId)`,
  ).run({ id: podId, containerId: 'container-abc' });

  const execMock = vi
    .fn()
    .mockImplementation(opts.execImpl ?? (async () => ({ stdout: 'ok', stderr: '', exitCode: 0 })));

  const profileStore = {
    get: vi.fn().mockReturnValue({
      name: 'proj',
      buildCommand: 'npm run build',
      lintCommand: null,
      testCommand: null,
      buildWorkDir: null,
      buildEnv: null,
      buildTimeout: null,
      testTimeout: null,
      lintTimeout: null,
      privateRegistries: [],
      registryPat: null,
      adoPat: null,
      ...(opts.profileOverrides ?? {}),
    }),
  } as unknown as Deps['profileStore'];

  const podManager = {
    getSession: vi.fn(() => ({
      id: podId,
      profileName: 'proj',
      containerId: 'container-abc',
      executionTarget: 'local',
    })),
    touchHeartbeat: vi.fn(),
  } as unknown as Deps['podManager'];

  const eventBus = { emit: vi.fn(), subscribe: vi.fn() } as unknown as Deps['eventBus'];
  const cm = { execInContainer: execMock };
  const containerManagerFactory = {
    get: vi.fn().mockReturnValue(cm),
  } as unknown as Deps['containerManagerFactory'];

  const stub = {} as never;
  const bridge = createSessionBridge({
    podManager,
    podRepo: stub,
    eventBus,
    escalationRepo: stub,
    nudgeRepo: stub,
    profileStore,
    containerManagerFactory,
    pendingRequestsByPod: new Map(),
    logger,
  });

  return { bridge, execMock, podId };
}

describe('PodBridge.runValidationPhase', () => {
  it('returns configured=false when the profile has no command for the phase', async () => {
    const { bridge, execMock, podId } = buildBridge({
      profileOverrides: { lintCommand: null },
    });

    const result = await bridge.runValidationPhase(podId, 'lint');

    expect(result.configured).toBe(false);
    expect(result.passed).toBe(false);
    expect(result.command).toBeNull();
    expect(execMock).not.toHaveBeenCalled();
  });

  it('runs the configured command and reports passed=true on exit 0', async () => {
    const { bridge, execMock, podId } = buildBridge({
      profileOverrides: { buildCommand: 'npm run build' },
      execImpl: async () => ({ stdout: 'built ok', stderr: '', exitCode: 0 }),
    });

    const result = await bridge.runValidationPhase(podId, 'build');

    expect(result.configured).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.command).toBe('npm run build');
    expect(execMock).toHaveBeenCalledWith(
      'container-abc',
      ['sh', '-c', 'npm run build'],
      expect.objectContaining({ cwd: '/workspace', timeout: 300_000 }),
    );
  });

  it('reports passed=false with output on a non-zero exit', async () => {
    const { bridge, podId } = buildBridge({
      profileOverrides: { testCommand: 'npm test' },
      execImpl: async () => ({
        stdout: '',
        stderr: 'AssertionError: expected 1 to equal 2',
        exitCode: 1,
      }),
    });

    const result = await bridge.runValidationPhase(podId, 'tests');

    expect(result.passed).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('AssertionError');
  });

  it('uses /workspace/<buildWorkDir> as cwd when set', async () => {
    const { bridge, execMock, podId } = buildBridge({
      profileOverrides: { buildCommand: 'npm run build', buildWorkDir: 'apps/web' },
    });

    await bridge.runValidationPhase(podId, 'build');

    expect(execMock).toHaveBeenCalledWith(
      'container-abc',
      expect.any(Array),
      expect.objectContaining({ cwd: '/workspace/apps/web' }),
    );
  });

  it('applies profile timeouts (in seconds → ms) per phase', async () => {
    const { bridge, execMock, podId } = buildBridge({
      profileOverrides: {
        lintCommand: 'biome check .',
        lintTimeout: 30,
        buildCommand: 'npm run build',
        buildTimeout: 90,
        testCommand: 'npm test',
        testTimeout: 45,
      },
    });

    await bridge.runValidationPhase(podId, 'lint');
    await bridge.runValidationPhase(podId, 'build');
    await bridge.runValidationPhase(podId, 'tests');

    const timeouts = execMock.mock.calls.map((c) => (c[2] as { timeout?: number }).timeout);
    expect(timeouts).toEqual([30_000, 90_000, 45_000]);
  });

  it('passes profile.buildEnv into the exec call', async () => {
    const { bridge, execMock, podId } = buildBridge({
      profileOverrides: {
        buildCommand: 'npm run build',
        buildEnv: { NODE_OPTIONS: '--max-old-space-size=4096' },
      },
    });

    await bridge.runValidationPhase(podId, 'build');

    const opts = execMock.mock.calls[0]?.[2] as { env?: Record<string, string> };
    expect(opts.env?.NODE_OPTIONS).toBe('--max-old-space-size=4096');
  });

  it('truncates the middle of large outputs but keeps the tail (where failures live)', async () => {
    const tail = 'FAIL test/foo.test.ts > foo > bar\n  expected 1 to equal 2';
    const huge = `${'x'.repeat(20_000)}\n${tail}`;
    const { bridge, podId } = buildBridge({
      profileOverrides: { testCommand: 'npm test' },
      execImpl: async () => ({ stdout: huge, stderr: '', exitCode: 1 }),
    });

    const result = await bridge.runValidationPhase(podId, 'tests');

    expect(result.output.length).toBeLessThan(7_000);
    expect(result.output).toContain('truncated');
    expect(result.output).toContain(tail);
  });

  it('throws when the pod has no container', async () => {
    const db = createTestDb();
    insertTestProfile(db, { name: 'proj' });
    db.prepare(
      `INSERT INTO pods (id, profile_name, task, model, branch, user_id)
       VALUES ('sess-z', 'proj', 't', 'opus', 'main', 'u')`,
    ).run();

    const podManager = {
      getSession: vi.fn(() => ({
        id: 'sess-z',
        profileName: 'proj',
        containerId: null,
        executionTarget: 'local',
      })),
      touchHeartbeat: vi.fn(),
    } as unknown as Deps['podManager'];

    const stub = {} as never;
    const bridge = createSessionBridge({
      podManager,
      podRepo: stub,
      eventBus: { emit: vi.fn(), subscribe: vi.fn() } as unknown as Deps['eventBus'],
      escalationRepo: stub,
      nudgeRepo: stub,
      profileStore: {
        get: vi.fn().mockReturnValue({
          buildCommand: 'npm run build',
          privateRegistries: [],
          registryPat: null,
          adoPat: null,
          buildEnv: null,
        }),
      } as unknown as Deps['profileStore'],
      containerManagerFactory: {
        get: vi.fn().mockReturnValue({ execInContainer: vi.fn() }),
      } as unknown as Deps['containerManagerFactory'],
      pendingRequestsByPod: new Map(),
      logger,
    });

    await expect(bridge.runValidationPhase('sess-z', 'build')).rejects.toThrow(/no container/);
  });
});

describe('PodBridge.runPreSubmitReview', () => {
  beforeEach(() => {
    mockRunPreSubmitReview.mockReset();
  });

  /** Sample diff used to verify the bridge wires the container/worktree output through. */
  const SAMPLE_DIFF =
    'diff --git a/src/foo.ts b/src/foo.ts\n' +
    '--- a/src/foo.ts\n' +
    '+++ b/src/foo.ts\n' +
    '@@ -1 +1,2 @@\n' +
    ' line1\n' +
    '+added\n';

  interface BuildOpts {
    /** Diff returned by the in-container `git diff`. Used when containerId is set. */
    containerDiff?: string;
    /** Diff returned by the host worktree fallback. */
    worktreeDiff?: string;
    /** Pre-existing pre-submit verdict on the pod (for cache-hit tests). */
    cachedVerdict?: {
      status: 'pass' | 'fail' | 'uncertain' | 'skipped';
      diffHash: string;
      diffSource?: 'container' | 'worktree' | 'none';
      filesReviewed?: number;
      linesAdded?: number;
      linesRemoved?: number;
      containerId?: string | null;
      worktreePath?: string | null;
      startCommitSha?: string | null;
      reasoning: string;
      issues: string[];
      model: string;
      checkedAt: string;
    };
    /** Container id on the pod. Set null to force the host worktree fallback. */
    containerId?: string | null;
    runResult: Awaited<ReturnType<typeof runPreSubmitReview>>;
  }

  function buildBridgeWithWorktree(opts: BuildOpts): {
    bridge: PodBridge;
    podId: string;
    podRepo: ReturnType<typeof createTestDb>['prepare'];
    containerExecMock: ReturnType<typeof vi.fn>;
    worktreeGetDiffMock: ReturnType<typeof vi.fn>;
  } {
    const db = createTestDb();
    const podId = 'pre-1';
    insertTestProfile(db, { name: 'proj', defaultBranch: 'main', reviewerModel: 'sonnet' });

    const containerId = opts.containerId === undefined ? 'container-abc' : opts.containerId;
    db.prepare(
      `INSERT INTO pods (id, profile_name, task, model, branch, user_id, container_id, worktree_path)
       VALUES (@id, 'proj', 'Add a feature', 'opus', 'main', 'u', @containerId, '/tmp/worktree')`,
    ).run({ id: podId, containerId });

    mockRunPreSubmitReview.mockResolvedValue(opts.runResult);

    const podManager = {
      getSession: vi.fn(() => ({
        id: podId,
        profileName: 'proj',
        task: 'Add a feature',
        worktreePath: '/tmp/worktree',
        startCommitSha: 'start-sha',
        containerId,
        executionTarget: 'local',
        preSubmitReview: opts.cachedVerdict ?? null,
      })),
      touchHeartbeat: vi.fn(),
    } as unknown as Deps['podManager'];

    const profileStore = {
      get: vi.fn().mockReturnValue({
        name: 'proj',
        reviewerModel: 'sonnet',
        defaultModel: 'opus',
        defaultBranch: 'main',
      }),
    } as unknown as Deps['profileStore'];

    const worktreeGetDiffMock = vi.fn().mockResolvedValue(opts.worktreeDiff ?? '');
    const worktreeManager = {
      getDiff: worktreeGetDiffMock,
    } as unknown as Deps['worktreeManager'];

    const containerExecMock = vi.fn().mockImplementation(async (_id: string, cmd: string[]) => {
      if (cmd[0] === 'git' && cmd[1] === 'diff') {
        if (opts.containerDiff === undefined) {
          // Force the bridge to fall back to the host worktree.
          return { stdout: '', stderr: 'no container diff', exitCode: 1 };
        }
        return { stdout: opts.containerDiff, stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const podRepo = {
      update: vi.fn(),
    } as unknown as Deps['podRepo'];

    const stub = {} as never;
    const bridge = createSessionBridge({
      podManager,
      podRepo,
      eventBus: { emit: vi.fn(), subscribe: vi.fn() } as unknown as Deps['eventBus'],
      escalationRepo: stub,
      nudgeRepo: stub,
      profileStore,
      containerManagerFactory: {
        get: vi.fn().mockReturnValue({ execInContainer: containerExecMock }),
      } as unknown as Deps['containerManagerFactory'],
      pendingRequestsByPod: new Map(),
      logger,
      worktreeManager,
    });

    return {
      bridge,
      podId,
      podRepo: podRepo as never,
      containerExecMock,
      worktreeGetDiffMock,
    };
  }

  it('reads the diff from inside the container when one is running', async () => {
    const { bridge, podId, containerExecMock, worktreeGetDiffMock } = buildBridgeWithWorktree({
      containerDiff: SAMPLE_DIFF,
      runResult: {
        status: 'pass',
        reasoning: 'looks good',
        issues: [],
        model: 'sonnet',
        diffHash: 'abc',
        durationMs: 42,
      },
    });

    const result = await bridge.runPreSubmitReview(podId, {});

    expect(result.status).toBe('pass');
    // The reviewer was given the container diff, not an empty/stale worktree diff.
    expect(mockRunPreSubmitReview).toHaveBeenCalledWith(
      expect.objectContaining({
        diff: expect.stringContaining('+added'),
      }),
      expect.anything(),
    );
    // In-container exec was invoked.
    const gitDiffCalls = containerExecMock.mock.calls.filter(
      (c: unknown[]) => Array.isArray(c[1]) && (c[1] as string[])[1] === 'diff',
    );
    expect(gitDiffCalls.length).toBeGreaterThan(0);
    // Host worktree was not used as fallback because the container path succeeded.
    expect(worktreeGetDiffMock).not.toHaveBeenCalled();
  });

  it('falls back to the host worktree when the in-container diff fails', async () => {
    const { bridge, podId, worktreeGetDiffMock } = buildBridgeWithWorktree({
      // containerDiff is undefined → exec returns exitCode=1, fetcher falls back.
      worktreeDiff: SAMPLE_DIFF,
      runResult: {
        status: 'pass',
        reasoning: 'looks good',
        issues: [],
        model: 'sonnet',
        diffHash: 'abc',
        durationMs: 42,
      },
    });

    await bridge.runPreSubmitReview(podId, {});

    expect(worktreeGetDiffMock).toHaveBeenCalledWith(
      '/tmp/worktree',
      'main',
      expect.any(Number),
      'start-sha',
    );
    expect(mockRunPreSubmitReview).toHaveBeenCalledWith(
      expect.objectContaining({ diff: expect.stringContaining('+added') }),
      expect.anything(),
    );
  });

  it('echoes scope (filesReviewed / linesAdded / linesRemoved) in the response', async () => {
    const { bridge, podId } = buildBridgeWithWorktree({
      containerDiff: SAMPLE_DIFF,
      runResult: {
        status: 'pass',
        reasoning: 'ok',
        issues: [],
        model: 'sonnet',
        diffHash: 'h',
        durationMs: 1,
      },
    });

    const result = await bridge.runPreSubmitReview(podId, {});

    expect(result.filesReviewed).toBe(1);
    expect(result.linesAdded).toBe(1);
    expect(result.linesRemoved).toBe(0);
  });

  it('returns the cached verdict without re-running the reviewer when the diff hash matches', async () => {
    // Compute the hash the bridge will derive from the diff so the cache key
    // matches. Use the same hashing the bridge uses (sha256 / first 16 hex chars).
    const { hashDiff } = await import('../validation/pre-submit-review.js');
    const finalizedDiff = SAMPLE_DIFF; // No mode-only sections to strip.
    const expectedHash = hashDiff(finalizedDiff);

    const { bridge, podId, podRepo } = buildBridgeWithWorktree({
      containerDiff: SAMPLE_DIFF,
      cachedVerdict: {
        status: 'fail',
        diffHash: expectedHash,
        diffSource: 'container',
        filesReviewed: 1,
        linesAdded: 1,
        linesRemoved: 0,
        containerId: 'container-abc',
        worktreePath: '/tmp/worktree',
        startCommitSha: 'start-sha',
        reasoning: 'cached: missing tests',
        issues: ['src/foo.ts:1: needs a test'],
        model: 'sonnet',
        checkedAt: '2025-01-01T00:00:00.000Z',
      },
      runResult: {
        // This must NOT be returned — the cache hit short-circuits.
        status: 'pass',
        reasoning: 'should not be visible',
        issues: [],
        model: 'sonnet',
        diffHash: 'fresh',
        durationMs: 1,
      },
    });

    const result = await bridge.runPreSubmitReview(podId, {});

    expect(result.reusedCache).toBe(true);
    expect(result.status).toBe('fail');
    expect(result.reasoning).toBe('cached: missing tests');
    expect(result.issues).toEqual(['src/foo.ts:1: needs a test']);
    expect(result.cachedMetadata).toEqual(
      expect.objectContaining({
        diffSource: 'container',
        filesReviewed: 1,
        linesAdded: 1,
        linesRemoved: 0,
        startCommitSha: 'start-sha',
      }),
    );
    expect(mockRunPreSubmitReview).not.toHaveBeenCalled();
    // Cache is not re-written when we just returned from it.
    const update = (podRepo as unknown as { update: ReturnType<typeof vi.fn> }).update;
    expect(update).not.toHaveBeenCalled();
  });

  it('ignores a cached verdict when the diff metadata does not match', async () => {
    const { hashDiff } = await import('../validation/pre-submit-review.js');
    const expectedHash = hashDiff(SAMPLE_DIFF);

    const { bridge, podId } = buildBridgeWithWorktree({
      containerDiff: SAMPLE_DIFF,
      cachedVerdict: {
        status: 'pass',
        diffHash: expectedHash,
        diffSource: 'worktree',
        filesReviewed: 99,
        linesAdded: 99,
        linesRemoved: 0,
        containerId: 'old-container',
        worktreePath: '/tmp/worktree',
        startCommitSha: 'start-sha',
        reasoning: 'stale pass',
        issues: [],
        model: 'sonnet',
        checkedAt: '2025-01-01T00:00:00.000Z',
      },
      runResult: {
        status: 'fail',
        reasoning: 'fresh failure',
        issues: ['src/foo.ts:1: still broken'],
        model: 'sonnet',
        diffHash: 'fresh',
        durationMs: 1,
      },
    });

    const result = await bridge.runPreSubmitReview(podId, {});

    expect(result.reusedCache).toBeUndefined();
    expect(result.status).toBe('fail');
    expect(result.reasoning).toBe('fresh failure');
    expect(mockRunPreSubmitReview).toHaveBeenCalledTimes(1);
  });

  it('caches the verdict on the pod via podRepo.update on a fresh review', async () => {
    const { bridge, podId, podRepo } = buildBridgeWithWorktree({
      containerDiff: SAMPLE_DIFF,
      runResult: {
        status: 'pass',
        reasoning: 'all good',
        issues: [],
        model: 'sonnet',
        diffHash: 'cached-hash',
        durationMs: 17,
      },
    });

    await bridge.runPreSubmitReview(podId, {});

    const update = (podRepo as unknown as { update: ReturnType<typeof vi.fn> }).update;
    expect(update).toHaveBeenCalledWith(
      podId,
      expect.objectContaining({
        preSubmitReview: expect.objectContaining({
          status: 'pass',
          diffHash: 'cached-hash',
          diffSource: 'container',
          filesReviewed: 1,
          linesAdded: 1,
          linesRemoved: 0,
          containerId: 'container-abc',
          worktreePath: '/tmp/worktree',
          startCommitSha: 'start-sha',
          reasoning: 'all good',
          model: 'sonnet',
        }),
      }),
    );
  });

  it('passes plannedSummary and plannedDeviations through', async () => {
    const { bridge, podId } = buildBridgeWithWorktree({
      containerDiff: SAMPLE_DIFF,
      runResult: {
        status: 'pass',
        reasoning: 'ok',
        issues: [],
        model: 'sonnet',
        diffHash: 'h',
        durationMs: 1,
      },
    });

    await bridge.runPreSubmitReview(podId, {
      plannedSummary: 'hello',
      plannedDeviations: [{ step: 'Step 1', planned: 'A', actual: 'B', reason: 'because' }],
    });

    expect(mockRunPreSubmitReview).toHaveBeenCalledWith(
      expect.objectContaining({
        plannedSummary: 'hello',
        plannedDeviations: [{ step: 'Step 1', planned: 'A', actual: 'B', reason: 'because' }],
      }),
      expect.anything(),
    );
  });
});
