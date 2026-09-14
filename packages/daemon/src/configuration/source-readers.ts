import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { RepositoryConfig, ToolPack } from '@autopod/shared';
import { z } from 'zod';
import { GitHubDiscovery } from '../github/discovery.js';
import type { GitHubMutationClient } from '../github/mutation-broker.js';
import { BUILTIN_SKILLS_DIR, resolveBuiltinSkillPath } from '../pods/skill-resolver.js';
import { type ConfigurationStore, configurationError } from './configuration-store.js';

const maxSkillBytes = 1_000_000;
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const encodedPath = (value: string) => value.split('/').map(encodeURIComponent).join('/');
const canonicalRemote = (value: string) => value.replace(/\.git$/, '').replace(/\/$/, '');

/** Daemon-only readers. Skill bytes are frozen by the launch resolver, never fetched by a pod. */
export function createConfigurationSourceReaders(options: {
  store: ConfigurationStore;
  github: Pick<GitHubMutationClient, 'get'>;
  skillRoots: string[];
}) {
  const discovery = new GitHubDiscovery(options.github);
  async function githubRepository(repository: RepositoryConfig) {
    if (repository.provider !== 'github')
      configurationError(
        'This reference requires an enrolled GitHub repository identity',
        'REFERENCE_PROVIDER_UNAVAILABLE',
        409,
      );
    const remote = repository.providerRepositoryId
      ? await discovery.repositoryById(repository.providerRepositoryId)
      : await discovery.repositoryByRemote(repository.remote);
    if (
      canonicalRemote(`https://github.com/${remote.ownerLogin}/${remote.name}`).toLowerCase() !==
      canonicalRemote(repository.remote).toLowerCase()
    )
      configurationError(
        'Repository remote and provider identity disagree',
        'REPOSITORY_IDENTITY_CHANGED',
        409,
      );
    return remote;
  }
  async function referenceRevision(repository: RepositoryConfig, ref: string): Promise<string> {
    const { id } = await githubRepository(repository);
    const result = z
      .object({ sha })
      .parse(await options.github.get(`/repositories/${id}/commits/${encodeURIComponent(ref)}`));
    return result.sha;
  }
  async function localSkill(file: string): Promise<string> {
    const actual = await realpath(file);
    const roots = await Promise.all(
      [BUILTIN_SKILLS_DIR, ...options.skillRoots].map(async (root) => {
        try {
          return await realpath(root);
        } catch {
          return null;
        }
      }),
    );
    if (!roots.some((root) => root && actual.startsWith(`${root}${path.sep}`)))
      configurationError(
        'Skill file is outside the enrolled skill directories',
        'SKILL_PATH_DENIED',
        403,
      );
    const handle = await open(actual, 'r');
    try {
      if (!(await handle.stat()).isFile())
        configurationError('Skill source must be a regular file', 'SKILL_SOURCE_INVALID');
      const buffer = Buffer.alloc(maxSkillBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const next = await handle.read(buffer, length, buffer.length - length, length);
        if (!next.bytesRead) break;
        length += next.bytesRead;
      }
      if (length > maxSkillBytes)
        configurationError('Skill content exceeds its size bound', 'SKILL_SOURCE_TOO_LARGE');
      return buffer.subarray(0, length).toString('utf8');
    } finally {
      await handle.close();
    }
  }
  return {
    referenceRevision,
    async publishedDefault(repository: RepositoryConfig) {
      const remote = await githubRepository(repository);
      // Resolve an explicit branch, not the commits endpoint's ambiguous branch/tag shorthand.
      const result = z
        .object({ commit: z.object({ sha }) })
        .parse(
          await options.github.get(
            `/repositories/${remote.id}/branches/${encodeURIComponent(remote.defaultBranch)}`,
          ),
        );
      return { branch: remote.defaultBranch, commit: result.commit.sha };
    },
    async skillContent(skill: ToolPack['skills'][number]): Promise<string> {
      const source = skill.source;
      if (source.type === 'inline') return source.content;
      if (source.type === 'builtin') return localSkill(await resolveBuiltinSkillPath(skill.name));
      if (source.type === 'local') return localSkill(source.path);
      const repository = options.store.get('repository', source.repositoryId).payload;
      const { id } = await githubRepository(repository);
      const revision = await referenceRevision(repository, source.ref);
      const result = z
        .object({
          type: z.literal('file'),
          encoding: z.literal('base64'),
          size: z.number().int().nonnegative().max(maxSkillBytes),
          content: z.string().max(1_500_000),
        })
        .parse(
          await options.github.get(
            `/repositories/${id}/contents/${encodedPath(source.path)}?ref=${revision}`,
          ),
        );
      const bytes = Buffer.from(result.content.replace(/\s/g, ''), 'base64');
      if (bytes.length !== result.size || bytes.length > maxSkillBytes)
        configurationError(
          'Skill content size does not match provider evidence',
          'SKILL_SOURCE_INVALID',
        );
      return bytes.toString('utf8');
    },
  };
}
