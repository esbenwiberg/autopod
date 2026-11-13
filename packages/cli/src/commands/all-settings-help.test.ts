import {
  configurationHelpKinds,
  configurationHelpTopics,
  findConfigurationHelp,
} from '@autopod/shared';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerConfigurationCommands } from './configuration.js';
import { registerProviderAccountCommands } from './provider-account.js';

function offline() {
  const program = new Command().exitOverride();
  const getClient = vi.fn((): never => {
    throw new Error('Help constructed an API client');
  });
  registerConfigurationCommands(program, getClient);
  registerProviderAccountCommands(program, getClient);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  return { program, getClient, result: () => String(log.mock.calls.at(-1)?.[0] ?? '') };
}
afterEach(() => vi.restoreAllMocks());

describe('all settings explained offline', () => {
  it.each([
    { kind: 'profile', args: ['profile'] },
    { kind: 'repository', args: ['repository'] },
    { kind: 'environment', args: ['preset', 'environment'] },
    { kind: 'githubAccess', args: ['preset', 'github-access'] },
    { kind: 'packageFeed', args: ['preset', 'package-feed'] },
    { kind: 'providerAccount', args: ['provider-account'] },
    { kind: 'watcher', args: ['watcher'] },
    { kind: 'deployment', args: ['deployment'] },
  ])('lists $kind fields without loading a daemon client', async ({ kind, args }) => {
    const app = offline();
    await app.program.parseAsync(['node', 'ap', ...args, 'explain', '--list', '--json']);
    expect(JSON.parse(app.result())).toEqual(
      configurationHelpTopics.filter((t) => t.id.startsWith(`${kind}.`)),
    );
    expect(app.getClient).not.toHaveBeenCalled();
  });
  it.each(
    configurationHelpKinds,
  )('explains the %s default through the root guide', async (kind) => {
    const app = offline();
    await app.program.parseAsync(['node', 'ap', 'explain', '--kind', kind, '--json']);
    expect(JSON.parse(app.result())).toEqual(findConfigurationHelp(undefined, kind));
    expect(app.getClient).not.toHaveBeenCalled();
  });
  it('explains actual map paths, choices and defaults as text', async () => {
    const app = offline();
    await app.program.parseAsync([
      'node',
      'ap',
      'profile',
      'explain',
      'execution.sidecars.database.memoryGb',
    ]);
    expect(app.result()).toContain('Memory');
    expect(app.result()).toContain('Default / off:');
    expect(app.getClient).not.toHaveBeenCalled();
  });
  it('rejects unsupported contexts offline', async () => {
    const app = offline();
    await expect(
      app.program.parseAsync(['node', 'ap', 'explain', '--kind', 'pretend']),
    ).rejects.toThrow('Choose --kind');
    expect(app.getClient).not.toHaveBeenCalled();
  });
});
