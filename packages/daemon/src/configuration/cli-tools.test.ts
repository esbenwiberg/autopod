import { cliToolSchema } from '@autopod/shared';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTestConfiguration,
  insertConfigurationTestPod,
} from '../test-utils/configuration-helpers.js';
import { createTestDb } from '../test-utils/mock-helpers.js';
import { resolveLaunchExecutionSettings } from './launch-execution-settings.js';
import { resolveLaunch } from './launch-resolver.js';
import { createLaunchSnapshotRepository } from './launch-snapshot.js';

const cli = cliToolSchema.parse({
  name: 'lesson',
  description: 'Learn from a fix',
  instructions: 'lesson --issue text --fix HEAD',
  usage: 'discretionary',
  requiredCapabilities: ['node'],
  verifyArgs: ['--help'],
  source: { type: 'npm', package: '@example/lesson', version: '1.2.3', executable: 'lesson' },
});

describe('tool-pack CLI launch integration', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => db.close());

  it('selects, freezes, installs and advertises CLIs without editing the environment', async () => {
    const { services, store } = createTestConfiguration(db);
    store.write({ id: 'tools', kind: 'toolPack', name: 'Lessons', payload: { clis: [cli] } });
    const plain = await resolveLaunch({ repositoryId: 'repo-a', task: 'Fix' }, services);
    const config = await resolveLaunch(
      { repositoryId: 'repo-a', task: 'Fix', selections: { toolPackIds: ['tools'] } },
      services,
    );
    expect(config.environment).toEqual(plain.environment);
    expect(config.resolvedEnvironment.imageKey).not.toBe(plain.resolvedEnvironment.imageKey);
    expect(config.resolvedEnvironment.cliInstallCommands?.join('\n')).toContain(
      '@example/lesson@1.2.3',
    );
    expect(services.resolveEnvironment).toHaveBeenLastCalledWith(config.environment, 'local', [
      cli,
    ]);
    const snapshots = createLaunchSnapshotRepository(db, store);
    snapshots.admit({
      config,
      requestDigest: 'cli-request',
      createPod: () => insertConfigurationTestPod(db, 'cli-pod'),
    });
    const frozen = snapshots.get('cli-pod');
    expect(frozen).toEqual(config);
    if (!frozen) throw new Error('Missing snapshot');
    expect(
      resolveLaunchExecutionSettings(frozen, { image: 'sha256:image' }).customInstructions,
    ).toContain('## Available CLI tools');
    expect(
      resolveLaunchExecutionSettings(frozen, { image: 'sha256:image' }).customInstructions,
    ).toContain(cli.instructions);
    expect(
      resolveLaunchExecutionSettings(plain, { image: 'sha256:image' }).customInstructions,
    ).toBeNull();
  });
  it('honors request-local pack replacement/clearing and changes only launch identity for usage edits', async () => {
    const { services } = createTestConfiguration(db);
    const request = {
      repositoryId: 'repo-a',
      task: 'Fix',
      overrides: { toolPacks: [{ clis: [cli] }] },
    };
    const first = await resolveLaunch(request, services);
    const edited = await resolveLaunch(
      {
        ...request,
        overrides: { toolPacks: [{ clis: [{ ...cli, instructions: 'New guidance' }] }] },
      },
      services,
    );
    expect(edited.resolvedEnvironment.imageKey).toBe(first.resolvedEnvironment.imageKey);
    expect(edited.digest).not.toBe(first.digest);
    const cleared = await resolveLaunch({ ...request, overrides: { toolPacks: [] } }, services);
    expect(cleared.resolvedEnvironment.cliInstallCommands).toBeUndefined();
  });
  it('rejects name conflicts and missing prerequisites before image resolution', async () => {
    const { services } = createTestConfiguration(db);
    for (const toolPacks of [
      [{ clis: [cli] }, { clis: [{ ...cli, verifyArgs: ['--version'] }] }],
      [{ clis: [{ ...cli, requiredCapabilities: ['python'] }] }],
      [{ clis: [{ ...cli, name: 'git' }] }],
    ])
      await expect(
        resolveLaunch({ repositoryId: 'repo-a', task: 'Fix', overrides: { toolPacks } }, services),
      ).rejects.toThrow();
    expect(services.resolveEnvironment).not.toHaveBeenCalled();
  });
  it('fails closed if image resolution drops selected CLI software', async () => {
    const { services } = createTestConfiguration(db);
    const original = services.resolveEnvironment;
    services.resolveEnvironment = vi.fn((environment, target) => original(environment, target, []));
    await expect(
      resolveLaunch(
        { repositoryId: 'repo-a', task: 'Fix', overrides: { toolPacks: [{ clis: [cli] }] } },
        services,
      ),
    ).rejects.toMatchObject({ code: 'CLI_IMAGE_MISMATCH' });
  });
});
