import { describe, expect, it, vi } from 'vitest';
import { logger } from '../test-utils/mock-helpers.js';
import { createSessionBridge, type SessionBridgeDependencies } from './pod-bridge-impl.js';

type Deps = SessionBridgeDependencies;

function bridgeFor(pod: Record<string, unknown>, recoveryFork = false) {
  const execInContainer = vi.fn(async (_id: string, command: string[]) => ({
    stdout: command.includes('status') ? '?? notes.md\0' : 'notes.md\0thoughts/\0',
    stderr: '',
    exitCode: 0,
  }));
  const stub = {} as never;
  const bridge = createSessionBridge({
    podManager: { getSession: vi.fn(() => pod) } as unknown as Deps['podManager'],
    podRepo: {
      recoveryForks: { child: vi.fn(() => (recoveryFork ? { facts: {} } : undefined)) },
    } as unknown as Deps['podRepo'],
    eventBus: stub,
    escalationRepo: stub,
    nudgeRepo: stub,
    profileStore: stub,
    containerManagerFactory: {
      get: vi.fn(() => ({ execInContainer })),
    } as unknown as Deps['containerManagerFactory'],
    pendingRequestsByPod: new Map(),
    logger,
  });
  return { bridge, execInContainer };
}

const prPod = {
  containerId: 'ctr',
  executionTarget: 'local',
  completionPolicy: null,
  options: { output: 'pr', agentMode: 'auto' },
};

describe('pod bridge workspace cleanliness', () => {
  it('probes Git-delivery workspaces in their container', async () => {
    const { bridge, execInContainer } = bridgeFor(prPod);
    expect(await bridge.inspectWorkspaceCleanliness?.('pod')).toEqual({
      untracked: ['notes.md'],
      changed: [],
      hiddenByLocalExclude: ['thoughts/'],
    });
    expect(execInContainer.mock.calls[0]?.[0]).toBe('ctr');
  });

  it('keeps server-selected recovery exclusions out of the warning', async () => {
    const { bridge } = bridgeFor(prPod, true);
    expect((await bridge.inspectWorkspaceCleanliness?.('pod'))?.hiddenByLocalExclude).toEqual([]);
  });

  it.each([
    {
      name: 'artifact output',
      pod: { ...prPod, options: { output: 'artifact', agentMode: 'auto' } },
    },
    { name: 'interactive', pod: { ...prPod, options: { output: 'pr', agentMode: 'interactive' } } },
    { name: 'findings', pod: { ...prPod, completionPolicy: 'accept-findings' } },
    { name: 'no container', pod: { ...prPod, containerId: null } },
  ])('does not apply to $name', async ({ pod }) => {
    const { bridge, execInContainer } = bridgeFor(pod);
    expect(await bridge.inspectWorkspaceCleanliness?.('pod')).toBeNull();
    expect(execInContainer).not.toHaveBeenCalled();
  });

  it('treats probe failures as unavailable', async () => {
    const { bridge, execInContainer } = bridgeFor(prPod);
    execInContainer.mockRejectedValueOnce(new Error('container stopped'));
    expect(await bridge.inspectWorkspaceCleanliness?.('pod')).toBeNull();
  });
});
