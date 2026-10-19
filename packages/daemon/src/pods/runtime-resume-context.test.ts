import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  EffectiveLaunchConfig,
  InjectedMcpServer,
  McpServerConfig,
  Pod,
  ReasoningEffort,
  SpawnConfig,
  StdioInjectedMcpServer,
} from '@autopod/shared';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveLaunchCredentialReferences } from '../configuration/credential-references.js';
import { createConfigurationCredentialStore } from '../configuration/credential-store.js';
import {
  type LaunchExecutionCredentials,
  createLaunchExecutionCredentials,
} from '../configuration/execution-credentials.js';
import { resolveLaunch } from '../configuration/launch-resolver.js';
import { createLaunchSnapshotRepository } from '../configuration/launch-snapshot.js';
import { loadOrCreateKey } from '../crypto/credentials-cipher.js';
import { createPodTokenIssuer } from '../crypto/pod-tokens.js';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import { createTestConfiguration } from '../test-utils/configuration-helpers.js';
import {
  createMockProfileStore,
  createMockRuntime,
  createTestDb,
  insertTestProfile,
} from '../test-utils/mock-helpers.js';
import { createPodRepository } from './pod-repository.js';
import { createProviderAttemptRepository } from './provider-attempt-repository.js';
import { createRuntimeResumeContext } from './runtime-resume-context.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) close();
});
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((done) => {
    release = done;
  });
  return { promise, release };
}
async function fixture(kind: Pod['runtime'] = 'pi') {
  const db = createTestDb();
  cleanup.push(() => db.close());
  insertTestProfile(db);
  const profile: PodExecutionSettings = createMockProfileStore(db).get('test-profile');
  profile.mcpServers = [
    {
      name: 'shared / tool',
      type: 'http',
      url: 'https://profile.example.test',
      headers: { Authorization: 'remote-fixture' },
    },
    { name: 'stdio', type: 'stdio', command: 'local-tool' },
  ];
  const repo = createPodRepository(db);
  repo.insert({
    id: 'resume',
    profileName: 'test-profile',
    task: 'Prepare resume',
    status: 'running',
    runtime: kind,
    model: 'fixture-model',
    executionTarget: 'local',
    branch: 'autopod/resume',
    userId: 'operator',
    maxValidationAttempts: 3,
    skipValidation: false,
    outputMode: 'pr',
  });
  repo.update('resume', {
    containerId: 'pod-container',
    piSessionId: 'pi-session',
    claudeSessionId: 'claude-session',
  });
  const pod = repo.getOrThrow('resume');
  const { services } = createTestConfiguration(db);
  const config = await resolveLaunch({ repositoryId: 'repo-a', task: 'Prepare resume' }, services);
  const events: string[] = [];
  const runtime = {
    ...createMockRuntime(),
    setPiSessionId: vi.fn((_id: string, _session: string) => {
      events.push('pi-session');
    }),
    setPiResumeConfig: vi.fn((_config: SpawnConfig) => {
      events.push('pi-config');
    }),
    setClaudeSessionId: vi.fn((_id: string, _session: string) => {
      events.push('claude-session');
    }),
    setClaudeResumeConfig: vi.fn(
      (_id: string, _mcp: McpServerConfig[], _reason: ReasoningEffort) => {
        events.push('claude-config');
      },
    ),
    setCodexResumeConfig: vi.fn(
      (_id: string, _mcp: McpServerConfig[], _reason: ReasoningEffort) => {
        events.push('codex-config');
      },
    ),
  };
  runtime.type = kind;
  const material: { buildEnv: Record<string, string>; mcpServers: InjectedMcpServer[] } = {
    buildEnv: { MATERIAL_ONLY: 'not-worker-env' },
    mcpServers: profile.mcpServers,
  };
  const agent = vi.fn<LaunchExecutionCredentials['agent']>(async () => {
    events.push('agent');
    return material;
  });
  const adapter: LaunchExecutionCredentials = {
    agent,
    buildEnvironment: async () => ({}),
    deployment: async () => null,
    httpServer: async () => {
      throw new Error('Unused HTTP boundary');
    },
    registries: async () => ({ files: [], nugetSecret: null }),
  };
  const service = {
    read: vi.fn((_id: string): EffectiveLaunchConfig | null => {
      events.push('read');
      return config;
    }),
    assertCurrentCapabilities: vi.fn(async (_cfg: EffectiveLaunchConfig) => {
      events.push('check');
    }),
  };
  const issuer = {
    generate: vi.fn((_id: string) => {
      events.push('token');
      return 'pod-token';
    }),
  };
  const live: Parameters<typeof createRuntimeResumeContext>[0] = {
    launchConfiguration: service,
    sessionTokenIssuer: issuer,
  };
  const execution = vi.fn((_pod: Pod): PodExecutionSettings => {
    events.push('profile');
    return profile;
  });
  const resolve = vi.fn(
    (_launch: EffectiveLaunchConfig): LaunchExecutionCredentials | undefined => {
      events.push('resolve');
      return adapter;
    },
  );
  const daemon: { mcpServers: InjectedMcpServer[] } = {
    mcpServers: [
      { name: 'shared / tool', url: 'https://daemon.example.test' },
      { name: 'daemon-only', url: 'https://other.example.test' },
    ],
  };
  const injections = vi.fn((_pod: Pod) => {
    events.push('injections');
    return daemon;
  });
  const intel = vi.fn((_profile: PodExecutionSettings): StdioInjectedMcpServer[] => {
    events.push('intel');
    return [{ type: 'stdio', name: 'intel', command: 'intel-tool' }];
  });
  const reason = vi.fn(
    (
      _profile: PodExecutionSettings,
      _snapshot?: Record<string, unknown> | null,
    ): ReasoningEffort => {
      events.push('reason');
      return 'xhigh';
    },
  );
  const captured = {
    executionForPod: execution,
    executionCredentialsFor: resolve,
    injectionsForPod: injections,
    mcpBaseUrl: 'http://daemon:3100',
    buildCodeIntelligenceServers: intel,
    resolvedReasoningEffort: reason,
  };
  const op = createRuntimeResumeContext(live, captured);
  const env = { WORKER_ENV: 'retained' };
  return {
    db,
    repo,
    pod,
    profile,
    config,
    runtime,
    material,
    agent,
    adapter,
    service,
    issuer,
    live,
    execution,
    resolve,
    daemon,
    injections,
    intel,
    reason,
    captured,
    events,
    env,
    run: (input: Record<string, string> | undefined = env) =>
      op.primeRuntimeForResume(pod, runtime, 'argument-container', input),
  };
}

describe('runtime resume context contracts', () => {
  it('constructs without work; preserves full order and returns the exact array passed to Pi', async () => {
    const f = await fixture();
    expect(f.events).toEqual([]);
    expect(Object.keys(createRuntimeResumeContext(f.live, f.captured))).toEqual([
      'primeRuntimeForResume',
    ]);
    const list = await f.run();
    expect(f.events).toEqual([
      'profile',
      'read',
      'check',
      'resolve',
      'agent',
      'token',
      'injections',
      'intel',
      'check',
      'reason',
      'pi-session',
      'pi-config',
    ]);
    expect(f.execution).toHaveBeenCalledWith(f.pod);
    expect(f.service.read).toHaveBeenCalledWith('resume');
    expect(f.resolve).toHaveBeenCalledWith(f.config);
    expect(f.agent).toHaveBeenCalledWith(f.config);
    expect(f.runtime.setPiResumeConfig).toHaveBeenCalledWith({
      podId: 'resume',
      task: '',
      model: 'fixture-model',
      reasoningEffort: 'xhigh',
      workDir: '/workspace',
      containerId: 'argument-container',
      customInstructions: 'resume',
      env: f.env,
      mcpServers: list,
    });
    expect(f.runtime.setPiResumeConfig.mock.calls[0]?.[0].env).toBe(f.env);
    expect(f.runtime.setPiResumeConfig.mock.calls[0]?.[0].mcpServers).toBe(list);
    expect(f.reason).toHaveBeenCalledWith(
      expect.objectContaining({ buildEnv: f.material.buildEnv }),
      f.pod.profileSnapshot,
    );
    expect(f.runtime.spawn).not.toHaveBeenCalled();
    expect(f.runtime.resume).not.toHaveBeenCalled();
    expect(f.runtime.abort).not.toHaveBeenCalled();
  });

  it.each(['absent', 'empty', 'present'] as const)(
    'preserves %s token headers, shared header identity and encoded proxy names',
    async (token) => {
      const f = await fixture();
      if (token === 'absent') f.live.sessionTokenIssuer = undefined;
      if (token === 'empty') f.issuer.generate.mockReturnValue('');
      const list = await f.run();
      expect(list.slice(0, 3)).toEqual([
        {
          type: 'http',
          name: 'escalation',
          url: 'http://daemon:3100/mcp/resume',
          headers: token === 'present' ? { Authorization: 'Bearer pod-token' } : undefined,
        },
        {
          type: 'http',
          name: 'shared / tool',
          url: 'http://daemon:3100/mcp-proxy/shared%20%2F%20tool/resume',
          headers: token === 'present' ? { Authorization: 'Bearer pod-token' } : undefined,
        },
        {
          type: 'http',
          name: 'daemon-only',
          url: 'http://daemon:3100/mcp-proxy/daemon-only/resume',
          headers: token === 'present' ? { Authorization: 'Bearer pod-token' } : undefined,
        },
      ]);
      expect(JSON.stringify(list)).not.toContain('remote-fixture');
      expect(JSON.stringify(list)).not.toContain('profile.example.test');
      const headers = list
        .slice(0, 3)
        .map((server) => ('headers' in server ? server.headers : undefined));
      expect(headers[1]).toBe(headers[0]);
      expect(headers[2]).toBe(headers[0]);
      expect(list.slice(0, 3).every((server) => Object.hasOwn(server, 'headers'))).toBe(true);
    },
  );

  it.each([true, false])(
    'keeps legacy/launch stdio inclusion launch=%s and exact property presence',
    async (launch) => {
      const f = await fixture();
      if (!launch) f.live.launchConfiguration = undefined;
      f.intel.mockReturnValue([
        { type: 'stdio', name: 'intel', command: 'intel-tool' },
        { type: 'stdio', name: 'with-values', command: 'local', args: [], env: {} },
      ]);
      const list = await f.run();
      const locals = list.filter((server) => server.type === 'stdio');
      expect(locals).toEqual([
        { type: 'stdio', name: 'intel', command: 'intel-tool' },
        { type: 'stdio', name: 'with-values', command: 'local', args: [], env: {} },
        ...(launch
          ? [
              {
                type: 'stdio',
                name: 'stdio',
                command: 'local-tool',
                args: undefined,
                env: undefined,
              },
            ]
          : []),
      ]);
      expect(Object.hasOwn(locals[0] ?? {}, 'args')).toBe(false);
      expect(Object.hasOwn(locals[0] ?? {}, 'env')).toBe(false);
      expect(f.service.assertCurrentCapabilities).toHaveBeenCalledTimes(launch ? 2 : 0);
      expect(f.resolve).toHaveBeenCalledTimes(launch ? 1 : 0);
    },
  );

  it('preserves name overrides, insertion order and cross-category collisions without mutating inputs', async () => {
    const f = await fixture();
    f.profile.mcpServers.push(
      { name: 'escalation', url: 'https://duplicate.example.test' },
      { name: 'intel', type: 'stdio', command: 'configured-intel' },
    );
    const before = JSON.stringify([f.daemon, f.profile, f.material]);
    const list = await f.run();
    expect(list.map((server) => server.name)).toEqual([
      'escalation',
      'shared / tool',
      'daemon-only',
      'escalation',
      'intel',
      'stdio',
      'intel',
    ]);
    expect(JSON.stringify([f.daemon, f.profile, f.material])).toBe(before);
  });

  it('no material retains initial profile and undefined Pi env becomes a new empty object', async () => {
    const f = await fixture();
    f.resolve.mockReturnValue(undefined);
    const op = createRuntimeResumeContext(f.live, f.captured);
    await op.primeRuntimeForResume(f.pod, f.runtime, 'container', undefined);
    expect(f.reason.mock.calls[0]?.[0]).toBe(f.profile);
    expect(f.runtime.setPiResumeConfig.mock.calls[0]?.[0].env).toEqual({});
    expect(f.agent).not.toHaveBeenCalled();
  });

  it('rejects native Goal before capability/material/token/setter work', async () => {
    const f = await fixture();
    f.config.intent = 'goal';
    await expect(f.run()).rejects.toMatchObject({
      code: 'GOAL_NATIVE_RESUME_REQUIRED',
      statusCode: 409,
      message: 'Resume this Goal through its native controls',
    });
    expect(f.events).toEqual(['profile', 'read']);
  });

  it.each([
    'profile',
    'read',
    'first check',
    'resolver',
    'agent',
    'token',
    'injections',
    'intel',
    'final check',
    'reason',
  ] as const)('propagates exact %s error at its current boundary', async (where) => {
    const f = await fixture();
    const error = new Error(`Controlled ${where}`);
    if (where === 'profile')
      f.execution.mockImplementation(() => {
        throw error;
      });
    if (where === 'read')
      f.service.read.mockImplementation(() => {
        throw error;
      });
    if (where === 'first check') f.service.assertCurrentCapabilities.mockRejectedValueOnce(error);
    if (where === 'resolver')
      f.resolve.mockImplementation(() => {
        throw error;
      });
    if (where === 'agent') f.agent.mockRejectedValue(error);
    if (where === 'token')
      f.issuer.generate.mockImplementation(() => {
        throw error;
      });
    if (where === 'injections')
      f.injections.mockImplementation(() => {
        throw error;
      });
    if (where === 'intel')
      f.intel.mockImplementation(() => {
        throw error;
      });
    if (where === 'final check')
      f.service.assertCurrentCapabilities
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(error);
    if (where === 'reason')
      f.reason.mockImplementation(() => {
        throw error;
      });
    await expect(f.run()).rejects.toBe(error);
    expect(f.runtime.setPiSessionId).not.toHaveBeenCalled();
    expect(f.runtime.setPiResumeConfig).not.toHaveBeenCalled();
    if (where === 'final check' || where === 'reason')
      expect(f.issuer.generate).toHaveBeenCalledOnce();
  });

  it.each(
    (['pi', 'claude', 'codex', 'copilot'] as const).flatMap((kind) =>
      (['session', '', null] as const).map((session) => ({ kind, session })),
    ),
  )('restores $kind with session=$session using existing setters', async ({ kind, session }) => {
    const f = await fixture(kind);
    f.pod.piSessionId = session;
    f.pod.claudeSessionId = session;
    const list = await f.run();
    expect(f.runtime.setPiSessionId).toHaveBeenCalledTimes(kind === 'pi' && session ? 1 : 0);
    expect(f.runtime.setClaudeSessionId).toHaveBeenCalledTimes(
      kind === 'claude' && session ? 1 : 0,
    );
    expect(f.runtime.setPiResumeConfig).toHaveBeenCalledTimes(kind === 'pi' ? 1 : 0);
    expect(f.runtime.setClaudeResumeConfig).toHaveBeenCalledTimes(kind === 'claude' ? 1 : 0);
    expect(f.runtime.setCodexResumeConfig).toHaveBeenCalledTimes(kind === 'codex' ? 1 : 0);
    if (kind === 'claude')
      expect(f.runtime.setClaudeResumeConfig).toHaveBeenCalledWith(f.pod.id, list, 'xhigh');
    if (kind === 'codex')
      expect(f.runtime.setCodexResumeConfig).toHaveBeenCalledWith(f.pod.id, list, 'xhigh');
  });

  it.each(['claude', 'codex'] as const)(
    'returns config when guarded %s setter is absent',
    async (kind) => {
      const f = await fixture(kind);
      const {
        setClaudeResumeConfig: _claude,
        setCodexResumeConfig: _codex,
        ...runtime
      } = f.runtime;
      const list = await createRuntimeResumeContext(f.live, f.captured).primeRuntimeForResume(
        f.pod,
        runtime,
        'container',
        f.env,
      );
      expect(list.length).toBeGreaterThan(0);
      expect(f.runtime.setClaudeSessionId).not.toHaveBeenCalled();
    },
  );

  it.each(['pi', 'claude'] as const)(
    'retains earlier %s session restore when config setter throws',
    async (kind) => {
      const f = await fixture(kind);
      const error = new Error('Controlled setter');
      if (kind === 'pi')
        f.runtime.setPiResumeConfig.mockImplementation(() => {
          throw error;
        });
      else
        f.runtime.setClaudeResumeConfig.mockImplementation(() => {
          throw error;
        });
      await expect(f.run()).rejects.toBe(error);
      expect(
        kind === 'pi' ? f.runtime.setPiSessionId : f.runtime.setClaudeSessionId,
      ).toHaveBeenCalledOnce();
    },
  );

  it.each(['pi', 'claude'] as const)(
    'keeps unchecked %s missing-session-setter failure',
    async (kind) => {
      const f = await fixture(kind);
      const { setPiSessionId: _pi, setClaudeSessionId: _claude, ...runtime } = f.runtime;
      await expect(
        createRuntimeResumeContext(f.live, f.captured).primeRuntimeForResume(
          f.pod,
          runtime,
          'container',
          f.env,
        ),
      ).rejects.toBeInstanceOf(TypeError);
      expect(f.runtime.setPiResumeConfig).not.toHaveBeenCalled();
      expect(f.runtime.setClaudeResumeConfig).not.toHaveBeenCalled();
    },
  );

  it('Pi config setter remains mandatory even with absent session id', async () => {
    const f = await fixture();
    f.pod.piSessionId = null;
    const { setPiResumeConfig: _setter, ...runtime } = f.runtime;
    await expect(
      createRuntimeResumeContext(f.live, f.captured).primeRuntimeForResume(
        f.pod,
        runtime,
        'container',
        f.env,
      ),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it.each(['first check', 'agent'] as const)(
    'observes live launch and issuer replacement/removal across held %s',
    async (stage) => {
      for (const remove of [false, true]) {
        const f = await fixture();
        const hold = gate();
        const entered = gate();
        if (stage === 'first check')
          f.service.assertCurrentCapabilities.mockImplementationOnce(async () => {
            entered.release();
            await hold.promise;
          });
        else
          f.agent.mockImplementationOnce(async () => {
            entered.release();
            await hold.promise;
            return f.material;
          });
        const next = {
          read: vi.fn(() => {
            throw new Error('Unexpected reread');
          }),
          assertCurrentCapabilities: vi.fn(async function (
            this: unknown,
            cfg: EffectiveLaunchConfig,
          ) {
            expect(this).toBe(next);
            expect(cfg).toBe(f.config);
          }),
        };
        const issuer = {
          generate: vi.fn(function (this: unknown, id: string) {
            expect(this).toBe(issuer);
            expect(id).toBe(f.pod.id);
            return 'late-token';
          }),
        };
        let operation: ReturnType<typeof f.run> | undefined;
        try {
          operation = f.run();
          await entered.promise;
          f.live.launchConfiguration = remove ? undefined : next;
          f.live.sessionTokenIssuer = remove ? undefined : issuer;
          hold.release();
          const list = await operation;
          expect(f.service.read).toHaveBeenCalledOnce();
          expect(next.read).not.toHaveBeenCalled();
          expect(next.assertCurrentCapabilities).toHaveBeenCalledTimes(remove ? 0 : 1);
          expect(f.issuer.generate).not.toHaveBeenCalled();
          expect(list[0]).toMatchObject({
            headers: remove ? undefined : { Authorization: 'Bearer late-token' },
          });
        } finally {
          hold.release();
          await operation?.catch(() => {});
        }
      }
    },
  );

  it('holds the initial profile but reads current pod/snapshot/late collaborators after awaited material', async () => {
    const f = await fixture();
    const hold = gate();
    f.agent.mockImplementationOnce(async () => {
      await hold.promise;
      return f.material;
    });
    const replacement = vi.fn(
      (_p: PodExecutionSettings, _s?: Record<string, unknown> | null): ReasoningEffort => 'low',
    );
    let operation: ReturnType<typeof f.run> | undefined;
    try {
      operation = f.run();
      await vi.waitFor(() => expect(f.agent).toHaveBeenCalledOnce());
      f.execution.mockReturnValue({ ...f.profile, name: 'other-profile' });
      f.profile.name = 'mutated-original';
      f.pod.model = 'late-model';
      f.pod.profileSnapshot = {
        ...createMockProfileStore(f.db).get('test-profile'),
        reasoningEffort: 'low',
      };
      f.runtime.setPiResumeConfig.mockImplementation((config) => {
        expect(config.model).toBe('late-model');
      });
      // Replacing a property on the captured wrapper must not replace the captured function.
      f.captured.resolvedReasoningEffort = replacement;
      f.captured.mcpBaseUrl = 'http://other';
      hold.release();
      const list = await operation;
      expect(f.execution).toHaveBeenCalledOnce();
      expect(f.reason).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'mutated-original' }),
        f.pod.profileSnapshot,
      );
      expect(replacement).not.toHaveBeenCalled();
      expect(list[0]).toMatchObject({ url: 'http://daemon:3100/mcp/resume' });
    } finally {
      hold.release();
      await operation?.catch(() => {});
    }
  });
});

async function persistedFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-resume-context-'));
  const file = path.join(root, 'state.db');
  const seed = createTestDb();
  try {
    insertTestProfile(seed);
    fs.writeFileSync(file, seed.serialize());
  } finally {
    seed.close();
  }
  let db = new Database(file);
  db.pragma('foreign_keys = ON');
  cleanup.push(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const key = path.join(root, 'fixture.key');
  const credentials = createConfigurationCredentialStore(db, loadOrCreateKey(key), async () => {});
  const issuer = createPodTokenIssuer(key);
  for (const id of ['stdio', 'other'])
    await credentials.create({
      id,
      name: id,
      purposes: ['mcp-env'],
      origins: [],
      value: `private-${id}-fixture`,
    });
  const { store, services } = createTestConfiguration(db);
  services.resolveCredentialReferences = async (cfg) =>
    resolveLaunchCredentialReferences(cfg, credentials);
  const config = await resolveLaunch(
    {
      repositoryId: 'repo-a',
      task: 'Persisted resume',
      overrides: {
        toolPacks: [
          {
            mcpServers: [
              {
                name: 'stdio',
                transport: {
                  type: 'stdio',
                  command: 'fixture-local',
                  args: [],
                  env: { SERVICE_TOKEN: { secretId: 'stdio' } },
                },
              },
            ],
          },
        ],
      },
    },
    services,
  );
  const repo = createPodRepository(db);
  const snapshots = createLaunchSnapshotRepository(db, store);
  snapshots.admit({
    config,
    requestDigest: 'fixture',
    createPod: () => {
      repo.insert({
        id: 'durable-resume',
        profileName: 'test-profile',
        task: config.task,
        status: 'running',
        runtime: 'pi',
        model: 'fixture-model',
        executionTarget: 'local',
        branch: 'autopod/resume',
        userId: 'operator',
        maxValidationAttempts: 3,
        skipValidation: false,
        outputMode: 'pr',
      });
      return 'durable-resume';
    },
  });
  const snapshot = { modelProvider: 'anthropic' };
  const hash = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex').slice(0, 16);
  createProviderAttemptRepository(db).open({
    podId: 'durable-resume',
    provider: 'anthropic',
    providerAccountId: null,
    runtime: 'pi',
    model: 'fixture-model',
    profileReference: `pod:durable-resume@profile-snapshot#${hash}`,
    profileSnapshot: snapshot,
  });
  const pod = repo.getOrThrow('durable-resume');
  const profile = createMockProfileStore(db).get('test-profile');
  const runtime = {
    ...createMockRuntime(),
    type: 'pi' as const,
    setPiSessionId: vi.fn(),
    setPiResumeConfig: vi.fn<(config: SpawnConfig) => void>(),
  };
  const adapter = createLaunchExecutionCredentials(credentials);
  const check = vi.fn(async () => {});
  const op = createRuntimeResumeContext(
    {
      launchConfiguration: { read: snapshots.get, assertCurrentCapabilities: check },
      sessionTokenIssuer: issuer,
    },
    {
      executionForPod: () => profile,
      executionCredentialsFor: () => adapter,
      injectionsForPod: () => ({ mcpServers: [] }),
      mcpBaseUrl: 'http://daemon',
      buildCodeIntelligenceServers: () => [],
      resolvedReasoningEffort: () => 'auto',
    },
  );
  const rows = () => ({
    credentials: db.prepare('SELECT * FROM configuration_credentials ORDER BY id').all(),
    profiles: db.prepare('SELECT * FROM profiles ORDER BY name').all(),
    pods: db.prepare('SELECT * FROM pods ORDER BY id').all(),
    attempts: db.prepare('SELECT * FROM provider_attempts ORDER BY pod_id,ordinal').all(),
    snapshots: db.prepare('SELECT * FROM pod_launch_snapshots ORDER BY pod_id').all(),
  });
  return {
    db,
    credentials,
    issuer,
    pod,
    runtime,
    check,
    rows,
    snapshots,
    run: () => op.primeRuntimeForResume(pod, runtime, 'container', { WORKER: 'retained' }),
    reopen() {
      db.close();
      db = new Database(file);
      db.pragma('foreign_keys = ON');
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      return rows();
    },
  };
}

describe('runtime resume context local credential and token integration', () => {
  it('uses a real pod token, resolves rotated scoped stdio env and leaves durable state unchanged through reopen', async () => {
    const f = await persistedFixture();
    const initial = f.rows();
    expect(initial.attempts).toHaveLength(1);
    const list = await f.run();
    const first = list[0];
    if (!first || !('headers' in first)) throw new Error('Missing escalation header');
    expect(f.issuer.verify(first.headers?.Authorization?.slice(7) ?? '')).toBe(f.pod.id);
    expect(list[1]).toMatchObject({
      type: 'stdio',
      env: { SERVICE_TOKEN: 'private-stdio-fixture' },
    });
    expect(f.rows()).toEqual(initial);
    await f.credentials.rotate('stdio', 1, 'rotated-stdio-fixture');
    const rotated = f.rows();
    const next = await f.run();
    expect(next[1]).toMatchObject({ env: { SERVICE_TOKEN: 'rotated-stdio-fixture' } });
    expect(f.rows()).toEqual(rotated);
    expect(rotated.profiles).toEqual(initial.profiles);
    expect(rotated.pods).toEqual(initial.pods);
    expect(rotated.attempts).toEqual(initial.attempts);
    expect(rotated.snapshots).toEqual(initial.snapshots);
    expect(JSON.stringify(rotated.snapshots)).not.toContain('private-');
    const other = (value: typeof initial) =>
      value.credentials.filter((row) => (row as { id: string }).id === 'other');
    expect(other(rotated)).toEqual(other(initial));
    expect(f.reopen()).toEqual(rotated);
  });
  it('revoked stdio credentials reject before native setters and leave durable rows unchanged', async () => {
    const f = await persistedFixture();
    f.credentials.revoke('stdio', 1);
    const before = f.rows();
    await expect(f.run()).rejects.toMatchObject({ code: 'CONFIG_CREDENTIAL_REVOKED' });
    expect(f.runtime.setPiResumeConfig).not.toHaveBeenCalled();
    expect(f.check).toHaveBeenCalledOnce();
    expect(f.rows()).toEqual(before);
    expect(f.reopen()).toEqual(before);
  });
  it('retains issued token but performs no native setter on final capability rejection', async () => {
    const f = await persistedFixture();
    const generate = vi.spyOn(f.issuer, 'generate');
    const before = f.rows();
    const error = new Error('Late capability denial');
    f.check.mockResolvedValueOnce(undefined).mockRejectedValueOnce(error);
    await expect(f.run()).rejects.toBe(error);
    expect(generate).toHaveBeenCalledOnce();
    expect(f.runtime.setPiResumeConfig).not.toHaveBeenCalled();
    expect(f.rows()).toEqual(before);
    expect(f.reopen()).toEqual(before);
  });
});
