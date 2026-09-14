import { describe, expect, it } from 'vitest';
import { createTestConfiguration } from '../test-utils/configuration-helpers.js';
import { createTestDb } from '../test-utils/mock-helpers.js';
import { resolveLaunchExecutionSettings } from './launch-execution-settings.js';
import { resolveLaunch } from './launch-resolver.js';

describe('launch execution settings', () => {
  it('keeps repository, exact configuration and tool bytes pinned while presets change', async () => {
    const db = createTestDb();
    try {
      const { services, store } = createTestConfiguration(db);
      const launch = await resolveLaunch(
        {
          repositoryId: 'repo-b',
          task: 'Fix',
          overrides: {
            toolPacks: [
              {
                skills: [
                  { name: 'testing', source: { type: 'inline', content: 'Pinned instructions' } },
                ],
              },
            ],
          },
        },
        services,
      );
      const binding = { provider: 'anthropic' as const, image: `image@sha256:${'a'.repeat(64)}` };
      const before = resolveLaunchExecutionSettings(launch, binding);
      const env = store.get('environment', 'env');
      store.write({
        ...env,
        expectedRevision: env.revision,
        payload: { ...env.payload, template: 'node24' },
      });
      expect(resolveLaunchExecutionSettings(launch, binding)).toEqual(before);
      expect(before.repoUrl).toBe('https://github.com/org/repo-b');
      expect(before.skills[0]?.source).toEqual({ type: 'inline', content: 'Pinned instructions' });
      expect(before.providerCredentials).toBeNull();
      expect(before.registryPat).toBeNull();
      for (const retired of [
        'extends',
        'workerProfile',
        'warmImageBuiltAt',
        'githubPat',
        'openrouterApiKey',
        'version',
        'issueWatcherEnabled',
        'issueWatcherLabelPrefix',
        'mergeStrategy',
        'createdAt',
        'updatedAt',
      ])
        expect(before).not.toHaveProperty(retired);
      expect(before.skipValidationPhases).toContain('review');
      expect(before.skipValidationPhases).not.toContain('test');
    } finally {
      db.close();
    }
  });
});
