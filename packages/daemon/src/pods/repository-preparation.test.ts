import { describe, expect, it, vi } from 'vitest';
import { resolveLaunch } from '../configuration/launch-resolver.js';
import { createTestConfiguration } from '../test-utils/configuration-helpers.js';
import { createMockContainerManager, createTestDb } from '../test-utils/mock-helpers.js';
import { prepareLaunchRepository } from './repository-preparation.js';

describe('repository preparation', () => {
  it('runs project setup in its pod workdir and prevents failed preparation from being treated as ready', async () => {
    const db = createTestDb();
    try {
      const { services } = createTestConfiguration(db);
      const config = await resolveLaunch(
        {
          repositoryId: 'repo-a',
          task: 'Fix',
          overrides: {
            repositorySetup: {
              prepareCommand: 'pnpm install --frozen-lockfile',
              buildWorkDir: 'app',
              buildTimeout: 120,
              buildEnv: { PUBLIC_VALUE: { value: 'visible' }, PRIVATE_VALUE: { secretId: 's' } },
            },
          },
        },
        services,
      );
      const cm = createMockContainerManager();
      await prepareLaunchRepository(config, cm, 'pod-container', {
        FEED_TOKEN: 'fixture-secret',
        PUBLIC_VALUE: 'visible',
        PRIVATE_VALUE: 'private-fixture',
      });
      expect(cm.execInContainer).toHaveBeenCalledWith(
        'pod-container',
        [
          '/usr/bin/env',
          '--',
          'PUBLIC_VALUE=visible',
          'sh',
          '-c',
          'set -e\npnpm install --frozen-lockfile',
        ],
        {
          cwd: '/workspace/app',
          timeout: 120000,
          env: {
            FEED_TOKEN: 'fixture-secret',
            PUBLIC_VALUE: 'visible',
            PRIVATE_VALUE: 'private-fixture',
          },
        },
      );
      vi.mocked(cm.execInContainer).mockResolvedValue({
        exitCode: 1,
        stdout: 'fixture-secret',
        stderr: 'fixture-secret',
      });
      await expect(prepareLaunchRepository(config, cm, 'pod-container', {})).rejects.toMatchObject({
        code: 'REPOSITORY_PREPARATION_FAILED',
      });
      expect(JSON.stringify(config)).not.toContain('fixture-secret');
      vi.mocked(cm.execInContainer).mockRejectedValue(
        new Error('private-fixture https://user:password@example.test/?token=secret'),
      );
      await expect(prepareLaunchRepository(config, cm, 'pod-container', {})).rejects.toThrow(
        'Repository preparation did not complete with a verified exit',
      );
    } finally {
      db.close();
    }
  });
});
