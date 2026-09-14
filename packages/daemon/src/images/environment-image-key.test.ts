import { environmentPresetSchema, repositorySetupSchema } from '@autopod/shared';
import { describe, expect, it } from 'vitest';
import { generateEnvironmentDockerfile } from './environment-dockerfile.js';
import { environmentImageKey } from './environment-image-key.js';
import { repositoryCacheKey } from './repository-cache-key.js';

const inputs = {
  environment: environmentPresetSchema.parse({ template: 'node22' }),
  pinnedBase: `base@sha256:${'a'.repeat(64)}`,
  platform: 'linux/amd64' as const,
  agentToolingDigest: 'b'.repeat(64),
  toolInstallCommands: [],
};
describe('software and repository image identities', () => {
  it('does not include repository, AI, allocation or sidecar server identity in software', () => {
    const original = environmentImageKey(inputs);
    expect(
      environmentImageKey({
        ...inputs,
        environment: {
          ...inputs.environment,
          sidecars: [
            {
              id: 'db',
              type: 'postgres',
              image: `postgres@sha256:${'c'.repeat(64)}`,
              version: '17',
              port: 5432,
              startup: 'always',
              healthTimeoutMs: 60000,
            },
          ],
        },
      }),
    ).toBe(original);
    expect(environmentImageKey({ ...inputs, platform: 'linux/arm64' })).not.toBe(original);
    expect(environmentImageKey({ ...inputs, agentToolingDigest: 'c'.repeat(64) })).not.toBe(
      original,
    );
    expect(() => environmentImageKey({ ...inputs, pinnedBase: 'base:latest' })).toThrow(
      'immutable',
    );
  });
  it('separates source preparation by repository, revision, setup and feed identity', () => {
    const cache = {
      repositoryId: 'a',
      canonicalRemote: 'https://github.com/org/a',
      sourceRevision: 'a'.repeat(40),
      environmentDigest: environmentImageKey(inputs),
      setup: repositorySetupSchema.parse({ id: 'default', name: 'Default' }),
      dependencyInputs: {},
      feedIdentityIds: [],
    };
    const key = repositoryCacheKey(cache);
    expect(repositoryCacheKey({ ...cache, repositoryId: 'b' })).not.toBe(key);
    expect(repositoryCacheKey({ ...cache, sourceRevision: 'b'.repeat(40) })).not.toBe(key);
    expect(repositoryCacheKey({ ...cache, feedIdentityIds: ['private-feed'] })).not.toBe(key);
    expect(
      repositoryCacheKey({ ...cache, setup: { ...cache.setup, prepareCommand: 'npm ci' } }),
    ).not.toBe(key);
  });
  it('generates only software installation and escapes multiline Dockerfile content', () => {
    const dockerfile = generateEnvironmentDockerfile({
      ...inputs,
      toolInstallCommands: ['echo installed'],
      environment: {
        ...inputs.environment,
        prepareCommands: ['echo ready\n# Still part of the command'],
      },
    });
    expect(dockerfile).toContain('RUN ["sh","-e","-c","echo installed"]');
    expect(dockerfile).not.toMatch(/ARG |git clone|COPY |GIT_PAT|REGISTRY_PAT|npm ci/);
    expect(dockerfile.split('\n').filter((line) => line.startsWith('# Still'))).toHaveLength(0);
  });
});
