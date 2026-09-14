import type { RepositorySetup } from '@autopod/shared';
import { configurationDigest } from '../configuration/launch-resolver.js';

/** Repository preparation is never identified by profile name or software identity alone. */
export function repositoryCacheKey(input: {
  repositoryId: string;
  canonicalRemote: string;
  sourceRevision: string;
  environmentDigest: string;
  setup: RepositorySetup;
  dependencyInputs: Record<string, string>;
  feedIdentityIds: string[];
}): string {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.sourceRevision))
    throw new Error('Repository cache needs an exact source revision');
  if (!/^(?:sha256:)?[a-f0-9]{64}$/.test(input.environmentDigest))
    throw new Error('Repository cache needs an environment digest');
  return configurationDigest({
    version: 1,
    ...input,
    feedIdentityIds: [...new Set(input.feedIdentityIds)].sort(),
  });
}
