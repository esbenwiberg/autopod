import type { Pod, Profile } from '@autopod/shared';
import { describe, expect, it, vi } from 'vitest';
import { SandboxInfrastructureError } from '../containers/sandbox-api-client.js';
import type { ContainerManager } from '../interfaces/container-manager.js';
import type { WorktreeManager } from '../interfaces/worktree-manager.js';
import type { EscalationRepository } from '../pods/escalation-repository.js';
import type { EventRepository } from '../pods/event-repository.js';
import type { ContainerManagerFactory, PodManager } from '../pods/pod-manager.js';
import type { ProviderAttemptRepository } from '../pods/provider-attempt-repository.js';
import type { ProfileStore } from '../profiles/index.js';
import { logger } from '../test-utils/mock-helpers.js';
import { createDaemonPodsitterEvidenceProvider } from './daemon-evidence-provider.js';
import type { PodsitterRepository } from './podsitter-repository.js';

function makePod(overrides: Partial<Pod> = {}): Pod {
  return {
    id: 'pod-1',
    profileName: 'default',
    status: 'validated',
    task: 'Implement the feature',
    branch: 'autopod/pod-1',
    baseBranch: 'main',
    worktreePath: '/not-a-real-worktree',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:05:00.000Z',
    validationAttempts: 1,
    readinessReview: { status: 'ready' },
    lastValidationResult: { overall: 'pass' },
    ...overrides,
  } as Pod;
}

function harness(initialPod: Pod, diff: string, containerManager?: ContainerManager) {
  let pod = initialPod;
  const podManager = {
    getSession: vi.fn(() => pod),
    listSessions: vi.fn(() => [pod]),
    getValidationHistory: vi.fn(() => []),
  } as unknown as PodManager;
  const worktreeManager = {
    getDiff: vi.fn(async () => diff),
  } as unknown as WorktreeManager;
  const provider = createDaemonPodsitterEvidenceProvider({
    podManager,
    eventRepo: {
      getForSession: vi.fn(() => [
        {
          type: 'pod.agent_activity',
          timestamp: '2026-01-01T00:04:00.000Z',
          podId: 'pod-1',
          message: 'Build completed',
        },
      ]),
    } as unknown as EventRepository,
    escalationRepo: { listBySession: vi.fn(() => []) } as unknown as EscalationRepository,
    providerAttemptRepo: { list: vi.fn(() => []) } as unknown as ProviderAttemptRepository,
    repository: {
      listDecisions: vi.fn(() => ({ items: [], total: 0 })),
    } as unknown as PodsitterRepository,
    containerManagerFactory: {
      get: vi.fn(() => containerManager),
    } as unknown as ContainerManagerFactory,
    profileStore: {
      get: vi.fn(
        () =>
          ({
            name: 'default',
            defaultBranch: 'main',
          }) as Profile,
      ),
    } as unknown as ProfileStore,
    worktreeManager,
    logger,
  });
  return {
    provider,
    setPod(next: Pod) {
      pod = next;
    },
  };
}

function sectionContent(
  candidate: Awaited<ReturnType<ReturnType<typeof harness>['provider']['getCandidate']>>,
  ref: string,
) {
  return candidate?.evidence.sections.find((section) => section.ref === ref);
}

describe('daemon Podsitter evidence provider', () => {
  it('includes bounded canonical diff and deterministic touched-file excerpts', async () => {
    const diff = `diff --git a/src/example.ts b/src/example.ts
index 111..222 100644
--- a/src/example.ts
+++ b/src/example.ts
@@ -1 +1,2 @@
 export const value = 1;
+export const apiKey = "sk-abcdefghijklmnop";
`;
    const { provider } = harness(makePod(), diff);

    const candidate = await provider.getCandidate('pod-1', new Date(), null as never);
    const diffSection = sectionContent(candidate, 'diff:bounded');
    const excerptSection = sectionContent(candidate, 'touched-files:excerpts');

    expect(diffSection?.unavailable).toBe(false);
    expect(JSON.stringify(diffSection?.content)).toContain('src/example.ts');
    expect(JSON.stringify(diffSection?.content)).not.toContain('sk-abcdefghijklmnop');
    expect(excerptSection?.unavailable).toBe(false);
    expect(excerptSection?.content).toEqual([
      {
        path: 'src/example.ts',
        excerpt: '@@ -1 +1,2 @@\n+export const apiKey = [redacted];',
      },
    ]);
  });

  it('invalidates deterministic approval and the attention signature for a merge blocker', async () => {
    const ready = makePod();
    const harnessValue = harness(ready, '');
    const before = await harnessValue.provider.getCandidate('pod-1', new Date(), null as never);
    expect(before?.deterministicApproval).toBe(true);

    harnessValue.setPod(makePod({ mergeBlockReason: 'Required check failed' }));
    const after = await harnessValue.provider.getCandidate('pod-1', new Date(), null as never);
    expect(after?.deterministicApproval).toBe(false);
    expect(after?.signature).not.toBe(before?.signature);
  });

  it('uses host evidence without executing in a stopped sandbox', async () => {
    const containerManager = {
      getStatus: vi.fn(async () => 'stopped' as const),
      execInContainer: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
    } as unknown as ContainerManager;
    const { provider } = harness(
      makePod({
        executionTarget: 'sandbox',
        containerId: 'sandbox-stopped',
        startCommitSha: 'a'.repeat(40),
      }),
      'host diff',
      containerManager,
    );

    const candidate = await provider.getCandidate('pod-1', new Date(), null as never);

    expect(containerManager.getStatus).toHaveBeenCalledOnce();
    expect(containerManager.execInContainer).not.toHaveBeenCalled();
    expect(sectionContent(candidate, 'diff:bounded')?.content).toMatchObject({
      source: 'worktree',
      diff: 'host diff',
    });
  });

  it('serializes and reuses unchanged live sandbox evidence', async () => {
    let active = 0;
    let maxActive = 0;
    const execInContainer = vi.fn(async (_containerId: string, command: string[]) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      if (command.includes('ls-files')) return { stdout: '', stderr: '', exitCode: 0 };
      return { stdout: 'container diff', stderr: '', exitCode: 0 };
    });
    const containerManager = {
      getStatus: vi.fn(async () => 'running' as const),
      execInContainer,
    } as unknown as ContainerManager;
    const pod = makePod({
      executionTarget: 'sandbox',
      containerId: 'sandbox-running',
      startCommitSha: 'a'.repeat(40),
    });
    const { provider } = harness(pod, '', containerManager);

    await provider.getCandidate('pod-1', new Date(), null as never);
    const callsAfterFirstRead = execInContainer.mock.calls.length;
    await provider.getCandidate('pod-1', new Date(), null as never);

    expect(maxActive).toBe(1);
    expect(callsAfterFirstRead).toBeGreaterThan(0);
    expect(execInContainer).toHaveBeenCalledTimes(callsAfterFirstRead);
    expect(containerManager.getStatus).toHaveBeenCalledOnce();
  });

  it('bounds candidate evidence collection concurrency', async () => {
    const pods = Array.from({ length: 10 }, (_, index) =>
      makePod({
        id: `pod-${index}`,
        worktreePath: `/worktree/${index}`,
        containerId: null,
      }),
    );
    let active = 0;
    let maxActive = 0;
    const worktreeManager = {
      getDiff: vi.fn(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
        return '';
      }),
    } as unknown as WorktreeManager;
    const provider = createDaemonPodsitterEvidenceProvider({
      podManager: {
        getSession: vi.fn((podId: string) => pods.find((pod) => pod.id === podId) as Pod),
        listSessions: vi.fn(() => pods),
        getValidationHistory: vi.fn(() => []),
      } as unknown as PodManager,
      eventRepo: { getForSession: vi.fn(() => []) } as unknown as EventRepository,
      escalationRepo: { listBySession: vi.fn(() => []) } as unknown as EscalationRepository,
      providerAttemptRepo: { list: vi.fn(() => []) } as unknown as ProviderAttemptRepository,
      repository: {
        listDecisions: vi.fn(() => ({ items: [], total: 0 })),
      } as unknown as PodsitterRepository,
      containerManagerFactory: { get: vi.fn() } as unknown as ContainerManagerFactory,
      profileStore: {
        get: vi.fn(() => ({ name: 'default', defaultBranch: 'main' }) as Profile),
      } as unknown as ProfileStore,
      worktreeManager,
      logger,
    });

    await provider.listCandidates(new Date(), null);

    expect(maxActive).toBeGreaterThan(1);
    expect(maxActive).toBeLessThanOrEqual(4);
  });

  it('stops starting sandbox evidence after an infrastructure error in the cycle', async () => {
    const pods = Array.from({ length: 8 }, (_, index) =>
      makePod({
        id: `pod-${index}`,
        executionTarget: 'sandbox',
        containerId: `sandbox-${index}`,
        worktreePath: `/worktree/${index}`,
        startCommitSha: 'a'.repeat(40),
      }),
    );
    const attemptedSandboxes = new Set<string>();
    const containerManager = {
      getStatus: vi.fn(async () => 'running' as const),
      execInContainer: vi.fn(async (containerId: string, command: string[]) => {
        attemptedSandboxes.add(containerId);
        if (containerId === 'sandbox-0') {
          throw new SandboxInfrastructureError(403, { 'x-ms-request-id': 'podsitter-403' });
        }
        await new Promise((resolve) => setImmediate(resolve));
        if (command.includes('ls-files')) return { stdout: '', stderr: '', exitCode: 0 };
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
    } as unknown as ContainerManager;
    const provider = createDaemonPodsitterEvidenceProvider({
      podManager: {
        getSession: vi.fn((podId: string) => pods.find((pod) => pod.id === podId) as Pod),
        listSessions: vi.fn(() => pods),
        getValidationHistory: vi.fn(() => []),
      } as unknown as PodManager,
      eventRepo: { getForSession: vi.fn(() => []) } as unknown as EventRepository,
      escalationRepo: { listBySession: vi.fn(() => []) } as unknown as EscalationRepository,
      providerAttemptRepo: { list: vi.fn(() => []) } as unknown as ProviderAttemptRepository,
      repository: {
        listDecisions: vi.fn(() => ({ items: [], total: 0 })),
      } as unknown as PodsitterRepository,
      containerManagerFactory: {
        get: vi.fn(() => containerManager),
      } as unknown as ContainerManagerFactory,
      profileStore: {
        get: vi.fn(() => ({ name: 'default', defaultBranch: 'main' }) as Profile),
      } as unknown as ProfileStore,
      worktreeManager: {
        getDiff: vi.fn(async () => ''),
      } as unknown as WorktreeManager,
      logger,
    });

    await provider.listCandidates(new Date(), null);

    expect(attemptedSandboxes).toContain('sandbox-0');
    expect([...attemptedSandboxes]).not.toContain('sandbox-4');
    expect([...attemptedSandboxes]).not.toContain('sandbox-7');
  });
});
