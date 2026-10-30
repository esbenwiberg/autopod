import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pod } from '@autopod/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCompletionFixture } from '../test-utils/completion-helpers.js';
import { createMockContainerManager } from '../test-utils/mock-helpers.js';
import { hasInterruptedArtifactCollection } from './artifact-finalization-recovery.js';
import { createArtifactFinalizer } from './artifact-finalizer.js';
import { createPodRepository } from './pod-repository.js';
import { createFindingsAcceptance } from './research-findings.js';
import {
  canKill,
  canNudge,
  canPause,
  canReceiveMessage,
  isTerminalState,
  validateTransition,
} from './state-machine.js';

let f: ReturnType<typeof createCompletionFixture>;
let root: string;
beforeEach(async () => {
  f = createCompletionFixture();
  root = await mkdtemp(path.join(tmpdir(), 'findings-'));
  vi.stubEnv('DATA_DIR', root);
  f.running();
  f.db
    .prepare(
      "UPDATE pods SET completion_policy='accept-findings', launch_config_digest=? WHERE id='prepare'",
    )
    .run('a'.repeat(64));
  f.podRepo.update('prepare', {
    options: { agentMode: 'auto', output: 'none', validate: false },
    taskSummary: {
      actualSummary: 'Diagnostic failed; root cause unresolved. Investigation delivered.',
      deviations: [],
    },
  });
  f.podRepo.completionJournal?.settle(f.pod(), 'Investigation complete');
});
afterEach(async () => {
  f.close();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

function finalizer(report = true) {
  const cm = createMockContainerManager();
  vi.mocked(cm.extractDirectoryFromContainer).mockImplementation(
    async (_id, _source, destination) => {
      if (report)
        await writeFile(
          path.join(destination, 'arbitrary-report.md'),
          'Diagnostic failed; unresolved',
        );
    },
  );
  const cleanup = vi.fn(
    async (pod: Pod, _label: string, _mode: 'kill', assertCurrent: () => void) => {
      assertCurrent();
      f.podRepo.update(pod.id, { containerId: null });
    },
  );
  const credentials = vi.fn(async () => 'should never resolve');
  const finalizer = createArtifactFinalizer({
    podRepo: f.podRepo,
    getContainerManager: () => cm,
    ownsArtifactCompletion: (pod, removed) => {
      const current = f.pod();
      return (
        current.status === 'running' &&
        current.lifecycleGeneration === pod.lifecycleGeneration &&
        (current.containerId === pod.containerId || Boolean(removed && !current.containerId))
      );
    },
    executionForPod: f.captured.executionForPod,
    assertExecutionTerminationVerified: f.guards.assertExecutionTerminationVerified,
    syncSandboxSeriesHandover: vi.fn(async () => {}),
    resolveGitCredential: credentials,
    worktreeManager: f.worktreeManager,
    cleanupContainer: cleanup,
    transition: f.events.transition,
    logger: f.deps.logger,
    emitActivityStatus: f.events.emitActivityStatus,
    emitActivityError: f.events.emitActivityError,
  });
  return { ...finalizer, cm, cleanup, credentials };
}
function acceptance() {
  const completed = vi.fn();
  const dependents = vi.fn();
  return {
    completed,
    dependents,
    accept: createFindingsAcceptance({
      podRepo: f.podRepo,
      ...f.guards,
      transition: f.events.transition,
      emitPodCompletedEvent: completed,
      maybeTriggerDependents: dependents,
    }),
  };
}
function request() {
  const evidence = f.pod().researchFindings;
  if (!evidence) throw new Error('Missing evidence');
  return {
    expectedGeneration: evidence.generation,
    expectedCycle: evidence.cycle,
    expectedEvidenceHash: evidence.evidenceHash,
  };
}
const human = { type: 'human' as const, id: 'reviewer' };

describe('research findings contract', () => {
  it.each(['none', 'artifact'] as const)(
    'retains %s findings and releases worker without delivery or fabricated validation',
    async (output) => {
      f.podRepo.update('prepare', { options: { ...f.pod().options, output } });
      const service = finalizer();
      await service.finalizeArtifactPod(f.pod());
      const pod = createPodRepository(f.db).getOrThrow('prepare');
      expect(pod).toMatchObject({
        status: 'research_ready',
        containerId: null,
        completedAt: null,
        lastValidationResult: null,
        researchFindings: {
          summary: { actualSummary: expect.stringContaining('unresolved') },
          acceptance: null,
        },
      });
      expect(
        await readFile(path.join(pod.artifactsPath ?? '', 'arbitrary-report.md'), 'utf8'),
      ).toContain('failed');
      expect(service.credentials).not.toHaveBeenCalled();
      expect(f.worktreeManager.pushBranch).not.toHaveBeenCalled();
      expect(f.calls.triggerValidation).not.toHaveBeenCalled();
      expect(hasInterruptedArtifactCollection(pod)).toBe(false);
      expect(f.podRepo.getStats().byStatus.research_ready).toBe(1);
    },
  );
  it('supports summary-only research and exact concurrent idempotent acceptance', async () => {
    await finalizer(false).finalizeArtifactPod(f.pod());
    const service = acceptance();
    const results = await Promise.all([
      service.accept('prepare', request(), human),
      service.accept('prepare', request(), human),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(f.pod()).toMatchObject({
      status: 'complete',
      completedAt: results[0]?.acceptance?.acceptedAt,
    });
    expect(service.completed).toHaveBeenCalledTimes(1);
    expect(service.dependents).toHaveBeenCalledTimes(1);
    await expect(
      service.accept('prepare', { ...request(), expectedEvidenceHash: 'b'.repeat(64) }, human),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(f.pod().researchFindings?.acceptance?.actor).toEqual(human);
  });
  it('rejects non-human, stale cycle, killed and changed evidence without completing', async () => {
    await finalizer().finalizeArtifactPod(f.pod());
    const service = acceptance();
    const reviewed = request();
    await expect(
      service.accept('prepare', reviewed, { type: 'automation', id: 'auto' }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      service.accept('prepare', { ...reviewed, expectedCycle: reviewed.expectedCycle + 1 }, human),
    ).rejects.toMatchObject({ statusCode: 409 });
    await writeFile(path.join(f.pod().artifactsPath ?? '', 'arbitrary-report.md'), 'changed');
    await expect(service.accept('prepare', reviewed, human)).rejects.toMatchObject({
      code: 'ARTIFACT_SNAPSHOT_UNVERIFIED',
    });
    expect(f.pod().status).toBe('research_ready');
    f.podRepo.update('prepare', { status: 'killing' });
    await expect(service.accept('prepare', reviewed, human)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(service.completed).not.toHaveBeenCalled();
  });
  it('retains resources when preservation fails and identifies settled none-output recovery', async () => {
    const service = finalizer();
    vi.mocked(service.cm.extractDirectoryFromContainer).mockRejectedValue(
      new Error('export interrupted'),
    );
    await service.finalizeArtifactPod(f.pod());
    expect(f.pod().status).toBe('failed');
    expect(f.pod().containerId).not.toBeNull();
    expect(hasInterruptedArtifactCollection(f.pod())).toBe(true);
    expect(service.cleanup).not.toHaveBeenCalled();
  });
  it('refuses unresolved validation execution before collecting or cleaning', async () => {
    const service = finalizer();
    vi.spyOn(
      f.podRepo.validationExecutions ??
        (() => {
          throw new Error('Missing ledger');
        })(),
      'assertTaskSettled',
    ).mockImplementation(() => {
      throw new Error('unsettled');
    });
    await expect(service.finalizeArtifactPod(f.pod())).rejects.toThrow('unsettled');
    expect(service.cm.extractDirectoryFromContainer).not.toHaveBeenCalled();
    expect(service.cleanup).not.toHaveBeenCalled();
  });
  it('keeps research ready a human decision, never merge approval or an active worker', () => {
    expect(() => validateTransition('prepare', 'running', 'research_ready')).not.toThrow();
    expect(() => validateTransition('prepare', 'research_ready', 'approved')).toThrow();
    expect(() => validateTransition('prepare', 'research_ready', 'complete')).not.toThrow();
    expect(canKill('research_ready')).toBe(true);
    for (const check of [canPause, canNudge, canReceiveMessage, isTerminalState])
      expect(check('research_ready')).toBe(false);
  });
});
