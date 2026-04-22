import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PodManager } from '../../pods/pod-manager.js';
import { filesRoutes } from './files.js';

interface FileEntry {
  path: string;
  size: number;
  modified: number;
}

function podManagerWithWorktree(worktreePath: string | null): PodManager {
  return {
    getSession: () => ({ worktreePath, artifactsPath: null }),
  } as unknown as PodManager;
}

async function buildFixture(root: string): Promise<void> {
  // Root-level files
  await writeFile(path.join(root, 'README.md'), '# readme');
  await writeFile(path.join(root, '.hidden.md'), '# hidden file');
  await writeFile(path.join(root, 'notes.txt'), 'not markdown');

  // Dot-directory with markdown (the bug fix target)
  await mkdir(path.join(root, '.documentation'), { recursive: true });
  await writeFile(path.join(root, '.documentation', 'dag.md'), '# dag');
  await writeFile(path.join(root, '.documentation', 'overview.md'), '# overview');

  // Nested dot-directory
  await mkdir(path.join(root, '.github', 'ISSUE_TEMPLATE'), { recursive: true });
  await writeFile(path.join(root, '.github', 'ISSUE_TEMPLATE', 'bug.md'), '# bug');

  // SKIP_DIRS entries — must not be traversed
  await mkdir(path.join(root, 'node_modules', 'foo'), { recursive: true });
  await writeFile(path.join(root, 'node_modules', 'foo', 'README.md'), 'ignore');
  await mkdir(path.join(root, '.git'), { recursive: true });
  await writeFile(path.join(root, '.git', 'HEAD.md'), 'ignore');
  await mkdir(path.join(root, 'dist'), { recursive: true });
  await writeFile(path.join(root, 'dist', 'x.md'), 'ignore');
  await mkdir(path.join(root, '.pnpm-store'), { recursive: true });
  await writeFile(path.join(root, '.pnpm-store', 'x.md'), 'ignore');
}

describe('filesRoutes', () => {
  let tmp: string;
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'autopod-files-'));
    await buildFixture(tmp);
    app = Fastify();
    filesRoutes(app, podManagerWithWorktree(tmp));
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await rm(tmp, { recursive: true, force: true });
  });

  describe('GET /pods/:podId/files', () => {
    it('returns markdown files from root and normal subdirectories', async () => {
      const res = await app.inject({ method: 'GET', url: '/pods/abc/files' });
      expect(res.statusCode).toBe(200);
      const paths = (res.json().files as FileEntry[]).map((f) => f.path).sort();
      expect(paths).toContain('README.md');
    });

    it('returns markdown files inside dot-directories (regression: .documentation/)', async () => {
      const res = await app.inject({ method: 'GET', url: '/pods/abc/files' });
      const paths = (res.json().files as FileEntry[]).map((f) => f.path);
      expect(paths).toContain(path.join('.documentation', 'dag.md'));
      expect(paths).toContain(path.join('.documentation', 'overview.md'));
      expect(paths).toContain(path.join('.github', 'ISSUE_TEMPLATE', 'bug.md'));
    });

    it('returns markdown files whose own name starts with a dot', async () => {
      const res = await app.inject({ method: 'GET', url: '/pods/abc/files' });
      const paths = (res.json().files as FileEntry[]).map((f) => f.path);
      expect(paths).toContain('.hidden.md');
    });

    it('skips SKIP_DIRS entries (.git, node_modules, dist, .pnpm-store)', async () => {
      const res = await app.inject({ method: 'GET', url: '/pods/abc/files' });
      const paths = (res.json().files as FileEntry[]).map((f) => f.path);
      expect(paths.some((p) => p.startsWith(`node_modules${path.sep}`))).toBe(false);
      expect(paths.some((p) => p.startsWith(`.git${path.sep}`))).toBe(false);
      expect(paths.some((p) => p.startsWith(`dist${path.sep}`))).toBe(false);
      expect(paths.some((p) => p.startsWith(`.pnpm-store${path.sep}`))).toBe(false);
    });

    it('filters by extension and excludes non-matching files', async () => {
      const res = await app.inject({ method: 'GET', url: '/pods/abc/files?ext=md' });
      const paths = (res.json().files as FileEntry[]).map((f) => f.path);
      expect(paths).not.toContain('notes.txt');
    });

    it('returns 404 when the pod has no worktree or artifacts path', async () => {
      const bare = Fastify();
      filesRoutes(bare, podManagerWithWorktree(null));
      await bare.ready();
      try {
        const res = await bare.inject({ method: 'GET', url: '/pods/abc/files' });
        expect(res.statusCode).toBe(404);
      } finally {
        await bare.close();
      }
    });
  });

  describe('GET /pods/:podId/files/content', () => {
    it('returns the content of a regular file', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/pods/abc/files/content',
        query: { path: path.join('.documentation', 'dag.md') },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.content).toBe('# dag');
      expect(body.path).toBe(path.join('.documentation', 'dag.md'));
    });

    it('rejects path traversal attempts with 400', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/pods/abc/files/content',
        query: { path: '../../../etc/passwd' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/escapes/i);
    });

    it('returns 400 when path query is missing', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/pods/abc/files/content',
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 404 when file does not exist', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/pods/abc/files/content',
        query: { path: 'missing.md' },
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
