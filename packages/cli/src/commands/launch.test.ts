import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ConfigurationEntity,
  type EffectiveLaunchConfig,
  type LaunchRequest,
  configurationPayloadSchemas,
  launchRequestSchema,
} from '@autopod/shared';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AutopodClient } from '../api/client.js';
import { saveLaunchReceipt } from '../config/launch-store.js';
import { buildLaunchRequest } from './launch-request.js';
import { registerLaunchCommand } from './launch.js';

function entity(
  kind: ConfigurationEntity['kind'],
  id: string,
  name: string,
  payload: unknown,
): ConfigurationEntity {
  return {
    kind,
    id,
    name,
    payload: configurationPayloadSchemas[kind].parse(payload),
    revision: 1,
    createdAt: '2026-09-13T00:00:00Z',
    updatedAt: '2026-09-13T00:00:00Z',
    archived: false,
  } as ConfigurationEntity;
}
const entries = [
  entity('repository', 'repo', 'Project', {
    provider: 'github',
    remote: 'https://github.com/owner/project',
    setups: [{ id: 'web', name: 'Website' }],
    defaultSetupId: 'web',
  }),
  entity('ai', 'new-ai', 'Alternative AI', {
    main: { providerAccountId: 'new-account', runtime: 'codex', model: 'gpt-5.5' },
  }),
  entity('toolPack', 'one', 'First tools', {}),
  entity('toolPack', 'two', 'Second tools', {}),
  entity('environment', 'new-env', 'Other environment', { template: 'node22' }),
];
const lookup = vi.fn(async (kind: ConfigurationEntity['kind']) =>
  entries.filter((item) => item.kind === kind),
);
const folders: string[] = [];
function temporary() {
  const dir = mkdtempSync(join(tmpdir(), 'autopod-launch-cli-'));
  folders.push(dir);
  return dir;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

describe('shared launch request CLI', () => {
  it('describes source branches and the output branch truthfully', () => {
    const program = new Command();
    registerLaunchCommand(program, vi.fn());
    const help = program.commands[0]?.helpInformation();
    expect(help).toContain('published remote branch name');
    expect(help).toContain('Output branch');
    expect(help).not.toContain('branch or revision');
  });
  it.each(['startBranch', 'baseBranch'] as const)(
    'rejects invalid %s before preview or admission',
    async (field) => {
      for (const value of [
        'a'.repeat(40),
        'B'.repeat(64),
        'main~1',
        'main^',
        'main@{1}',
        'main..other',
      ]) {
        for (const preview of [false, true]) {
          for (const fileInput of [false, true]) {
            const client = {
              listConfigurations: lookup,
              resolveLaunch: vi.fn(),
              launchPod: vi.fn(),
            };
            const save = vi.fn();
            const log = vi.spyOn(console, 'log').mockImplementation(() => {});
            const program = new Command().exitOverride();
            registerLaunchCommand(program, () => client as unknown as AutopodClient, save);
            const file = join(temporary(), 'request.json');
            writeFileSync(
              file,
              JSON.stringify({ repositoryId: 'repo', task: 'Task', work: { [field]: value } }),
            );
            const args = fileInput
              ? ['--config', file]
              : [
                  '--repo',
                  'Project',
                  '--task',
                  'Task',
                  field === 'startBranch' ? '--start-branch' : '--base-branch',
                  value,
                ];
            await expect(
              program.parseAsync(['node', 'ap', 'run', ...args, ...(preview ? ['--preview'] : [])]),
            ).rejects.toThrow(`work.${field}`);
            expect(save).not.toHaveBeenCalled();
            expect(client.launchPod).not.toHaveBeenCalled();
            expect(client.resolveLaunch).not.toHaveBeenCalled();
            expect(log).not.toHaveBeenCalled();
          }
        }
      }
    },
  );
  it.each([false, true])('checks inherited effective sources (preview=%s)', async (preview) => {
    const client = {
      getPodLaunchConfiguration: vi.fn(async () => ({
        digest: 'a'.repeat(64),
        profileId: 'profile',
        task: 'Task',
        repository: { id: 'repo', setup: { id: 'web' } },
      })),
      resolveLaunch: vi.fn(async () => ({ work: { startBranch: 'a'.repeat(40) } })),
      launchPod: vi.fn(),
    };
    const save = vi.fn();
    const program = new Command().exitOverride();
    registerLaunchCommand(program, () => client as unknown as AutopodClient, save);
    await expect(
      program.parseAsync([
        'node',
        'ap',
        'run',
        '--from-pod',
        'parent',
        ...(preview ? ['--preview'] : []),
      ]),
    ).rejects.toThrow('work.startBranch');
    expect(save).not.toHaveBeenCalled();
    expect(client.launchPod).not.toHaveBeenCalled();
  });
  it('replays old exact SHA receipts unchanged without discovery', async () => {
    const request = {
      repositoryId: 'repo',
      task: 'Task',
      work: { startBranch: 'a'.repeat(40) },
      requestId: 'saved',
      expectedDigest: 'b'.repeat(64),
    };
    const file = join(temporary(), 'saved.json');
    const original = JSON.stringify(request);
    writeFileSync(file, original);
    const client = {
      resolveLaunch: vi.fn(),
      listConfigurations: vi.fn(),
      launchPod: vi.fn(async () => ({ id: 'test-pod' })),
    };
    const save = vi.fn(() => file);
    const program = new Command().exitOverride();
    registerLaunchCommand(program, () => client as unknown as AutopodClient, save);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await program.parseAsync(['node', 'ap', 'run', '--config', file]);
    expect(client.launchPod).toHaveBeenCalledWith(request);
    expect(client.resolveLaunch).not.toHaveBeenCalled();
    expect(client.listConfigurations).not.toHaveBeenCalled();
    expect(readFileSync(file, 'utf8')).toBe(original);
  });
  it('preserves reference SHA, output branch and task evidence on a valid launch', async () => {
    const sha = 'a'.repeat(40);
    const client = {
      listConfigurations: lookup,
      resolveLaunch: vi.fn(async (request: LaunchRequest) => ({
        ...request,
        digest: 'b'.repeat(64),
      })),
      launchPod: vi.fn(async () => ({ id: 'test-pod' })),
    };
    const program = new Command().exitOverride();
    const save = vi.fn(() => 'receipt.json');
    registerLaunchCommand(program, () => client as unknown as AutopodClient, save);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await program.parseAsync([
      'node',
      'ap',
      'run',
      '--repo',
      'Project',
      '--task',
      sha,
      '--reference',
      `Project=${sha}`,
      '--branch',
      sha,
      '--start-branch',
      'feature/prep.v2',
      '--base-branch',
      'release/v2',
      '--json',
    ]);
    expect(client.launchPod).toHaveBeenCalledWith(
      expect.objectContaining({
        task: sha,
        referenceRepositories: [{ repositoryId: 'repo', ref: sha, access: 'read' }],
        work: { branch: sha, startBranch: 'feature/prep.v2', baseBranch: 'release/v2' },
      }),
    );
    expect(save).toHaveBeenCalledOnce();
  });
  it('selects an original source snapshot without looking up mutable profile names', async () => {
    const client = {
      getPodLaunchConfiguration: vi.fn(async () => ({
        digest: 'a'.repeat(64),
        profileId: 'archived-profile',
        task: 'Original task',
        repository: { id: 'repo', setup: { id: 'web' } },
      })),
      listConfigurations: vi.fn(),
      resolveLaunch: vi.fn(async (request: LaunchRequest) => request),
      launchPod: vi.fn(),
    };
    const program = new Command().exitOverride();
    registerLaunchCommand(program, () => client as unknown as AutopodClient, vi.fn());
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await program.parseAsync([
      'node',
      'ap',
      'run',
      '--from-pod',
      'parent',
      '--task',
      'Follow-up',
      '--preview',
      '--json',
    ]);
    expect(client.resolveLaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        task: 'Follow-up',
        profileId: 'archived-profile',
        source: { podId: 'parent', digest: 'a'.repeat(64), configuration: 'original' },
      }),
    );
    expect(client.listConfigurations).not.toHaveBeenCalled();
    expect(client.launchPod).not.toHaveBeenCalled();
  });
  it('resolves research through the same configuration preview with artifact output', async () => {
    const client = {
      listConfigurations: lookup,
      resolveLaunch: vi.fn(async () => ({
        workflow: { output: 'artifact', completion: 'accept-findings' },
      })),
      launchPod: vi.fn(),
    };
    const program = new Command().exitOverride();
    registerLaunchCommand(program, () => client as unknown as AutopodClient, vi.fn(), {
      name: 'research',
      output: 'artifact',
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await program.parseAsync([
      'node',
      'ap',
      'research',
      '--repo',
      'Project',
      '--task',
      'Investigate',
      '--preview',
      '--json',
    ]);
    expect(client.resolveLaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryId: 'repo',
        overrides: { workflow: { output: 'artifact', completion: 'accept-findings' } },
      }),
    );
    expect(client.launchPod).not.toHaveBeenCalled();
  });
  it('builds an explicit repository history workspace through the shared schema', async () => {
    const client = {
      listConfigurations: lookup,
      resolveLaunch: vi.fn(async (request: LaunchRequest) => launchRequestSchema.parse(request)),
      launchPod: vi.fn(),
    };
    const program = new Command().exitOverride();
    registerLaunchCommand(program, () => client as unknown as AutopodClient, vi.fn(), {
      name: 'history',
      analysis: 'history',
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await program.parseAsync([
      'node',
      'ap',
      'history',
      '--repo',
      'Project',
      '--failures',
      '--limit',
      '200',
      '--preview',
      '--json',
    ]);
    expect(client.resolveLaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryId: 'repo',
        intent: 'task',
        work: {
          analysis: { kind: 'history', scope: 'repository', limit: 200, failuresOnly: true },
        },
        overrides: {
          workflow: expect.objectContaining({
            agentMode: 'interactive',
            output: 'branch',
            completion: 'approval',
          }),
        },
      }),
    );
    expect(client.launchPod).not.toHaveBeenCalled();
  });
  it('preserves the shared desktop launch fixture and absent optional categories on file replay', async () => {
    const fixture: unknown = JSON.parse(
      readFileSync(
        new URL('../../../shared/src/fixtures/composable-launch.json', import.meta.url),
        'utf8',
      ),
    );
    const noLookup = vi.fn();
    expect(await buildLaunchRequest({}, noLookup, fixture)).toEqual(fixture);
    const minimal = launchRequestSchema.parse({
      repositoryId: 'repo',
      task: 'Task',
      requestId: 'saved',
      expectedDigest: 'a'.repeat(64),
    });
    expect(await buildLaunchRequest({}, noLookup, minimal)).toEqual(minimal);
    expect(noLookup).not.toHaveBeenCalled();
  });
  it('resolves readable repository/setup names and leaves profile defaults to the daemon', async () => {
    const request = await buildLaunchRequest(
      { repo: 'Project', repositorySetup: 'Website', task: 'Debug' },
      lookup,
    );
    expect(request).toMatchObject({
      repositoryId: 'repo',
      repositorySetupId: 'web',
      task: 'Debug',
    });
    expect(request.profileId).toBeUndefined();
    expect(request.intent).toBeUndefined();
  });
  it('switches the complete AI category and explicitly clears selected access/tool packs', async () => {
    const request = await buildLaunchRequest(
      { ai: 'Alternative AI', githubAccess: false, toolPacks: false, overrideConfig: true },
      lookup,
      {
        repositoryId: 'repo',
        task: 'Debug',
        overrides: {
          ai: { main: { providerAccountId: 'old-account', runtime: 'claude', model: 'old-model' } },
          githubAccess: { rules: [] },
          toolPacks: [],
        },
      },
    );
    expect(request.selections).toEqual({ aiId: 'new-ai', githubAccessId: null, toolPackIds: [] });
    expect(request.overrides).toEqual({});
  });
  it('drops old environment sidecar choices on replacement and retains explicit new choices', async () => {
    const saved = { repositoryId: 'repo', task: 'Debug', requiredSidecarIds: ['old-db'] };
    const flags = { environment: 'Other environment', overrideConfig: true };
    const changed = await buildLaunchRequest(flags, lookup, saved);
    expect(changed.selections?.environmentId).toBe('new-env');
    expect(changed).not.toHaveProperty('requiredSidecarIds');
    expect(
      (await buildLaunchRequest({ ...flags, sidecar: ['new-db'] }, lookup, saved))
        .requiredSidecarIds,
    ).toEqual(['new-db']);
    expect(
      (await buildLaunchRequest({ ...flags, sidecars: false }, lookup, saved)).requiredSidecarIds,
    ).toEqual([]);
  });
  it('rejects implicit file precedence and accepts exact full JSON without lookups', async () => {
    await expect(
      buildLaunchRequest({ task: 'Other' }, lookup, { repositoryId: 'repo', task: 'Original' }),
    ).rejects.toThrow('--override-config');
    const noLookup = vi.fn();
    const request = await buildLaunchRequest({}, noLookup, {
      repositoryId: 'repo',
      task: 'Original',
      overrides: { pim: [], repositorySetup: { buildCommand: null } },
    });
    expect(request.overrides).toEqual({ pim: [], repositorySetup: { buildCommand: null } });
    expect(noLookup).not.toHaveBeenCalled();
  });
  it('parses repeated tool pack flags without implicit defaults and never admits a preview', async () => {
    const client = {
      listConfigurations: lookup,
      resolveLaunch: vi.fn(async (request: LaunchRequest) => ({
        digest: 'a'.repeat(64),
        ...request,
      })),
      launchPod: vi.fn(),
    };
    const save = vi.fn();
    const program = new Command().exitOverride();
    registerLaunchCommand(program, () => client as unknown as AutopodClient, save);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await program.parseAsync([
      'node',
      'ap',
      'run',
      '--repo',
      'Project',
      '--task',
      'Debug',
      '--tool-pack',
      'First tools',
      '--tool-pack',
      'Second tools',
      '--preview',
      '--json',
    ]);
    expect(client.resolveLaunch.mock.calls[0]?.[0].selections?.toolPackIds).toEqual(['one', 'two']);
    expect(client.launchPod).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
  it('rejects removed profile-first syntax before contacting the daemon', async () => {
    const getClient = vi.fn();
    const program = new Command().exitOverride();
    registerLaunchCommand(program, getClient);
    await expect(program.parseAsync(['node', 'ap', 'run', 'old-profile', 'Task'])).rejects.toThrow(
      'Profile-first',
    );
    expect(getClient).not.toHaveBeenCalled();
  });
  it('persists admission before sending and replays the exact request without mutable discovery', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const dir = temporary();
    const file = join(dir, 'input.json');
    writeFileSync(file, JSON.stringify({ repositoryId: 'repo', task: 'Debug' }));
    const resolve = vi.fn(async () => ({ digest: 'a'.repeat(64) }) as EffectiveLaunchConfig);
    let saved = '';
    const save = (request: LaunchRequest) => {
      saved = saveLaunchReceipt(request, dir);
      return saved;
    };
    const launch = vi.fn(async (request: LaunchRequest) => {
      expect(JSON.parse(readFileSync(saved, 'utf8'))).toEqual(request);
      throw new Error('Lost response');
    });
    const client = {
      resolveLaunch: resolve,
      launchPod: launch,
      listConfigurations: vi.fn(),
    } as unknown as AutopodClient;
    const first = new Command().exitOverride();
    registerLaunchCommand(first, () => client, save);
    await expect(
      first.parseAsync(['node', 'ap', 'run', '--config', file, '--json']),
    ).rejects.toThrow('Lost response');
    const second = new Command().exitOverride();
    registerLaunchCommand(second, () => client, save);
    await expect(
      second.parseAsync(['node', 'ap', 'run', '--config', saved, '--json']),
    ).rejects.toThrow('Lost response');
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[1]?.[0]).toEqual(launch.mock.calls[0]?.[0]);
    expect(statSync(saved).mode & 0o777).toBe(0o600);
  });
  it('refuses to overwrite a saved request key with a different payload', () => {
    const dir = temporary();
    const request = launchRequestSchema.parse({
      repositoryId: 'repo',
      task: 'Debug',
      requestId: 'fixed',
    });
    saveLaunchReceipt(request, dir);
    expect(() => saveLaunchReceipt({ ...request, task: 'Different' }, dir)).toThrow(
      'different request',
    );
  });
});
