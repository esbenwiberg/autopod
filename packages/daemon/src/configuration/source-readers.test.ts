import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
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
