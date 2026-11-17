import { describe, expect, it, vi } from 'vitest';
import {
  createFailingValidationResult,
  createPassingValidationResult,
  createTestContext,
} from '../test-utils/mock-helpers.js';
import { createLocalValidationEngine } from '../validation/local-validation-engine.js';
import { createPodManager } from './pod-manager.js';

describe('review routing incidents', () => {
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
