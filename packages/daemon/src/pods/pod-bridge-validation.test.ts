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

  function buildBridgeWithWorktree(opts: {
    diff: string;
    runResult: Awaited<ReturnType<typeof runPreSubmitReview>>;
  }): { bridge: PodBridge; podId: string; podRepo: ReturnType<typeof createTestDb>['prepare'] } {
    const db = createTestDb();
    const podId = 'pre-1';
    insertTestProfile(db, { name: 'proj', defaultBranch: 'main', reviewerModel: 'sonnet' });

    db.prepare(
      `INSERT INTO pods (id, profile_name, task, model, branch, user_id, container_id, worktree_path)
       VALUES (@id, 'proj', 'Add a feature', 'opus', 'main', 'u', 'container-abc', '/tmp/worktree')`,
    ).run({ id: podId });

    mockRunPreSubmitReview.mockResolvedValue(opts.runResult);

    const podManager = {
      getSession: vi.fn(() => ({
        id: podId,
        profileName: 'proj',
        task: 'Add a feature',
        worktreePath: '/tmp/worktree',
        startCommitSha: null,
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

    const worktreeManager = {
      getDiff: vi.fn().mockResolvedValue(opts.diff),
    } as unknown as Deps['worktreeManager'];

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
        get: vi.fn().mockReturnValue({ execInContainer: vi.fn() }),
      } as unknown as Deps['containerManagerFactory'],
      pendingRequestsByPod: new Map(),
      logger,
      worktreeManager,
    });

    return { bridge, podId, podRepo: podRepo as never };
  }

  it('forwards the diff and reviewer model to runPreSubmitReview', async () => {
    const { bridge, podId } = buildBridgeWithWorktree({
      diff: 'diff --git a/foo b/foo\n+hello',
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
    expect(result.issues).toEqual([]);
    expect(mockRunPreSubmitReview).toHaveBeenCalledWith(
      expect.objectContaining({
        task: 'Add a feature',
        diff: 'diff --git a/foo b/foo\n+hello',
        reviewerModel: 'sonnet',
      }),
      expect.anything(),
    );
  });

  it('caches the verdict on the pod via podRepo.update', async () => {
    const { bridge, podId, podRepo } = buildBridgeWithWorktree({
      diff: 'diff body',
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
          reasoning: 'all good',
          model: 'sonnet',
        }),
      }),
    );
  });

  it('passes plannedSummary and plannedDeviations through', async () => {
    const { bridge, podId } = buildBridgeWithWorktree({
      diff: 'diff body',
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
