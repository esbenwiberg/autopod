import { describe, expect, it, vi } from 'vitest';
import { resolveLaunch } from '../configuration/launch-resolver.js';
import { createTestConfiguration } from '../test-utils/configuration-helpers.js';
import { createTestDb } from '../test-utils/mock-helpers.js';
import { podSourceContext } from './pod-source-context.js';

describe('pod source identity', () => {
  it('retains repository/setup identity after archive and never consults a same-named legacy profile', async () => {
    const db = createTestDb();
    try {
      const { services, store } = createTestConfiguration(db);
      const frozen = await resolveLaunch({ repositoryId: 'repo-a', task: 'Inspect' }, services);
      store.archive('repository', 'repo-a', 1);
      const legacy = vi.fn(() => ({
        repoUrl: 'https://github.com/other/repo',
        defaultBranch: 'wrong',
      }));
      const pod = {
        id: 'pod',
        launchConfigDigest: frozen.digest,
        profileName: 'profile',
        profileSnapshot: null,
      };
      expect(podSourceContext(pod, () => frozen, legacy)).toEqual({
        repoUrl: frozen.repository?.config.remote,
        defaultBranch: frozen.repository?.setup.defaultBranch,
      });
      expect(legacy).not.toHaveBeenCalled();
      for (const read of [undefined, () => null, () => ({ ...frozen, digest: 'other' })])
        expect(() => podSourceContext(pod, read, legacy)).toThrow(
          'Immutable repository identity is unavailable',
        );
      expect(legacy).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });
});
