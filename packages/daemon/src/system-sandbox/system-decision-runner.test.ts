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

function harness(
  options: {
    output?: string;
    exitCode?: number;
    killFails?: boolean;
    spawnFailsAfterCreate?: boolean;
    spawnHangs?: boolean;
    repairWriteHangs?: boolean;
    readFileHangs?: boolean;
    createRunFails?: boolean;
    rootOwnedUploads?: boolean;
    chmodFails?: boolean;
    networkProvisioning?: Promise<{ networkName: string; firewallScript: string }>;
  } = {},
) {
  const spawns: ContainerSpawnConfig[] = [];
  const fileOwners = new Map<string, string>();
  const manager = {
    spawn: vi.fn(async (config: ContainerSpawnConfig) => {
      spawns.push(config);
      if (options.spawnHangs) return await new Promise<string>(() => undefined);
      config.onCreated?.('system-container');
      if (options.spawnFailsAfterCreate) throw new Error('spawn interrupted after allocation');
      return 'system-container';
    }),
    writeFile: vi.fn(async (_id, _path, content: string | Buffer) => {
      fileOwners.set(_path, options.rootOwnedUploads ? 'root:root' : '1000:1000');
      if (
        options.repairWriteHangs &&
        String(content).includes('previous response failed strict schema validation')
      ) {
        return await new Promise<void>(() => undefined);
      }
    }),
    readFile: vi.fn(async () => {
      if (options.readFileHangs) return await new Promise<string>(() => undefined);
      throw new Error('absent');
    }),
    execInContainer: vi.fn(async (_id, command: string[]) => {
      if (command[0] === 'chown') {
        for (const path of command.slice(2)) fileOwners.set(path, command[1] ?? '');
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (command[0] === 'chmod') {
        return {
          stdout: '',
          stderr: options.chmodFails ? 'permission denied' : '',
          exitCode: options.chmodFails ? 1 : 0,
        };
      }
      if (
        options.rootOwnedUploads &&
        (fileOwners.get('/run/autopod/system-credential-shim.sh') !== '1000:1000' ||
          fileOwners.get('/run/autopod/copilot-token') !== '1000:1000')
      ) {
        return { stdout: '', stderr: 'permission denied', exitCode: 126 };
      }
      return {
        stdout: options.output ?? JSON.stringify(decision),
        stderr: '',
        exitCode: options.exitCode ?? 0,
      };
    }),
    kill: vi.fn(async () => {
      if (options.killFails) throw new Error('secret=cleanup-token');
    }),
  } as unknown as ContainerManager;
  const runs: Array<{ id: string; outcome?: string; cleanupState?: string }> = [];
  const repository = {
    createSandboxRun: vi.fn(({ id }) => {
      if (options.createRunFails) throw new Error('duplicate key secret=repository-token');
      runs.push({ id });
    }),
    setSandboxContainer: vi.fn(() => true),
    closeSandboxRun: vi.fn((id, update) => {
      runs.push({ id, ...update });
      return true;
    }),
    listActiveSandboxRuns: vi.fn(() => []),
  } as unknown as PodsitterRepository;
  const dockerNetworkManager = {
    buildNetworkConfig: vi.fn(
      async () =>
        await (options.networkProvisioning ??
          Promise.resolve({
            networkName: 'autopod-system-decision-1',
            firewallScript: '#!/bin/sh\niptables -A OUTPUT -j REJECT',
          })),
    ),
    removeNetworkForPod: vi.fn(async () => undefined),
  };
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
    updateCredentials: vi.fn(),
  } as unknown as ProviderAccountStore;
  return {
    manager,
    repository,
    spawns,
    runs,
    dockerNetworkManager,
    providerAccountStore,
    runner: new SystemDecisionRunner({
      localContainerManager: manager,
      sandboxContainerManager: manager,
      providerAccountStore,
      repository,
      dockerNetworkManager,
      logger: pino({ level: 'silent' }),
      hostedImage: 'autopod.azurecr.io/autopod/system-decision:2026.07.30',
      credentialReadbackTimeoutMs: 10,
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
    const { runner, spawns, manager, dockerNetworkManager } = harness();
    await expect(runner.run(input)).resolves.toMatchObject({ ok: true });
    expect(spawns).toEqual([
      expect.objectContaining({
        image: 'autopod-system-decision:local',
        env: {},
        workingDir: '/tmp',
        volumes: [],
        ports: [],
        exposeHostGateway: false,
        networkPolicyMode: 'restricted',
        allowedHosts: expect.any(Array),
        networkName: 'autopod-system-decision-1',
        firewallScript: expect.stringContaining('iptables'),
        enableCapabilityDrop: true,
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
    const inferenceCommand = vi
      .mocked(manager.execInContainer)
      .mock.calls.find(([, command]) => command[0] === 'setpriv')?.[1];
    expect(inferenceCommand?.slice(0, 6)).toEqual([
      'setpriv',
      '--bounding-set=-all',
      '--inh-caps=-all',
      '--ambient-caps=-all',
      '--no-new-privs',
      '--',
    ]);
    expect(inferenceCommand).toEqual(expect.arrayContaining([expect.stringContaining('copilot')]));
    expect(manager.execInContainer).toHaveBeenCalledWith(
      'system-container',
      ['chmod', '0400', '/run/autopod/copilot-token'],
      expect.objectContaining({ user: 'root' }),
    );
    expect(dockerNetworkManager.buildNetworkConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        mode: 'restricted',
        replaceDefaults: true,
        allowPackageManagers: false,
      }),
      [],
      '127.0.0.1',
      [],
      'system-decision-1',
      [],
      [],
      0,
      false,
    );
    expect(dockerNetworkManager.removeNetworkForPod).toHaveBeenCalledWith('system-decision-1');
  });

  it('makes root-owned hosted uploads readable only by the runtime user', async () => {
    const hosted = harness({ rootOwnedUploads: true });

    await expect(
      hosted.runner.run({ ...input, executionTarget: 'sandbox' }),
    ).resolves.toMatchObject({ ok: true });

    expect(hosted.manager.execInContainer).toHaveBeenCalledWith(
      'system-container',
      [
        'chown',
        '1000:1000',
        '/run/autopod/system-credential-shim.sh',
        '/run/autopod/copilot-token',
      ],
      expect.objectContaining({ user: 'root' }),
    );
  });

  it('fails closed and tears down when secret permissions cannot be restricted', async () => {
    const unsafe = harness({ chmodFails: true });

    await expect(unsafe.runner.run(input)).resolves.toMatchObject({
      ok: false,
      kind: 'infrastructure',
    });
    expect(unsafe.manager.kill).toHaveBeenCalledWith('system-container');
    expect(unsafe.repository.closeSandboxRun).toHaveBeenCalledWith(
      'system-decision-1',
      expect.objectContaining({ outcome: 'failed', cleanupState: 'clean' }),
    );
  });

  it('cleans and reaps system sandboxes', async () => {
    const first = harness({ output: 'invalid' });
    await first.runner.run(input);
    expect(first.manager.kill).toHaveBeenCalledWith('system-container');
    const inferenceCalls = vi
      .mocked(first.manager.execInContainer)
      .mock.calls.filter(([, command]) => !['chmod', 'chown'].includes(command[0] ?? ''));
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

    const leaked = harness({ killFails: true });
    await leaked.runner.run(input);
    expect(leaked.repository.closeSandboxRun).toHaveBeenCalledWith(
      'system-decision-1',
      expect.objectContaining({ outcome: 'leaked', cleanupState: 'retryable' }),
    );
  });

  it('reaps a local network when a crash happened before container allocation', async () => {
    const crashed = harness();
    vi.mocked(crashed.repository.listActiveSandboxRuns).mockReturnValue([
      {
        id: 'network-only-run',
        decisionId: 'decision-old',
        backend: 'docker',
        containerId: null,
      },
    ]);

    await expect(crashed.runner.reapLeakedRuns()).resolves.toBe(1);

    expect(crashed.dockerNetworkManager.removeNetworkForPod).toHaveBeenCalledWith(
      'network-only-run',
    );
    expect(crashed.manager.kill).not.toHaveBeenCalled();
    expect(crashed.repository.closeSandboxRun).toHaveBeenCalledWith(
      'network-only-run',
      expect.objectContaining({
        outcome: 'cancelled',
        cleanupState: 'clean',
        failureCode: 'REAPED_NETWORK_AFTER_RESTART',
      }),
    );
  });

  it('records the allocated identity before spawn can finish', async () => {
    const created = harness({ spawnFailsAfterCreate: true });

    await expect(created.runner.run(input)).resolves.toMatchObject({
      ok: false,
      kind: 'infrastructure',
    });
    expect(created.repository.setSandboxContainer).toHaveBeenCalledWith(
      'system-decision-1',
      'system-container',
    );
    expect(created.manager.kill).toHaveBeenCalledWith('system-container');
  });

  it('returns a typed sanitized failure when run creation fails', async () => {
    const duplicate = harness({ createRunFails: true });

    const result = await duplicate.runner.run(input);

    expect(result).toMatchObject({
      ok: false,
      kind: 'infrastructure',
      failure: { code: 'SYSTEM_SANDBOX_FAILED' },
      cleanup: 'clean',
    });
    expect(JSON.stringify(result)).not.toContain('repository-token');
    expect(duplicate.manager.spawn).not.toHaveBeenCalled();
    expect(duplicate.repository.closeSandboxRun).not.toHaveBeenCalled();
  });

  it('fails durably when OAuth credential readback cannot be persisted', async () => {
    const oauth = harness({
      output: JSON.stringify({ item: { text: JSON.stringify(decision) } }),
    });
    vi.mocked(oauth.providerAccountStore.get).mockReturnValue({
      id: 'openai-decision',
      name: 'OpenAI decision',
      provider: 'openai',
      credentials: {
        provider: 'openai',
        authMode: 'chatgpt',
        authJson: '{"tokens":{"access_token":"issued"}}',
      },
      failoverPolicy: null,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      lastAuthenticatedAt: new Date(0).toISOString(),
      lastUsedAt: null,
    });

    const result = await oauth.runner.run({
      ...input,
      providerAccountId: 'openai-decision',
      runtime: 'codex',
    });

    expect(result).toMatchObject({
      ok: false,
      kind: 'infrastructure',
      failure: { code: 'CREDENTIAL_PERSISTENCE_FAILED' },
    });
    expect(oauth.repository.closeSandboxRun).toHaveBeenCalledWith(
      'system-decision-1',
      expect.objectContaining({
        outcome: 'failed',
        failureCode: 'CREDENTIAL_PERSISTENCE_FAILED',
      }),
    );
  });

  it('bounds credential readback and proceeds to sandbox teardown', async () => {
    const oauth = harness({
      output: JSON.stringify({ item: { text: JSON.stringify(decision) } }),
      readFileHangs: true,
    });
    vi.mocked(oauth.providerAccountStore.get).mockReturnValue({
      id: 'openai-decision',
      name: 'OpenAI decision',
      provider: 'openai',
      credentials: {
        provider: 'openai',
        authMode: 'chatgpt',
        authJson: '{"tokens":{"access_token":"issued"}}',
      },
      failoverPolicy: null,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      lastAuthenticatedAt: new Date(0).toISOString(),
      lastUsedAt: null,
    });

    const result = await oauth.runner.run({
      ...input,
      providerAccountId: 'openai-decision',
      runtime: 'codex',
    });

    expect(result).toMatchObject({
      ok: false,
      kind: 'infrastructure',
      failure: { code: 'CREDENTIAL_PERSISTENCE_FAILED' },
    });
    expect(oauth.manager.kill).toHaveBeenCalledWith('system-container');
    expect(oauth.repository.closeSandboxRun).toHaveBeenCalledWith(
      'system-decision-1',
      expect.objectContaining({
        outcome: 'failed',
        cleanupState: 'clean',
        failureCode: 'CREDENTIAL_PERSISTENCE_FAILED',
      }),
    );
  });

  it('classifies invalid configuration with stable sanitized codes', async () => {
    const invalid = harness();
    await expect(invalid.runner.run({ ...input, timeoutMs: 0 })).resolves.toMatchObject({
      ok: false,
      kind: 'configuration',
      failure: { code: 'DECISION_TIMEOUT_INVALID' },
    });

    const hosted = harness();
    const missingImageRunner = new SystemDecisionRunner({
      localContainerManager: hosted.manager,
      sandboxContainerManager: hosted.manager,
      providerAccountStore: hosted.providerAccountStore,
      repository: hosted.repository,
      dockerNetworkManager: hosted.dockerNetworkManager,
      logger: pino({ level: 'silent' }),
    });
    await expect(
      missingImageRunner.run({ ...input, executionTarget: 'sandbox' }),
    ).resolves.toMatchObject({
      ok: false,
      kind: 'configuration',
      failure: { code: 'SYSTEM_DECISION_IMAGE_MISSING' },
    });

    const nonAcrImageRunner = new SystemDecisionRunner({
      localContainerManager: hosted.manager,
      sandboxContainerManager: hosted.manager,
      providerAccountStore: hosted.providerAccountStore,
      repository: hosted.repository,
      logger: pino({ level: 'silent' }),
      hostedImage: 'registry.example.io/autopod/system-decision:2026.07.30',
    });
    await expect(
      nonAcrImageRunner.run({ ...input, executionTarget: 'sandbox' }),
    ).resolves.toMatchObject({
      ok: false,
      kind: 'configuration',
      failure: { code: 'SYSTEM_DECISION_IMAGE_MISSING' },
    });

    const mismatch = harness();
    await expect(mismatch.runner.run({ ...input, runtime: 'codex' })).resolves.toMatchObject({
      ok: false,
      kind: 'configuration',
      failure: { code: 'PROVIDER_ACCOUNT_RUNTIME_MISMATCH' },
    });

    const missingCredentials = harness();
    vi.mocked(missingCredentials.providerAccountStore.get).mockReturnValue({
      id: 'copilot-decision',
      name: 'Copilot decision',
      provider: 'copilot',
      credentials: null,
      failoverPolicy: null,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      lastAuthenticatedAt: null,
      lastUsedAt: null,
    });
    await expect(missingCredentials.runner.run(input)).resolves.toMatchObject({
      ok: false,
      kind: 'configuration',
      failure: { code: 'PROVIDER_ACCOUNT_CREDENTIALS_MISSING' },
    });

    const oversizedCopilot = harness();
    await expect(
      oversizedCopilot.runner.run({ ...input, prompt: 'x'.repeat(120 * 1024 + 1) }),
    ).resolves.toMatchObject({
      ok: false,
      kind: 'configuration',
      failure: { code: 'COPILOT_PROMPT_TOO_LARGE' },
    });
    expect(oversizedCopilot.manager.spawn).not.toHaveBeenCalled();
  });

  it('bounds sandbox provisioning with the run timeout', async () => {
    const hung = harness({ spawnHangs: true });

    await expect(hung.runner.run({ ...input, timeoutMs: 10 })).resolves.toMatchObject({
      ok: false,
      kind: 'timeout',
      failure: { code: 'TIMEOUT' },
    });
    expect(hung.repository.closeSandboxRun).toHaveBeenCalledWith(
      'system-decision-1',
      expect.objectContaining({ outcome: 'failed', failureCode: 'TIMEOUT' }),
    );
  });

  it('cleans a local network that finishes provisioning after the run timeout', async () => {
    let finishProvisioning:
      | ((value: { networkName: string; firewallScript: string }) => void)
      | undefined;
    const networkProvisioning = new Promise<{ networkName: string; firewallScript: string }>(
      (resolve) => {
        finishProvisioning = resolve;
      },
    );
    const late = harness({ networkProvisioning });

    await expect(late.runner.run({ ...input, timeoutMs: 10 })).resolves.toMatchObject({
      ok: false,
      kind: 'timeout',
      cleanup: 'leaked',
    });
    expect(late.repository.closeSandboxRun).toHaveBeenCalledWith(
      'system-decision-1',
      expect.objectContaining({ outcome: 'leaked', cleanupState: 'retryable' }),
    );

    finishProvisioning?.({
      networkName: 'autopod-system-decision-1',
      firewallScript: '#!/bin/sh\niptables -A OUTPUT -j REJECT',
    });
    await vi.waitFor(() => {
      expect(late.dockerNetworkManager.removeNetworkForPod).toHaveBeenCalledTimes(2);
      expect(late.repository.closeSandboxRun).toHaveBeenLastCalledWith(
        'system-decision-1',
        expect.objectContaining({ outcome: 'cancelled', cleanupState: 'clean' }),
      );
    });
  });

  it('bounds schema repair setup with the run timeout', async () => {
    const hung = harness({ output: 'invalid', repairWriteHangs: true });

    await expect(hung.runner.run({ ...input, timeoutMs: 20 })).resolves.toMatchObject({
      ok: false,
      kind: 'timeout',
      failure: { code: 'TIMEOUT' },
    });
    expect(hung.manager.kill).toHaveBeenCalledWith('system-container');
  });

  it('rejects Foundry endpoints outside public Azure provider domains', async () => {
    const foundry = harness();
    vi.mocked(foundry.providerAccountStore.get).mockReturnValue({
      id: 'foundry-decision',
      name: 'Foundry decision',
      provider: 'foundry',
      credentials: {
        provider: 'foundry',
        endpoint: 'https://127.0.0.1',
        projectId: 'project',
        apiKey: 'account-key',
        apiSurface: 'anthropic',
      },
      failoverPolicy: null,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      lastAuthenticatedAt: new Date(0).toISOString(),
      lastUsedAt: null,
    });

    await expect(
      foundry.runner.run({
        ...input,
        providerAccountId: 'foundry-decision',
        runtime: 'claude',
      }),
    ).resolves.toMatchObject({
      ok: false,
      kind: 'configuration',
      failure: { code: 'PROVIDER_ACCOUNT_ENDPOINT_INVALID' },
    });
    expect(foundry.manager.spawn).not.toHaveBeenCalled();
  });

  it('classifies provider limits without leaking secrets', async () => {
    const transient = harness({
      output: '',
      exitCode: 1,
    });
    vi.mocked(transient.manager.execInContainer).mockImplementation(async (_id, command) =>
      ['chmod', 'chown'].includes(command[0] ?? '')
        ? { stdout: '', stderr: '', exitCode: 0 }
        : {
            stdout: '',
            stderr: JSON.stringify({
              status: 429,
              code: 'rate_limit_exceeded',
              message: 'rate limit exceeded token=super-secret-token',
              retryAfter: '2026-07-30T12:00:00.000Z',
            }),
            exitCode: 1,
          },
    );
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

    const codexJsonl = harness();
    vi.mocked(codexJsonl.manager.execInContainer).mockImplementation(async (_id, command) =>
      ['chmod', 'chown'].includes(command[0] ?? '')
        ? { stdout: '', stderr: '', exitCode: 0 }
        : {
            stdout: '',
            stderr: [
              JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
              JSON.stringify({
                type: 'error',
                error: {
                  status: 429,
                  code: 'rate_limit_exceeded',
                  message: 'rate limit exceeded',
                  retry_after: '120',
                },
              }),
            ].join('\n'),
            exitCode: 1,
          },
    );
    vi.mocked(codexJsonl.providerAccountStore.get).mockReturnValue({
      id: 'openrouter-decision',
      name: 'OpenRouter decision',
      provider: 'openrouter',
      credentials: {
        provider: 'openrouter',
        apiKey: 'account-key',
      },
      failoverPolicy: null,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      lastAuthenticatedAt: new Date(0).toISOString(),
      lastUsedAt: null,
    });
    await expect(
      codexJsonl.runner.run({
        ...input,
        decisionId: 'decision-codex-jsonl',
        providerAccountId: 'openrouter-decision',
        runtime: 'codex',
      }),
    ).resolves.toMatchObject({
      ok: false,
      kind: 'provider',
      failure: { category: 'transient', retryAfter: '120' },
    });

    const piJsonl = harness();
    vi.mocked(piJsonl.providerAccountStore.get).mockReturnValue({
      id: 'pi-decision',
      name: 'Pi decision',
      provider: 'pi',
      credentials: {
        provider: 'pi',
        providerId: 'anthropic',
        credential: { type: 'oauth', access: 'issued' },
      },
      failoverPolicy: null,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      lastAuthenticatedAt: new Date(0).toISOString(),
      lastUsedAt: null,
    });
    vi.mocked(piJsonl.manager.readFile).mockResolvedValue(
      JSON.stringify({ anthropic: { type: 'oauth', access: 'issued' } }, null, 2),
    );
    vi.mocked(piJsonl.manager.execInContainer).mockImplementation(async (_id, command) =>
      ['chmod', 'chown'].includes(command[0] ?? '')
        ? { stdout: '', stderr: '', exitCode: 0 }
        : {
            stdout: '',
            stderr: [
              JSON.stringify({ type: 'session_started' }),
              JSON.stringify({
                type: 'provider_error',
                error: { code: 'authentication_error', message: 'authentication failed' },
              }),
            ].join('\n'),
            exitCode: 1,
          },
    );
    const piResult = await piJsonl.runner.run({
      ...input,
      decisionId: 'decision-pi-jsonl',
      providerAccountId: 'pi-decision',
      runtime: 'pi',
    });
    expect(piResult).toMatchObject({
      ok: false,
      kind: 'provider',
      failure: { category: 'auth' },
    });
  });
});
