import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { listBuiltinSkills, resolveBuiltinSkillPath } from '../pods/skill-resolver.js';
import { createTestConfiguration } from '../test-utils/configuration-helpers.js';
import { createTestDb } from '../test-utils/mock-helpers.js';
import { createConfigurationSourceReaders } from './source-readers.js';

describe('daemon configuration source readers', () => {
  it('pins the actual published default branch using a branch endpoint, independently of setup defaults', async () => {
    const db = createTestDb();
    try {
      const { store } = createTestConfiguration(db);
      const get = vi.fn(async (url: string) => {
        if (url === '/repositories/42')
          return {
            id: 42,
            owner: { id: 10, login: 'team' },
            name: 'project',
            default_branch: 'release/default',
          };
        if (url === '/repositories/42/branches/release%2Fdefault')
          return { commit: { sha: 'c'.repeat(40) } };
        throw new Error('Unexpected source endpoint');
      });
      const readers = createConfigurationSourceReaders({ store, github: { get }, skillRoots: [] });
      const repository = {
        ...store.get('repository', 'repo-a').payload,
        providerRepositoryId: '42',
        remote: 'https://github.com/team/project',
      };
      expect(await readers.publishedDefault(repository)).toEqual({
        branch: 'release/default',
        commit: 'c'.repeat(40),
      });
      expect(get).not.toHaveBeenCalledWith(expect.stringContaining('/commits/'));
      await expect(readers.publishedDefault({ ...repository, provider: 'ado' })).rejects.toThrow(
        'GitHub',
      );
    } finally {
      db.close();
    }
  });
  it('resolves provider identity and a commit before reading skill bytes, refusing changed remotes', async () => {
    const db = createTestDb();
    try {
      const { store } = createTestConfiguration(db);
      const original = store.get('repository', 'repo-a');
      store.write({
        ...original,
        expectedRevision: original.revision,
        payload: {
          ...original.payload,
          providerRepositoryId: '42',
          remote: 'https://github.com/team/project.git',
        },
      });
      const repository = store.get('repository', 'repo-a');
      const get = vi.fn(async (url: string) => {
        if (url === '/repositories/42' || url === '/repos/team/project')
          return {
            id: 42,
            owner: { id: 10, login: 'team' },
            name: 'project',
            default_branch: 'main',
          };
        if (url === '/repositories/42/commits/feature%2Ffix') return { sha: 'a'.repeat(40) };
        if (url === `/repositories/42/contents/skills/one.md?ref=${'a'.repeat(40)}`)
          return {
            type: 'file',
            encoding: 'base64',
            size: 7,
            content: Buffer.from('Content').toString('base64'),
          };
        throw new Error(`Unexpected fixture path ${url}`);
      });
      const readers = createConfigurationSourceReaders({ store, github: { get }, skillRoots: [] });
      expect(
        await readers.referenceRevision(
          { ...repository.payload, providerRepositoryId: null },
          'feature/fix',
        ),
      ).toBe('a'.repeat(40));
      expect(
        await readers.skillContent({
          name: 'one',
          source: {
            type: 'github',
            repositoryId: 'repo-a',
            path: 'skills/one.md',
            ref: 'feature/fix',
          },
        }),
      ).toBe('Content');
      expect(get).toHaveBeenCalledWith(
        `/repositories/42/contents/skills/one.md?ref=${'a'.repeat(40)}`,
      );
      await expect(
        readers.referenceRevision(
          { ...repository.payload, remote: 'https://github.com/other/project.git' },
          'main',
        ),
      ).rejects.toThrow('disagree');
    } finally {
      db.close();
    }
  });
  it('bundles only repo-specific skills and does not resolve removed global workflows', async () => {
    const db = createTestDb();
    try {
      const { store } = createTestConfiguration(db);
      const readers = createConfigurationSourceReaders({
        store,
        github: { get: vi.fn() },
        skillRoots: [],
      });
      const builtinNames = (await listBuiltinSkills()).map((skill) => skill.name);
      for (const name of ['add-pod-state', 'add-profile-field', 'deploy-hosted-daemon']) {
        const canonical = await resolveBuiltinSkillPath(name);
        expect(canonical).toContain(`${path.sep}.agents${path.sep}skills${path.sep}`);
        const content = await readFile(canonical, 'utf8');
        expect(builtinNames.filter((builtin) => builtin === name)).toHaveLength(1);
        await expect(readers.skillContent({ name, source: { type: 'builtin' } })).resolves.toBe(
          content,
        );
        const alias = path.resolve(
          path.dirname(canonical),
          '../../../.claude/skills',
          name,
          'SKILL.md',
        );
        await expect(
          readers.skillContent({ name, source: { type: 'local', path: alias } }),
        ).resolves.toBe(content);
      }
      expect(builtinNames).toEqual(['add-pod-state', 'add-profile-field', 'deploy-hosted-daemon']);
      for (const name of ['plan-feature', 'prep', 'podsitter', 'triage', 'investigate-bug']) {
        await expect(
          readers.skillContent({ name, source: { type: 'builtin' } }),
        ).rejects.toMatchObject({ code: 'ENOENT' });
      }
    } finally {
      db.close();
    }
  });

  it('does not trust sibling directories or escaped aliases when SKILLS_DIR is overridden', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'configuration-skill-roots-'));
    const custom = path.join(root, '.claude/skills');
    const sibling = path.join(root, '.agents/skills');
    const db = createTestDb();
    try {
      await mkdir(custom, { recursive: true });
      await mkdir(sibling, { recursive: true });
      await writeFile(path.join(custom, 'local.md'), 'Custom');
      await writeFile(path.join(sibling, 'shared.md'), 'Not implicitly enrolled');
      await symlink(path.join(sibling, 'shared.md'), path.join(custom, 'escape.md'));
      vi.stubEnv('SKILLS_DIR', custom);
      vi.resetModules();
      const { createConfigurationSourceReaders: overridden } = await import('./source-readers.js');
      const { store } = createTestConfiguration(db);
      const readers = overridden({ store, github: { get: vi.fn() }, skillRoots: [] });
      await expect(
        readers.skillContent({ name: 'local', source: { type: 'builtin' } }),
      ).resolves.toBe('Custom');
      await expect(
        readers.skillContent({ name: 'escape', source: { type: 'builtin' } }),
      ).rejects.toThrow('outside');
      await expect(
        readers.skillContent({
          name: 'shared',
          source: { type: 'local', path: path.join(sibling, 'shared.md') },
        }),
      ).rejects.toThrow('outside');
      const enrolled = overridden({ store, github: { get: vi.fn() }, skillRoots: [sibling] });
      await expect(
        enrolled.skillContent({ name: 'escape', source: { type: 'builtin' } }),
      ).resolves.toBe('Not implicitly enrolled');
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('bounds local files and rejects symlinks outside enrolled directories', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'configuration-skill-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'configuration-outside-'));
    const db = createTestDb();
    try {
      const { store } = createTestConfiguration(db);
      const readers = createConfigurationSourceReaders({
        store,
        github: { get: vi.fn() },
        skillRoots: [root],
      });
      await writeFile(path.join(root, 'one.md'), 'Allowed');
      await writeFile(path.join(outside, 'other.md'), 'Outside');
      await symlink(path.join(outside, 'other.md'), path.join(root, 'link.md'));
      expect(
        await readers.skillContent({
          name: 'one',
          source: { type: 'local', path: path.join(root, 'one.md') },
        }),
      ).toBe('Allowed');
      await expect(
        readers.skillContent({
          name: 'linked',
          source: { type: 'local', path: path.join(root, 'link.md') },
        }),
      ).rejects.toThrow('outside');
      await writeFile(path.join(root, 'large.md'), 'x'.repeat(1_000_001));
      await expect(
        readers.skillContent({
          name: 'large',
          source: { type: 'local', path: path.join(root, 'large.md') },
        }),
      ).rejects.toThrow('size');
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
