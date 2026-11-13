import { configurationHelpTopics, findConfigurationHelp } from '@autopod/shared';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerConfigurationCommands } from './configuration.js';

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const getClient = vi.fn(() => {
    throw new Error('Static help must stay offline');
  });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const program = new Command();
  registerConfigurationCommands(program, getClient);
  return { program, getClient, log };
}

describe('offline Tool-pack instruction explanations', () => {
  it('is discoverable and explains main-agent scope without creating an API client', async () => {
    const { program, getClient, log } = fixture();
    const pack = program.commands
      .find((c) => c.name() === 'preset')
      ?.commands.find((c) => c.name() === 'tool-pack');
    expect(pack?.helpInformation()).toContain('explain');
    await program.parseAsync(['preset', 'tool-pack', 'explain'], { from: 'user' });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('main agent'));
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('does not install software, grant access or enforce a rule'),
    );
    expect(getClient).not.toHaveBeenCalled();
  });

  it.each([
    'instructions',
    'instructions.heading',
    'instructions.content',
    'instructions[].heading',
    'instructions[0].content',
    'toolPack.instructions.content',
  ])('explains %s with canonical text', async (path) => {
    const { program, getClient, log } = fixture();
    await program.parseAsync(['preset', 'tool-pack', 'explain', path, '--json'], { from: 'user' });
    expect(JSON.parse(log.mock.calls[0]?.[0] as string)).toEqual(
      findConfigurationHelp(path, 'toolPack'),
    );
    expect(getClient).not.toHaveBeenCalled();
  });

  it('lists only Tool-pack topics and uses the real command name in recovery guidance', async () => {
    const { program, getClient, log } = fixture();
    await program.parseAsync(['preset', 'tool-pack', 'explain', '--list', '--json'], {
      from: 'user',
    });
    expect(JSON.parse(log.mock.calls[0]?.[0] as string)).toEqual(
      configurationHelpTopics.filter((topic) => topic.id.startsWith('toolPack.')),
    );
    await expect(
      program.parseAsync(['preset', 'tool-pack', 'explain', 'validation.build'], { from: 'user' }),
    ).rejects.toThrow('ap preset tool-pack explain --list');
    expect(getClient).not.toHaveBeenCalled();
  });
});

describe('offline Workflow validation explanations', () => {
  it('is discoverable and explains defaults without creating an API client', async () => {
    const { program, getClient, log } = fixture();
    const workflow = program.commands
      .find((c) => c.name() === 'preset')
      ?.commands.find((c) => c.name() === 'workflow');
    expect(workflow?.helpInformation()).toContain('explain');
    await program.parseAsync(['preset', 'workflow', 'explain'], { from: 'user' });
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('Missing required commands can block launch'),
    );
    expect(getClient).not.toHaveBeenCalled();
  });

  it.each([
    'validation.build',
    'workflow.validation.facts',
    'validation.review',
    'validation.advisory',
    'validationPhases',
    'advisoryBrowserQaEnabled',
    'maxValidationAttempts',
  ])('explains %s using canonical source mappings', async (path) => {
    const { program, getClient, log } = fixture();
    await program.parseAsync(['preset', 'workflow', 'explain', path, '--json'], { from: 'user' });
    expect(JSON.parse(log.mock.calls[0]?.[0] as string)).toEqual(
      findConfigurationHelp(path, 'workflow'),
    );
    expect(getClient).not.toHaveBeenCalled();
  });

  it('lists only Workflow topics and rejects AI paths with a recovery command', async () => {
    const { program, getClient, log } = fixture();
    await program.parseAsync(['preset', 'workflow', 'explain', '--list', '--json'], {
      from: 'user',
    });
    expect(JSON.parse(log.mock.calls[0]?.[0] as string)).toEqual(
      configurationHelpTopics.filter((topic) => topic.id.startsWith('workflow.')),
    );
    await expect(
      program.parseAsync(['preset', 'workflow', 'explain', 'main.maxHops'], { from: 'user' }),
    ).rejects.toThrow('ap preset workflow explain --list');
    expect(getClient).not.toHaveBeenCalled();
  });
});

describe('offline AI failover explanations', () => {
  it('is discoverable without changing existing show/payload flags', () => {
    const { program, getClient } = fixture();
    const ai = program.commands
      .find((c) => c.name() === 'preset')
      ?.commands.find((c) => c.name() === 'ai');
    expect(ai?.helpInformation()).toContain('explain');
    const show = ai?.commands.find((c) => c.name() === 'show');
    expect(show?.options.map((o) => o.long)).toEqual(['--json', '--payload', '--output']);
    expect(getClient).not.toHaveBeenCalled();
  });

  it('explains the area without constructing a daemon client', async () => {
    const { program, getClient, log } = fixture();
    await program.parseAsync(['preset', 'ai', 'explain'], { from: 'user' });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Off by default'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('different costs and data handling'));
    expect(getClient).not.toHaveBeenCalled();
  });

  it.each([
    'main.failover',
    'reviewer.route.failover',
    'advisor.route.failover',
    'main.maxHops',
    'main.failover[0].model',
  ])('returns canonical help for %s', async (path) => {
    const { program, getClient, log } = fixture();
    await program.parseAsync(['preset', 'ai', 'explain', path, '--json'], { from: 'user' });
    expect(JSON.parse(log.mock.calls[0]?.[0] as string)).toEqual(findConfigurationHelp(path));
    expect(getClient).not.toHaveBeenCalled();
  });

  it('lists the supported first-slice topics and paths', async () => {
    const { program, getClient, log } = fixture();
    await program.parseAsync(['preset', 'ai', 'explain', '--list', '--json'], { from: 'user' });
    expect(JSON.parse(log.mock.calls[0]?.[0] as string)).toEqual(
      configurationHelpTopics.filter((topic) => topic.id.startsWith('ai.')),
    );
    expect(getClient).not.toHaveBeenCalled();
  });

  it('gives a useful recovery command for unsupported fields without calling the daemon', async () => {
    const { program, getClient } = fixture();
    await expect(
      program.parseAsync(['preset', 'ai', 'explain', 'not-a-field'], { from: 'user' }),
    ).rejects.toThrow('ap preset ai explain --list');
    expect(getClient).not.toHaveBeenCalled();
  });
});
