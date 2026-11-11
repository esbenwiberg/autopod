import { expect, it, vi } from 'vitest';
import { resolveLaunch } from '../configuration/launch-resolver.js';
import type { ContainerManager } from '../interfaces/container-manager.js';
import type { ReviewerExecutor } from '../interfaces/reviewer-executor.js';
import { createPodRepository } from '../pods/pod-repository.js';
import {
  createTestConfiguration,
  insertConfigurationTestPod,
} from '../test-utils/configuration-helpers.js';
import { createTestDb } from '../test-utils/mock-helpers.js';
import { createLocalValidationEngine } from './local-validation-engine.js';
import { ReviewerRunRepository } from './reviewer-run-repository.js';

it('completes the real artifact council through exclusive reviewer reservations without relaxing ownership', async () => {
  const db = createTestDb();
  try {
    const { services } = createTestConfiguration(db);
    const launch = await resolveLaunch(
      {
        repositoryId: 'repo-a',
        task: 'Review artifact',
        overrides: { workflow: { tokenBudget: null } },
      },
      services,
    );
    insertConfigurationTestPod(db, 'artifact-review');
    db.prepare(
      "UPDATE pods SET launch_config_digest=?, token_telemetry_accuracy='complete' WHERE id='artifact-review'",
    ).run(launch.digest);
    const pod = createPodRepository(db).getOrThrow('artifact-review');
    const runs = new ReviewerRunRepository(db);
    let active = 0;
    let maximum = 0;
    let ordinal = 0;
    const verifiedAtDispatch: number[] = [];
    const verify = vi.fn(async () => {});
    const executor: ReviewerExecutor = async ({ prompt }) => {
      const id = `native-review-${++ordinal}`;
      verifiedAtDispatch.push(verify.mock.calls.length);
      runs.reserve(id, pod, launch, launch.ai.main);
      active++;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      runs.attach(id, `review-container-${ordinal}`);
      runs.running(id);
      const usage = { inputTokens: 10, outputTokens: 5 };
      runs.finish(id, true, true, usage);
      runs.cleaned(id, true);
      active--;
      return {
        stdout: prompt.includes('synthesizer')
          ? JSON.stringify({ decisions: [] })
          : prompt.includes('You are the ')
            ? JSON.stringify({ findings: [] })
            : JSON.stringify({ status: 'pass', reasoning: 'Source reviewed', issues: [] }),
        tokenUsage: usage,
      };
    };
    executor.retryBlocker = () => runs.retryBlocker(pod.id);
    const cm = { execInContainer: vi.fn() } as unknown as ContainerManager;
    const result = await createLocalValidationEngine(cm).validate({
      podId: pod.id,
      containerId: 'checks',
      previewUrl: '',
      attempt: 1,
      task: 'Check artifact source',
      diff: 'diff --git a/source.js b/source.js\n--- /dev/null\n+++ b/source.js\n@@ -0,0 +1 @@\n+export const answer = 42;\n',
      buildCommand: '',
      startCommand: '',
      healthPath: '/',
      healthTimeout: 1,
      smokePages: [],
      hasWebUi: false,
      validationSuite: 'full',
      skipPhases: ['setup', 'lint', 'sast', 'build', 'test', 'health', 'pages', 'facts'],
      reviewerModel: 'claude-sonnet-4-6',
      reviewerProvider: 'anthropic',
      reviewerExecutor: executor,
      artifactSource: { sha256: 'a'.repeat(64), verify },
    });
    expect(result.overall).toBe('pass');
    expect(result.taskReview?.reviewBatch).toMatchObject({
      quality: 'healthy',
      synthesis: 'model',
    });
    expect(result.taskReview?.reviewBatch?.axes).toHaveLength(5);
    expect(
      result.taskReview?.reviewBatch?.axes.every(
        (axis) => axis.status === 'completed' && axis.attempts === 1,
      ),
    ).toBe(true);
    expect(maximum).toBe(1);
    expect(ordinal).toBe(7); // Broad review, all five axes, synthesis.
    expect(runs.list(pod.id)).toHaveLength(7);
    expect(
      runs.list(pod.id).every((run) => run.state === 'completed' && run.cleanup === 'clean'),
    ).toBe(true);
    expect(runs.retryBlocker(pod.id)).toBeNull();
    for (let index = 1; index <= 5; index++)
      expect(verifiedAtDispatch[index]).toBeGreaterThan(verifiedAtDispatch[index - 1]!);
    expect(cm.execInContainer).not.toHaveBeenCalled();
  } finally {
    db.close();
  }
});
