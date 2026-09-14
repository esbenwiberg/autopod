import type { MemoryEntry, Pod } from '@autopod/shared';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { resolveLaunch } from '../configuration/launch-resolver.js';
import {
  createTestConfiguration,
  insertConfigurationTestPod,
} from '../test-utils/configuration-helpers.js';
import { createTestDb } from '../test-utils/mock-helpers.js';
import { createMemoryRepository } from './memory-repository.js';
import { selectRelevantMemories } from './memory-selector.js';
import { createPodRepository } from './pod-repository.js';
import { memoryScopeId, projectMemoryScope } from './project-memory-scope.js';

describe('repository memory isolation', () => {
  it('keeps repository notes separate when profiles and reference repositories are shared', async () => {
    const db = createTestDb();
    try {
      const { services } = createTestConfiguration(db);
      const a = await resolveLaunch(
        {
          repositoryId: 'repo-a',
          task: 'Authentication refresh',
          referenceRepositories: [{ repositoryId: 'repo-b', ref: 'main', access: 'read' }],
        },
        services,
      );
      const b = await resolveLaunch(
        { repositoryId: 'repo-b', task: 'Authentication refresh' },
        services,
      );
      expect(a.profileId).toBe(b.profileId);
      insertConfigurationTestPod(db, 'pod');
      const base = createPodRepository(db).getOrThrow('pod');
      const repo = createMemoryRepository(db);
      const insert = (
        id: string,
        scope: MemoryEntry['scope'],
        scopeId: string | null,
        repositorySetupId?: string,
      ) =>
        repo.insert({
          id,
          scope,
          scopeId,
          ...(repositorySetupId ? { repositorySetupId } : {}),
          path: '/auth.md',
          content: `Authentication refresh convention for ${id}`,
          approved: true,
          createdByPodId: null,
          rationale: null,
          kind: null,
          tags: [],
          appliesWhen: null,
          avoidWhen: null,
          confidence: null,
          sourceEvidence: [],
          impactSummary: null,
        });
      insert('a', 'repository', 'repo-a');
      insert('b', 'repository', 'repo-b');
      insert('legacy', 'profile', a.profileId);
      insert('global', 'global', null);
      insert('setup-default', 'repository', 'repo-a', 'default');
      insert('setup-other', 'repository', 'repo-a', 'other');
      for (const config of [a, b]) {
        const pod: Pod = {
          ...base,
          task: config.task,
          profileName: config.profileId,
          launchConfigDigest: config.digest,
          options: { ...base.options, agentMode: 'auto' },
        };
        const scope = projectMemoryScope(pod, config);
        const result = await selectRelevantMemories({
          pod,
          profile: {} as never,
          deps: { memoryRepo: repo, projectScope: scope, logger: pino({ level: 'silent' }) },
        });
        const expected = config.repository?.id === 'repo-a' ? 'a' : 'b';
        expect(result.selected.map((entry) => entry.memory.id).sort()).toEqual(
          [expected, 'global', ...(expected === 'a' ? ['setup-default'] : [])].sort(),
        );
        expect(() => memoryScopeId(pod, 'profile', scope)).toThrow('does not have access');
        expect(memoryScopeId(pod, 'repository', scope)).toBe(config.repository?.id);
      }
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('does not infer repository memory from the profile for an empty workspace or missing snapshot', async () => {
    const db = createTestDb();
    try {
      const { services } = createTestConfiguration(db);
      const config = await resolveLaunch(
        {
          emptyWorkspace: true,
          profileId: 'profile',
          task: 'Research',
          overrides: { workflow: { output: 'none' } },
          selections: { githubAccessId: null },
        },
        services,
      );
      insertConfigurationTestPod(db, 'pod');
      const pod = {
        ...createPodRepository(db).getOrThrow('pod'),
        launchConfigDigest: config.digest,
      };
      expect(projectMemoryScope(pod, config)).toBeNull();
      expect(() => memoryScopeId(pod, 'repository', null)).toThrow('does not have access');
      expect(() => projectMemoryScope(pod, null)).toThrow('frozen launch');
    } finally {
      db.close();
    }
  });
});
