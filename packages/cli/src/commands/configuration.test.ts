import type { ConfigurationEntity, ConfigurationKind } from '@autopod/shared';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AutopodClient } from '../api/client.js';
import { registerConfigurationCommands, selectProfilePresets } from './configuration.js';

afterEach(() => vi.restoreAllMocks());
describe('configuration CLI', () => {
  it('lists package feeds and tests the saved revision without any secret argument', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const entry = { id: 'feed', name: 'Company packages', revision: 3, archived: false };
    const listConfigurations = vi.fn(async () => [entry]);
    const getConfiguration = vi.fn(async () => entry);
    const testPackageFeed = vi.fn(async () => ({ status: 'authenticated' }));
    const program = new Command();
    registerConfigurationCommands(
      program,
      () => ({ listConfigurations, getConfiguration, testPackageFeed }) as unknown as AutopodClient,
    );
    await program.parseAsync(['package-feed', 'list', '--json'], { from: 'user' });
    expect(listConfigurations).toHaveBeenCalledWith('packageFeed');
    await program.parseAsync(['package-feed', 'test', 'Company packages'], { from: 'user' });
    expect(testPackageFeed).toHaveBeenCalledExactlyOnceWith('feed', 3);
    const rotate = program.commands
      .find((command) => command.name() === 'package-feed')
      ?.commands.find((command) => command.name() === 'credential')
      ?.commands.find((command) => command.name() === 'rotate');
    expect(rotate?.options.map((option) => option.long)).toEqual(['--expected-revision']);
  });
  it('keeps deployment requests separate from digest-bound operator approval', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const requestDeployment = vi.fn(async () => ({ state: 'awaiting_approval' }));
    const decideDeployment = vi.fn(async () => ({ state: 'completed' }));
    const client = { requestDeployment, decideDeployment } as unknown as AutopodClient;
    const program = new Command();
    registerConfigurationCommands(program, () => client);
    await program.parseAsync(
      ['deployment', 'request', 'pod', 'deploy.sh', '--key', 'once', '--args-json', '["--prod"]'],
      { from: 'user' },
    );
    expect(requestDeployment).toHaveBeenCalledExactlyOnceWith('pod', {
      operationKey: 'once',
      scriptPath: 'deploy.sh',
      args: ['--prod'],
    });
    expect(decideDeployment).not.toHaveBeenCalled();
    await program.parseAsync(['deployment', 'approve', 'run', '--digest', 'a'.repeat(64)], {
      from: 'user',
    });
    expect(decideDeployment).toHaveBeenCalledExactlyOnceWith('run', 'a'.repeat(64), 'approve');
  });
  it('creates a paused watcher using named repository and profile choices', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const writeWatcherBinding = vi.fn(async (value) => value);
    const listConfigurations = vi.fn(async (kind: string) => [
      {
        id: `${kind}-id`,
        name: kind === 'repository' ? 'My repo' : 'Development',
        archived: false,
      },
    ]);
    const program = new Command();
    registerConfigurationCommands(
      program,
      () => ({ listConfigurations, writeWatcherBinding }) as unknown as AutopodClient,
    );
    await program.parseAsync(
      ['watcher', 'create', 'Issue work', '--repo', 'My repo', '--profile', 'Development'],
      { from: 'user' },
    );
    expect(writeWatcherBinding).toHaveBeenCalledExactlyOnceWith({
      payload: {
        name: 'Issue work',
        enabled: false,
        labelPrefix: 'autopod',
        targets: {},
        launch: {
          repositoryId: 'repository-id',
          profileId: 'profile-id',
          referenceRepositories: [],
        },
      },
    });
  });
  it('lists preset choices without resolving a launch or activating access', async () => {
    const entry = { id: 'ai', name: 'Personal AI', revision: 4 };
    const listConfigurations = vi.fn(async () => [entry]);
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const program = new Command();
    registerConfigurationCommands(
      program,
      () => ({ listConfigurations }) as unknown as AutopodClient,
    );
    await program.parseAsync(['preset', 'list', '--kind', 'ai', '--json'], { from: 'user' });
    expect(listConfigurations).toHaveBeenCalledExactlyOnceWith('ai');
    expect(JSON.parse(output.mock.calls[0]?.[0] as string)).toEqual([entry]);
  });
  it('selects each category independently and supports explicitly no GitHub access plus several tool packs', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const listConfigurations = vi.fn(async (kind: ConfigurationKind) =>
      [1, 2].map(
        (n) =>
          ({
            id: `${kind}-${n}`,
            kind,
            name: `${kind} ${n}`,
            archived: false,
          }) as ConfigurationEntity,
      ),
    );
    const choices = ['0', '2', '1', '2', '', '1,2'];
    const result = await selectProfilePresets(
      { listConfigurations } as unknown as AutopodClient,
      async () => choices.shift() ?? '',
    );
    expect(result).toMatchObject({
      environmentId: 'environment-2',
      aiId: 'ai-1',
      workflowId: 'workflow-2',
      githubAccessId: null,
      toolPackIds: ['toolPack-1', 'toolPack-2'],
    });
    expect(listConfigurations.mock.calls.map(([kind]) => kind)).toEqual([
      'environment',
      'ai',
      'workflow',
      'githubAccess',
      'toolPack',
    ]);
  });
  it('refuses an unknown preset kind without contacting the daemon', async () => {
    const client = vi.fn();
    const program = new Command();
    registerConfigurationCommands(program, client);
    await expect(
      program.parseAsync(['preset', 'list', '--kind', 'parent'], { from: 'user' }),
    ).rejects.toThrow('Select a preset kind');
    expect(client).not.toHaveBeenCalled();
  });
});
