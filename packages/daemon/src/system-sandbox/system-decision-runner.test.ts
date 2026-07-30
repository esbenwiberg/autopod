import type { PodsitterDecision, ProviderAccount } from '@autopod/shared';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { ContainerManager, ContainerSpawnConfig } from '../interfaces/container-manager.js';
import type { PodsitterRepository } from '../podsitter/podsitter-repository.js';
import type { ProviderAccountStore } from '../provider-accounts/index.js';
import { SystemDecisionRunner } from './system-decision-runner.js';

const decision: PodsitterDecision = {
  contractVersion: 1,
  attentionSignature: 'signature',
  action: 'no_action',
  arguments: {},
  reason: 'No action.',
  evidenceRefs: ['pod:state'],
  confidence: 'high',
  remainingRisk: 'None.',
  stopCondition: 'Evidence changes.',
};

function harness(options: { output?: string; exitCode?: number; killFails?: boolean } = {}) {
  const spawns: ContainerSpawnConfig[] = [];
  const manager = {
    spawn: vi.fn(async (config: ContainerSpawnConfig) => {
      spawns.push(config);
      return 'system-container';
    }),
    writeFile: vi.fn(async () => undefined),
    readFile: vi.fn(async () => {
      throw new Error('absent');
    }),
    execInContainer: vi.fn(async (_id, command: string[]) =>
      command[0] === 'chmod'
        ? { stdout: '', stderr: '', exitCode: 0 }
        : {
            stdout: options.output ?? JSON.stringify(decision),
            stderr: '',
            exitCode: options.exitCode ?? 0,
          },
    ),
    kill: vi.fn(async () => {
      if (options.killFails) throw new Error('secret=cleanup-token');
    }),
  } as unknown as ContainerManager;
  const runs: Array<{ id: string; outcome?: string; cleanupState?: string }> = [];
  const repository = {
    createSandboxRun: vi.fn(({ id }) => runs.push({ id })),
    setSandboxContainer: vi.fn(() => true),
    closeSandboxRun: vi.fn((id, update) => {
      runs.push({ id, ...update });
      return true;
    }),
    listActiveSandboxRuns: vi.fn(() => []),
  } as unknown as PodsitterRepository;
  const account: ProviderAccount = {
    id: 'copilot-decision',
    name: 'Copilot decision',
    provider: 'copilot',
    credentials: { provider: 'copilot', token: 'dedicated-secret' },
    failoverPolicy: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    lastAuthenticatedAt: new Date(0).toISOString(),
    lastUsedAt: null,
  };
  const providerAccountStore = {
    get: vi.fn(() => account),
    touchLastUsed: vi.fn(),
  } as unknown as ProviderAccountStore;
  return {
    manager,
    repository,
    spawns,
    runs,
    runner: new SystemDecisionRunner({
      localContainerManager: manager,
      sandboxContainerManager: manager,
      providerAccountStore,
      repository,
      logger: pino({ level: 'silent' }),
      hostedImage: 'registry.example.io/autopod/system-decision:2026.07.30',
    }),
  };
}

const input = {
  decisionId: 'decision-1',
  providerAccountId: 'copilot-decision',
  runtime: 'copilot' as const,
  model: 'gpt-5',
  prompt: 'bounded evidence',
  contractVersion: 1 as const,
  executionTarget: 'local' as const,
  timeoutMs: 30_000,
};

describe('SystemDecisionRunner', () => {
  it('spawns a repo-free provider-only sandbox', async () => {
    const { runner, spawns, manager } = harness();
    await expect(runner.run(input)).resolves.toMatchObject({ ok: true });
    expect(spawns).toEqual([
      expect.objectContaining({
        image: 'autopod-system-decision:local',
        env: {},
        volumes: [],
        ports: [],
        networkPolicyMode: 'restricted',
        allowedHosts: expect.any(Array),
      }),
    ]);
    expect(JSON.stringify(spawns)).not.toContain('dedicated-secret');
    expect(JSON.stringify(spawns)).not.toContain('/workspace');
    expect(spawns[0]?.env).not.toHaveProperty('AUTOPOD_MCP_URL');
    expect(spawns[0]?.env).not.toHaveProperty('AUTOPOD_POD_TOKEN');
    expect(spawns[0]?.env).not.toHaveProperty('GITHUB_TOKEN');
    expect(vi.mocked(manager.execInContainer).mock.calls).toEqual(
      expect.arrayContaining([
        [
          'system-container',
          expect.arrayContaining([expect.stringContaining('copilot')]),
          expect.objectContaining({ cwd: '/tmp', timeout: expect.any(Number) }),
        ],
      ]),
    );
    expect(manager.execInContainer).toHaveBeenCalledWith(
      'system-container',
      ['chmod', '0400', '/run/autopod/copilot-token'],
      expect.objectContaining({ user: 'root' }),
    );
  });

  it('cleans and reaps system sandboxes', async () => {
    const first = harness({ output: 'invalid' });
    await first.runner.run(input);
    expect(first.manager.kill).toHaveBeenCalledWith('system-container');
    const inferenceCalls = vi
      .mocked(first.manager.execInContainer)
      .mock.calls.filter(([, command]) => command[0] !== 'chmod');
    expect(inferenceCalls).toHaveLength(2);
    expect((inferenceCalls[1]?.[2] as { timeout: number }).timeout).toBeLessThanOrEqual(
      (inferenceCalls[0]?.[2] as { timeout: number }).timeout,
    );

    const second = harness();
    vi.mocked(second.repository.listActiveSandboxRuns).mockReturnValue([
      {
        id: 'leaked-run',
        decisionId: 'decision-old',
        backend: 'docker',
        containerId: 'old-container',
      },
    ]);
    await expect(second.runner.reapLeakedRuns()).resolves.toBe(1);
    expect(second.manager.kill).toHaveBeenCalledWith('old-container');
    expect(second.repository.closeSandboxRun).toHaveBeenCalledWith(
      'leaked-run',
      expect.objectContaining({ cleanupState: 'clean' }),
    );
  });

  it('classifies provider limits without leaking secrets', async () => {
    const transient = harness({
      output: '',
      exitCode: 1,
    });
    vi.mocked(transient.manager.execInContainer).mockResolvedValue({
      stdout: '',
      stderr: JSON.stringify({
        status: 429,
        code: 'rate_limit_exceeded',
        message: 'rate limit exceeded token=super-secret-token',
        retryAfter: '2026-07-30T12:00:00.000Z',
      }),
      exitCode: 1,
    });
    const result = await transient.runner.run(input);
    expect(result).toMatchObject({
      ok: false,
      kind: 'provider',
      failure: {
        category: 'transient',
        retryAfter: '2026-07-30T12:00:00.000Z',
      },
    });
    expect(JSON.stringify(result)).not.toContain('super-secret-token');
    expect(JSON.stringify(transient.runs)).not.toContain('super-secret-token');
  });
});
