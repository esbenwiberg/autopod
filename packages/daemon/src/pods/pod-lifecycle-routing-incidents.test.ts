import { PendingRequests, reportBlocker } from '@autopod/escalation-mcp';
import { describe, expect, it, vi } from 'vitest';
import {
  completeEvent,
  createFailingValidationResult,
  createPassingValidationResult,
  createTestContext,
} from '../test-utils/mock-helpers.js';
import { createLocalValidationEngine } from '../validation/local-validation-engine.js';
import { CodexReviewError } from '../validation/review-codex-runner.js';
import { createSessionBridge } from './pod-bridge-impl.js';
import { createPodManager } from './pod-manager.js';

describe('review routing incidents', () => {
  it.each([
    {
      diagnostic:
        'FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory',
      code: 'PROCESS_MEMORY_EXHAUSTED',
    },
    {
      diagnostic:
        'Error: [vitest-pool]: Worker forks emitted error.\nCaused by: Error: Worker exited unexpectedly',
      code: 'VALIDATION_RUNNER_CRASHED',
    },
  ])('parks a real Docker validation producer on $code without a coding turn or publication', async ({
    diagnostic,
    code,
  }) => {
    const ctx = createTestContext();
    try {
      const execute = vi.mocked(ctx.containerManager.execInContainer).getMockImplementation();
      if (!execute) throw new Error('Missing container fixture');
      vi.mocked(ctx.containerManager.execInContainer).mockImplementation(async (...args) =>
        args[1].join(' ').includes('crashed-test-runner')
          ? { stdout: diagnostic, stderr: '', exitCode: 1 }
          : execute(...args),
      );
      const producer = createLocalValidationEngine(ctx.containerManager);
      vi.mocked(ctx.validationEngine.validate).mockImplementation((config) =>
        producer.validate({
          ...config,
          executionTarget: 'local',
          hasWebUi: false,
          testCommand: 'crashed-test-runner',
          skipPhases: ['setup', 'lint', 'sast', 'build', 'health', 'pages', 'facts', 'review'],
        }),
      );
      const manager = createPodManager(ctx.deps);
      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Desktop-only work; preserve failed runner evidence' },
        'operator',
      );
      await manager.processPod(pod.id);
      expect(manager.getSession(pod.id)).toMatchObject({
        status: 'review_required',
        validationAttempts: 0,
        lastValidationResult: {
          overall: 'fail',
          infrastructureFailure: { phase: 'test', code, retryable: false },
        },
      });
      expect(ctx.validationEngine.validate).toHaveBeenCalledOnce();
      expect(ctx.runtime.resume).not.toHaveBeenCalled();
      expect(ctx.worktreeManager.pushBranch).not.toHaveBeenCalled();
      expect(ctx.podRepo.taskExecutions?.snapshot(pod.id).agentRunCount).toBe(1);
    } finally {
      ctx.db.close();
    }
  });
  it.each([
    'validation',
    'revalidation',
  ] as const)('holds unreadable source on %s without starting checks or consuming an attempt', async (entry) => {
    for (const method of ['getDiff', 'getCommitLog', 'getChangedPathsAgainstBase'] as const) {
      const ctx = createTestContext();
      try {
        const manager = createPodManager(ctx.deps);
        const pod = manager.createSession(
          { profileName: 'test-profile', task: 'Check exact source' },
          'operator',
        );
        ctx.podRepo.update(pod.id, {
          status: 'running',
          containerId: 'original-container',
          worktreePath: '/tmp/owned-source',
        });
        const read = ctx.worktreeManager[method];
        if (!read) throw new Error('Missing source-reader fixture');
        vi.mocked(read).mockRejectedValueOnce(new Error('Git reference unavailable'));
        if (entry === 'validation') await manager.triggerValidation(pod.id);
        else {
          ctx.podRepo.update(pod.id, { status: 'review_required' });
          await manager.revalidateSession(pod.id, { force: true });
        }
        expect(manager.getSession(pod.id)).toMatchObject({
          status: 'review_required',
          validationAttempts: 0,
          worktreePath: '/tmp/owned-source',
          containerId: 'original-container',
        });
        expect(ctx.validationEngine.validate).not.toHaveBeenCalled();
        expect(ctx.runtime.resume).not.toHaveBeenCalled();
        expect(ctx.podRepo.taskRetries?.state(pod.id).executedCount).toBe(0);
        expect(ctx.worktreeManager.pushBranch).not.toHaveBeenCalled();
      } finally {
        ctx.db.close();
      }
    }
  });

  it.each([
    'validation',
    'revalidation',
  ] as const)('refuses a container source different from the captured %s packet before checks/publication', async (entry) => {
    const ctx = createTestContext();
    try {
      const execute = vi.mocked(ctx.containerManager.execInContainer).getMockImplementation();
      if (!execute) throw new Error('Missing source probe adapter');
      vi.mocked(ctx.containerManager.execInContainer).mockImplementation(async (...args) => {
        const value = await execute(...args);
        return args[1][2]?.includes('autopod-validation-source-v1')
          ? {
              ...value,
              stdout: value.stdout
                .replaceAll('a'.repeat(40), 'c'.repeat(40))
                .replaceAll('b'.repeat(40), 'd'.repeat(40)),
            }
          : value;
      });
      const manager = createPodManager(ctx.deps);
      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Review packet A is not source B' },
        'operator',
      );
      ctx.podRepo.update(pod.id, {
        status: 'running',
        containerId: 'original-container',
        worktreePath: '/tmp/owned-source',
      });
      if (entry === 'validation') await manager.triggerValidation(pod.id);
      else {
        ctx.podRepo.update(pod.id, { status: 'review_required' });
        await manager.revalidateSession(pod.id, { force: true });
      }
      expect(manager.getSession(pod.id)).toMatchObject({
        status: 'review_required',
        validationAttempts: 0,
      });
      expect(ctx.validationEngine.validate).not.toHaveBeenCalled();
      expect(ctx.podRepo.taskRetries?.state(pod.id).executedCount).toBe(0);
      expect(ctx.db.prepare('SELECT count(*) AS n FROM validation_source_results').get()).toEqual({
        n: 0,
      });
      expect(ctx.worktreeManager.pushBranch).not.toHaveBeenCalled();
      expect(ctx.runtime.resume).not.toHaveBeenCalled();
    } finally {
      ctx.db.close();
    }
  });
  it.each([
    false,
    true,
  ])('bounds real reviewer recovery without coding (reconciliation blocked=%s)', async (blocked) => {
    const ctx = createTestContext();
    ctx.deps.validationInfrastructureRetryBackoffMs = [0, 0];
    const executor = Object.assign(
      vi.fn(async () => ({
        stdout: JSON.stringify({
          status: 'pass',
          reasoning: 'Complete source reviewed',
          issues: [],
        }),
      })),
      {
        retryBlocker: () => (blocked ? 'Original reviewer cleanup requires reconciliation' : null),
      },
    );
    executor.mockRejectedValueOnce(
      new CodexReviewError({ kind: 'timeout', message: 'Review deadline', stderr: '' }),
    );
    const producer = createLocalValidationEngine(ctx.containerManager);
    vi.mocked(ctx.validationEngine.validate).mockImplementation((config) =>
      producer.validate({
        ...config,
        validationSuite: undefined,
        hasWebUi: false,
        buildCommand: '',
        startCommand: '',
        reviewerModel: 'claude-sonnet-4-6',
        skipPhases: ['setup', 'lint', 'sast', 'build', 'test', 'health', 'pages', 'facts'],
        diff: 'diff --git a/a.ts b/a.ts\n@@ -0,0 +1 @@\n+change\n',
        reviewerExecutor: executor,
      }),
    );
    try {
      const manager = createPodManager(ctx.deps);
      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Repair source' },
        'operator',
      );
      await manager.processPod(pod.id);
      const stored = manager.getSession(pod.id);
      expect(stored.status).toBe(blocked ? 'review_required' : 'validated');
      expect(executor).toHaveBeenCalledTimes(blocked ? 1 : 2);
      expect(ctx.validationEngine.validate).toHaveBeenCalledTimes(1);
      expect(ctx.runtime.resume).not.toHaveBeenCalled();
      expect(stored.validationAttempts).toBe(blocked ? 0 : 1);
      if (blocked)
        expect(stored.lastValidationResult?.infrastructureFailure).toMatchObject({
          phase: 'review',
          retryable: false,
        });
      else expect(stored.lastValidationResult?.taskReview?.status).toBe('pass');
    } finally {
      ctx.db.close();
    }
  });

  it.each([
    false,
    true,
  ])('persists an external NOT RUN claim without waiving required Mac proof (required=%s)', async (required) => {
    const ctx = createTestContext();
    const manager = createPodManager(ctx.deps);
    const pod = manager.createSession(
      {
        profileName: 'test-profile',
        task: 'Prepare source; native verification belongs to Mac CI',
        ...(required
          ? {
              contract: {
                contractVersion: 1,
                title: 'Native proof',
                dependsOn: [],
                scenarios: [],
                humanReview: [],
                requiredFacts: [
                  {
                    id: 'native',
                    proves: [],
                    kind: 'custom-command',
                    artifact: { path: 'packages/desktop/ProofTests.swift', change: 'update' },
                    command: 'xcodebuild test -scheme Autopod',
                  },
                ],
              },
            }
          : {}),
      },
      'operator',
    );
    const bridge = createSessionBridge({
      ...ctx.deps,
      podManager: manager,
      podRepo: ctx.podRepo,
      escalationRepo: ctx.escalationRepo,
      nudgeRepo: ctx.nudgeRepo,
      pendingRequestsByPod: new Map(),
    });
    const producer = createLocalValidationEngine(ctx.containerManager);
    vi.mocked(ctx.validationEngine.validate).mockImplementation((config) =>
      producer.validate({
        ...config,
        buildCommand: '',
        startCommand: '',
        hasWebUi: false,
        skipPhases: ['setup', 'lint', 'sast', 'build', 'test', 'health', 'pages', 'review'],
      }),
    );
    vi.mocked(ctx.runtime.spawn).mockImplementation(async function* () {
      await reportBlocker(
        pod.id,
        {
          description: 'Expected Mac-only check, not attempted on Linux',
          attempted: [],
          needs: 'Mac CI',
          deferral: {
            check: 'xcodebuild test -scheme Autopod',
            expectedExecutor: 'Mac CI',
            ...(required ? { requiredFactId: 'native' } : {}),
          },
        },
        bridge,
        new PendingRequests(),
      );
      yield completeEvent();
    });
    try {
      await manager.processPod(pod.id);
      const report = ctx.escalationRepo
        .listBySession(pod.id)
        .find((e) => e.type === 'report_blocker');
      expect(report?.payload).toMatchObject({
        kind: 'expected-external-deferral',
        lifecycleGeneration: 1,
        requiresResponse: false,
      });
      expect(ctx.podRepo.hasInfrastructureBlocker?.(pod.id)).toBe(false);
      const stored = manager.getSession(pod.id);
      expect(stored.status).toBe(required ? 'review_required' : 'validated');
      expect(stored.lastValidationResult?.overall).toBe(required ? 'fail' : 'pass');
      if (required)
        expect(stored.lastValidationResult?.factValidation).toMatchObject({
          status: 'pending_human',
          results: [{ factId: 'native', passed: false, status: 'pending_human' }],
        });
      expect(ctx.runtime.resume).not.toHaveBeenCalled();
      expect(ctx.validationEngine.validate).toHaveBeenCalledTimes(1);
    } finally {
      ctx.db.close();
    }
  });

  it('parks a real unavailable reviewer packet without coding rework', async () => {
    const ctx = createTestContext();
    try {
      const producer = createLocalValidationEngine(ctx.containerManager);
      const produced = await producer.validate({
        podId: 'producer',
        containerId: 'container-123',
        previewUrl: 'http://127.0.0.1:9999',
        buildCommand: '',
        startCommand: '',
        healthPath: '/',
        healthTimeout: 1,
        smokePages: [],
        attempt: 1,
        task: 'repair',
        hasWebUi: false,
        diff: 'diff --git a/a b/a\n+change\n⚠ DIFF TRUNCATED: omitted source',
        reviewerExecutor: vi.fn(),
      });
      expect(produced.infrastructureFailure).toMatchObject({
        code: 'REVIEW_INPUT_UNAVAILABLE',
        retryable: false,
      });
      vi.mocked(ctx.validationEngine.validate).mockImplementation(async (config) =>
        JSON.parse(JSON.stringify({ ...produced, podId: config.podId, attempt: config.attempt })),
      );
      const manager = createPodManager(ctx.deps);
      const pod = manager.createSession({ profileName: 'test-profile', task: 'repair' }, 'user');
      await manager.processPod(pod.id);
      const stored = manager.getSession(pod.id);
      expect(stored.status).toBe('review_required');
      expect(stored.lastValidationResult?.infrastructureFailure?.code).toBe(
        'REVIEW_INPUT_UNAVAILABLE',
      );
      expect(ctx.runtime.resume).not.toHaveBeenCalled();
    } finally {
      ctx.db.close();
    }
  });

  it('continues ordinary correction for a genuine code failure', async () => {
    let attempts = 0;
    const ctx = createTestContext({
      simulatedReworkChangesSource: true,
      validationResultFactory: (config) =>
        ++attempts === 1
          ? createFailingValidationResult(config.podId, config.attempt)
          : createPassingValidationResult(config.podId, config.attempt),
    });
    try {
      const manager = createPodManager(ctx.deps);
      const pod = manager.createSession({ profileName: 'test-profile', task: 'repair' }, 'user');
      await manager.processPod(pod.id);
      expect(ctx.runtime.resume).toHaveBeenCalledTimes(1);
      expect(manager.getSession(pod.id).status).toBe('validated');
    } finally {
      ctx.db.close();
    }
  });
});
