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
