import type { ConfigurationEntity, ConfigurationKind } from '@autopod/shared';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AutopodClient } from '../api/client.js';
import { registerConfigurationCommands, selectProfilePresets } from './configuration.js';

afterEach(() => vi.restoreAllMocks());
describe('configuration CLI', () => {
  const categories = [
    {
      name: 'environment',
      kind: 'environment',
      guidance: [
        'reusable runtimes, versions, tooling and sidecars',
        'not repository identity or repository install/build steps',
        'Repository setups own project prep/build/test commands',
      ],
    },
    {
      name: 'workflow',
      kind: 'workflow',
      guidance: [
        'reusable validation, output, approval, retry and budget policy',
        'not repository identity or a one-off task mission',
        'Preserve genuinely different safety/policy variants',
      ],
    },
    {
      name: 'tool-pack',
      kind: 'toolPack',
      guidance: [
        'skills, MCP connections, CLI tools and their usage guidance',
        'Instruction-only reusable safety packs are legitimate',
        'Repository product rules and safety conventions belong in source-controlled AGENTS.md, CLAUDE.md or linked canonical docs',
        'task-specific mission and acceptance belong in the task brief/spec',
      ],
    },
  ] as const;

  for (const category of categories) {
    for (const action of ['', 'create', 'update']) {
      it(`renders standalone ${category.name} ${action || 'parent'} help without a client`, async () => {
        let rendered = '';
        const writeOut = vi.fn((text: string) => {
          rendered += text;
        });
        const writeErr = vi.fn();
        const getClient = vi.fn(() => {
          throw new Error('Help must not create a client or contact the daemon');
        });
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        const program = new Command().name('ap');
        // outputHelp emits addHelpText events; helpInformation alone omits them.
        program.configureOutput({ writeOut, writeErr }).exitOverride();
        registerConfigurationCommands(program, getClient);
        const args = ['preset', category.name, ...(action ? [action] : []), '--help'];
        await expect(program.parseAsync(args, { from: 'user' })).rejects.toMatchObject({
          code: 'commander.helpDisplayed',
          exitCode: 0,
        });
        expect(rendered).toContain('Usage: ap preset');
        for (const text of [
          'Reuse before creating',
          'inspect complete definitions and references before reuse or archival',
          'Create a new preset only for a reusable difference',
          'Name presets by capability, policy or stack rather than repository',
          'do not detach safety instructions until their source owner is on the intended default source',
          'Frozen launches and history remain unchanged',
          ...category.guidance,
        ]) {
          expect(rendered).toContain(text);
        }
        expect(getClient).not.toHaveBeenCalled();
        expect(writeOut).toHaveBeenCalled();
        expect(writeErr).not.toHaveBeenCalled();
        expect(log).not.toHaveBeenCalled();
      });
    }

    for (const path of ['category', 'general']) {
      it(`preserves ${category.name} ${path} JSON list output`, async () => {
        const entries = [{ id: 'preset-id', name: 'Reusable preset', revision: 2 }];
        const listConfigurations = vi.fn(async () => entries);
        const getClient = vi.fn(() => ({ listConfigurations }) as unknown as AutopodClient);
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        const writeOut = vi.fn();
        const program = new Command().configureOutput({ writeOut });
        registerConfigurationCommands(program, getClient);
        await program.parseAsync(
          path === 'category'
            ? ['preset', category.name, 'list', '--json']
            : ['preset', 'list', '--kind', category.name, '--json'],
          { from: 'user' },
        );
        expect(getClient).toHaveBeenCalledTimes(1);
        expect(listConfigurations).toHaveBeenCalledExactlyOnceWith(category.kind);
        expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify(entries, null, 2));
        expect(writeOut).not.toHaveBeenCalled();
      });
    }
  }

  it('preserves existing AI help', () => {
    let rendered = '';
    const program = new Command().configureOutput({
      writeOut: (text) => {
        rendered += text;
      },
    });
    const getClient = vi.fn();
    registerConfigurationCommands(program, getClient);
    program.commands
      .find((command) => command.name() === 'preset')
      ?.commands.find((command) => command.name() === 'ai')
      ?.outputHelp();
    expect(rendered).toContain('Advisor modes: follow-main, follow-reviewer');
    expect(rendered).toContain('Reviewer and Advisor share reviewerTokenBudget');
    expect(rendered).not.toContain('Reuse before creating');
    expect(getClient).not.toHaveBeenCalled();
  });

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
