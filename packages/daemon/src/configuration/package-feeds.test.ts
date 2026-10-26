import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pod } from '@autopod/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadOrCreateKey } from '../crypto/credentials-cipher.js';
import type { ContainerManager } from '../interfaces/container-manager.js';
import { createValidationEnvironment } from '../pods/validation-environment.js';
import { createTestConfiguration } from '../test-utils/configuration-helpers.js';
import { createTestDb } from '../test-utils/mock-helpers.js';
import { resolveLaunchCredentialReferences } from './credential-references.js';
import { createConfigurationCredentialStore } from './credential-store.js';
import { createLaunchExecutionCredentials } from './execution-credentials.js';
import { resolveLaunchExecutionSettings } from './launch-execution-settings.js';
import { resolveLaunch } from './launch-resolver.js';

describe('reusable package feeds', () => {
  let f: ReturnType<typeof fixture>;
  beforeEach(() => {
    f = fixture();
  });
  afterEach(() => {
    f.db.close();
    rmSync(f.dir, { recursive: true, force: true });
  });
  function fixture() {
    const db = createTestDb();
    const dir = mkdtempSync(join(tmpdir(), 'package-feeds-'));
    const { store, services } = createTestConfiguration(db);
    const credentials = createConfigurationCredentialStore(
      db,
      loadOrCreateKey(join(dir, 'key')),
      async () => {},
    );
    services.resolveCredentialReferences = async (config) =>
      resolveLaunchCredentialReferences(config, credentials);
    return { db, dir, store, services, credentials };
  }
  async function enroll() {
    await f.credentials.create({
      id: 'registry',
      name: 'Registry',
      purposes: ['registry-read'],
      origins: ['https://packages.example.com'],
      value: 'fixture-old-token',
    });
    f.store.write({
      kind: 'packageFeed',
      id: 'feed',
      name: 'Company npm',
      payload: {
        type: 'npm',
        url: 'https://packages.example.com/npm/',
        credential: { secretId: 'registry' },
      },
    });
  }
  function select(repoId: string, ids: string[]) {
    const repo = f.store.get('repository', repoId);
    f.store.write({
      kind: 'repository',
      id: repo.id,
      name: repo.name,
      expectedRevision: repo.revision,
      payload: {
        ...repo.payload,
        setups: repo.payload.setups.map((setup) => ({
          ...setup,
          integrations: { ...setup.integrations, packageFeedIds: ids },
        })),
      },
    });
  }
  it('shares feeds across repositories, freezes settings and rejects stale previews and archive while referenced', async () => {
    await enroll();
    select('repo-a', ['feed']);
    select('repo-b', ['feed']);
    const a = await resolveLaunch({ repositoryId: 'repo-a', task: 'Work' }, f.services);
    const b = await resolveLaunch({ repositoryId: 'repo-b', task: 'Work' }, f.services);
    expect(a.repository?.setup.integrations.privateRegistries).toEqual(
      b.repository?.setup.integrations.privateRegistries,
    );
    expect(a.revisions).toContainEqual(
      expect.objectContaining({ id: 'feed', kind: 'packageFeed', revision: 1 }),
    );
    expect(JSON.stringify(a)).not.toContain('fixture-old-token');
    expect(() => f.store.archive('packageFeed', 'feed', 1)).toThrow('referenced');
    const saved = JSON.stringify(a);
    const feed = f.store.get('packageFeed', 'feed');
    f.store.write({
      kind: 'packageFeed',
      id: feed.id,
      name: feed.name,
      expectedRevision: 1,
      payload: { ...feed.payload, url: 'https://packages.example.com/other/' },
    });
    expect(JSON.stringify(a)).toBe(saved);
    expect(() => f.store.assertCurrent(a.revisions)).toThrow('changed');
    expect(f.db.pragma('foreign_key_check')).toEqual([]);
    expect(f.db.pragma('foreign_keys', { simple: true })).toBe(1);
  });
  it('does not inject unselected feeds and rejects missing references and conflicting default feeds', async () => {
    await enroll();
    const launch = await resolveLaunch({ repositoryId: 'repo-a', task: 'Work' }, f.services);
    expect(launch.repository?.setup.integrations.privateRegistries).toEqual([]);
    expect(() => select('repo-a', ['missing'])).toThrow('not found');
    f.store.write({
      kind: 'packageFeed',
      id: 'other',
      name: 'Other',
      payload: { type: 'npm', url: 'https://other.example.com/' },
    });
    select('repo-a', ['feed', 'other']);
    await expect(
      resolveLaunch({ repositoryId: 'repo-a', task: 'Work' }, f.services),
    ).rejects.toMatchObject({ code: 'PACKAGE_FEED_CONFLICT' });
    select('repo-a', []);
    f.store.archive('packageFeed', 'feed', 1);
    expect(() => select('repo-a', ['feed'])).toThrow('archived');
  });
  it('rejects secret literals and unsafe feed metadata', () => {
    for (const payload of [
      { type: 'npm', url: 'http://packages.example.com/' },
      { type: 'npm', url: 'https://user:token@packages.example.com/' },
      { type: 'npm', url: 'https://packages.example.com/', pat: 'secret' },
      { type: 'npm', url: 'https://packages.example.com/', credential: { value: 'secret' } },
      { type: 'nuget', url: 'https://packages.example.com/', scope: '@sample' },
    ])
      expect(() => f.store.write({ kind: 'packageFeed', name: 'Invalid', payload })).toThrow();
  });
  it.each(['local', 'sandbox'] as const)(
    'refreshes the same frozen pod on %s after rotation; refuses revoked credentials and failed writes',
    async (target) => {
      await enroll();
      select('repo-a', ['feed']);
      const launch = await resolveLaunch({ repositoryId: 'repo-a', task: 'Work' }, f.services);
      const before = JSON.stringify(launch);
      const credentials = createLaunchExecutionCredentials(f.credentials);
      const writeFile = vi.fn(async () => {});
      const environment = createValidationEnvironment(
        { launchConfiguration: { read: () => launch, assertCurrentCapabilities: async () => {} } },
        {
          executionCredentialsFor: () => credentials,
          containerManagerFactory: {
            get: vi.fn(() => ({ writeFile }) as unknown as ContainerManager),
          },
        },
      );
      const pod = { id: 'same-pod', containerId: 'same-container', executionTarget: target } as Pod;
      const profile = resolveLaunchExecutionSettings(launch, { image: 'fixture-image' });
      const original = f.credentials.get('registry');
      const rotated = await f.credentials.rotate(
        original.id,
        original.revision,
        'fixture-new-token',
      );
      await environment.validationEnvironmentForPod(pod, profile);
      expect(writeFile).toHaveBeenCalledWith(
        'same-container',
        '/home/autopod/.npmrc',
        expect.stringContaining('fixture-new-token'),
        { mode: 0o600 },
      );
      expect(JSON.stringify(launch)).toBe(before);
      writeFile.mockRejectedValueOnce(new Error('Write failed'));
      await expect(environment.validationEnvironmentForPod(pod, profile)).rejects.toThrow(
        'Write failed',
      );
      f.credentials.revoke(rotated.id, rotated.revision);
      writeFile.mockClear();
      await expect(environment.validationEnvironmentForPod(pod, profile)).rejects.toThrow();
      expect(writeFile).not.toHaveBeenCalled();
    },
  );
});
