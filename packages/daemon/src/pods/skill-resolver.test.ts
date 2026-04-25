import * as fs from 'node:fs/promises';
import type { InjectedSkill } from '@autopod/shared';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveSkills } from './skill-resolver.js';

const logger = pino({ level: 'silent' });

vi.mock('node:fs/promises');
const mockFs = vi.mocked(fs);

describe('resolveSkills', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('local source', () => {
    it('reads skill content from local file', async () => {
      mockFs.readFile.mockResolvedValue('# Review\nReview the PR carefully.');

      const skills: InjectedSkill[] = [
        { name: 'review', source: { type: 'local', path: '/skills/review.md' } },
      ];

      const result = await resolveSkills(skills, logger);

      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe('review');
      expect(result[0]?.content).toBe('# Review\nReview the PR carefully.');
      expect(mockFs.readFile).toHaveBeenCalledWith('/skills/review.md', 'utf-8');
    });

    it('skips skill when local file does not exist', async () => {
      mockFs.readFile.mockRejectedValue(new Error('ENOENT'));

      const skills: InjectedSkill[] = [
        { name: 'missing', source: { type: 'local', path: '/nope/missing.md' } },
      ];

      const result = await resolveSkills(skills, logger);
      expect(result).toHaveLength(0);
    });

    it('resolves multiple local skills', async () => {
      mockFs.readFile
        .mockResolvedValueOnce('Skill A content')
        .mockResolvedValueOnce('Skill B content');

      const skills: InjectedSkill[] = [
        { name: 'skill-a', source: { type: 'local', path: '/skills/a.md' } },
        { name: 'skill-b', source: { type: 'local', path: '/skills/b.md' } },
      ];

      const result = await resolveSkills(skills, logger);
      expect(result).toHaveLength(2);
      expect(result[0]?.name).toBe('skill-a');
      expect(result[1]?.name).toBe('skill-b');
    });
  });

  describe('github source', () => {
    it('fetches skill content from GitHub API', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('# Deploy\nRun deploy steps.'),
      });
      vi.stubGlobal('fetch', mockFetch);

      const skills: InjectedSkill[] = [
        {
          name: 'deploy',
          source: { type: 'github', repo: 'org/skills', path: 'commands/deploy.md' },
        },
      ];

      const result = await resolveSkills(skills, logger);

      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe('deploy');
      expect(result[0]?.content).toBe('# Deploy\nRun deploy steps.');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.github.com/repos/org/skills/contents/commands/deploy.md?ref=main',
        expect.objectContaining({
          headers: expect.objectContaining({
            Accept: 'application/vnd.github.v3.raw',
          }),
        }),
      );
    });

    it('uses custom ref when provided', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('content'),
      });
      vi.stubGlobal('fetch', mockFetch);

      const skills: InjectedSkill[] = [
        {
          name: 'test',
          source: { type: 'github', repo: 'org/skills', ref: 'v2.0' },
        },
      ];

      await resolveSkills(skills, logger);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('ref=v2.0'),
        expect.any(Object),
      );
    });

    it('uses skill name as default path', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('content'),
      });
      vi.stubGlobal('fetch', mockFetch);

      const skills: InjectedSkill[] = [
        { name: 'lint', source: { type: 'github', repo: 'org/skills' } },
      ];

      await resolveSkills(skills, logger);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/contents/lint.md'),
        expect.any(Object),
      );
    });

    it('includes auth token when provided', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('private skill'),
      });
      vi.stubGlobal('fetch', mockFetch);

      const skills: InjectedSkill[] = [
        {
          name: 'internal',
          source: { type: 'github', repo: 'org/private-skills', token: 'ghp_secret123' },
        },
      ];

      await resolveSkills(skills, logger);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer ghp_secret123',
          }),
        }),
      );
    });

    it('skips skill when GitHub API returns non-200', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: () => Promise.resolve('Not Found'),
      });
      vi.stubGlobal('fetch', mockFetch);

      const skills: InjectedSkill[] = [
        { name: 'gone', source: { type: 'github', repo: 'org/skills' } },
      ];

      const result = await resolveSkills(skills, logger);
      expect(result).toHaveLength(0);
    });

    it('skips skill when fetch throws (network error)', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('network timeout'));
      vi.stubGlobal('fetch', mockFetch);

      const skills: InjectedSkill[] = [
        { name: 'timeout', source: { type: 'github', repo: 'org/skills' } },
      ];

      const result = await resolveSkills(skills, logger);
      expect(result).toHaveLength(0);
    });

    describe('ref validation — fix 3.1', () => {
      it('warns when ref is a branch name', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
          ok: true,
          text: () => Promise.resolve('content'),
        });
        vi.stubGlobal('fetch', mockFetch);
        const warnSpy = vi.spyOn(logger, 'warn');

        await resolveSkills(
          [{ name: 'skill', source: { type: 'github', repo: 'org/repo', ref: 'main' } }],
          logger,
        );

        expect(warnSpy).toHaveBeenCalledWith(
          expect.objectContaining({ ref: 'main' }),
          expect.stringContaining('not a full 40-character commit SHA'),
        );
      });

      it('warns when ref is a short SHA', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
          ok: true,
          text: () => Promise.resolve('content'),
        });
        vi.stubGlobal('fetch', mockFetch);
        const warnSpy = vi.spyOn(logger, 'warn');

        await resolveSkills(
          [{ name: 'skill', source: { type: 'github', repo: 'org/repo', ref: 'abc1234' } }],
          logger,
        );

        expect(warnSpy).toHaveBeenCalledWith(
          expect.objectContaining({ ref: 'abc1234' }),
          expect.stringContaining('not a full 40-character commit SHA'),
        );
      });

      it('does not warn when ref is a full 40-char commit SHA', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
          ok: true,
          text: () => Promise.resolve('content'),
        });
        vi.stubGlobal('fetch', mockFetch);
        const warnSpy = vi.spyOn(logger, 'warn');

        const fullSha = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
        await resolveSkills(
          [{ name: 'skill', source: { type: 'github', repo: 'org/repo', ref: fullSha } }],
          logger,
        );

        const shaCalls = warnSpy.mock.calls.filter(
          ([, msg]) =>
            typeof msg === 'string' && msg.includes('not a full 40-character commit SHA'),
        );
        expect(shaCalls).toHaveLength(0);
      });

      it('warns when no ref is provided (defaults to "main")', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
          ok: true,
          text: () => Promise.resolve('content'),
        });
        vi.stubGlobal('fetch', mockFetch);
        const warnSpy = vi.spyOn(logger, 'warn');

        await resolveSkills(
          [{ name: 'skill', source: { type: 'github', repo: 'org/repo' } }],
          logger,
        );

        expect(warnSpy).toHaveBeenCalledWith(
          expect.objectContaining({ ref: 'main' }),
          expect.stringContaining('not a full 40-character commit SHA'),
        );
      });
    });
  });

  describe('mixed sources', () => {
    it('resolves local and github skills together', async () => {
      mockFs.readFile.mockResolvedValue('local content');
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('github content'),
      });
      vi.stubGlobal('fetch', mockFetch);

      const skills: InjectedSkill[] = [
        { name: 'local-skill', source: { type: 'local', path: '/skills/local.md' } },
        { name: 'github-skill', source: { type: 'github', repo: 'org/skills' } },
      ];

      const result = await resolveSkills(skills, logger);

      expect(result).toHaveLength(2);
      expect(result[0]?.content).toBe('local content');
      expect(result[1]?.content).toBe('github content');
    });

    it('continues resolving when one skill fails', async () => {
      mockFs.readFile.mockRejectedValue(new Error('ENOENT'));
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve('github content'),
      });
      vi.stubGlobal('fetch', mockFetch);

      const skills: InjectedSkill[] = [
        { name: 'broken', source: { type: 'local', path: '/nope.md' } },
        { name: 'working', source: { type: 'github', repo: 'org/skills' } },
      ];

      const result = await resolveSkills(skills, logger);

      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe('working');
    });
  });
});
