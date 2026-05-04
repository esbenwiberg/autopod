import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ContainerManager,
  ExecOptions,
  ExecResult,
} from '../../interfaces/container-manager.js';
import type { ContainerManagerFactory, PodManager } from '../../pods/pod-manager.js';
import { filesRoutes } from './files.js';

interface FileEntry {
  path: string;
  size: number;
  modified: number;
}

interface MockPod {
  worktreePath: string | null;
  artifactsPath?: string | null;
  containerId?: string | null;
  executionTarget?: string;
}

function podManager(pod: MockPod): PodManager {
  const merged = { artifactsPath: null, containerId: null, executionTarget: 'docker', ...pod };
  return {
    getSession: () => merged,
  } as unknown as PodManager;
}

function makeFactory(cm: Partial<ContainerManager>): ContainerManagerFactory {
  return {
    get: () => cm as ContainerManager,
  };
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
    filesRoutes(app, podManager({ worktreePath: tmp }));
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
      filesRoutes(bare, podManager({ worktreePath: null }));
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

describe('filesRoutes — container-first lookup', () => {
  let tmp: string;
  let app: ReturnType<typeof Fastify>;
  let execMock: ReturnType<typeof vi.fn>;
  let readMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'autopod-files-'));
    // Host worktree only has the OLD file. The new file lives only in the container.
    await writeFile(path.join(tmp, 'OLD.md'), '# old');

    execMock = vi.fn();
    readMock = vi.fn();

    const cm: Partial<ContainerManager> = {
      execInContainer: (_id: string, command: string[], _opts?: ExecOptions): Promise<ExecResult> =>
        execMock(command),
      readFile: (id: string, p: string): Promise<string> => readMock(id, p),
    };

    app = Fastify();
    filesRoutes(
      app,
      podManager({ worktreePath: tmp, containerId: 'c1', executionTarget: 'docker' }),
      makeFactory(cm),
    );
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await rm(tmp, { recursive: true, force: true });
  });

  it('lists files from the container when one is attached, ignoring the stale host worktree', async () => {
    execMock.mockResolvedValue({
      exitCode: 0,
      stderr: '',
      // tab-separated %P\t%s\t%T@\n — single in-container file
      stdout: 'docs/legacy-plugin-migration/ZERO-DEP-ANALYSIS.md\t1234\t1714831234.5\n',
    });

    const res = await app.inject({ method: 'GET', url: '/pods/abc/files' });
    expect(res.statusCode).toBe(200);
    const files = res.json().files as FileEntry[];
    const paths = files.map((f) => f.path);
    expect(paths).toEqual(['docs/legacy-plugin-migration/ZERO-DEP-ANALYSIS.md']);
    expect(paths).not.toContain('OLD.md'); // host worktree should not be walked

    // Verify the find command shape: starts in /workspace, uses -prune for skip dirs.
    expect(execMock).toHaveBeenCalledOnce();
    const cmd = execMock.mock.calls[0][0] as string[];
    expect(cmd[0]).toBe('find');
    expect(cmd[1]).toBe('/workspace');
    expect(cmd).toContain('-prune');
    expect(cmd).toContain('-printf');
    expect(cmd).toContain('*.md');
  });

  it('falls back to host worktree when the container exec fails', async () => {
    execMock.mockRejectedValue(new Error('container stopped'));

    const res = await app.inject({ method: 'GET', url: '/pods/abc/files' });
    expect(res.statusCode).toBe(200);
    const paths = (res.json().files as FileEntry[]).map((f) => f.path);
    expect(paths).toContain('OLD.md');
  });

  it('reads file content from the container, scoped to /workspace', async () => {
    execMock.mockResolvedValue({
      exitCode: 0,
      stderr: '',
      stdout: 'regular file\t1234\n',
    });
    readMock.mockResolvedValue('# fresh content from container');

    const res = await app.inject({
      method: 'GET',
      url: '/pods/abc/files/content',
      query: { path: 'docs/foo.md' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().content).toBe('# fresh content from container');

    // stat is invoked with absolute container path under /workspace
    const statCmd = execMock.mock.calls[0][0] as string[];
    expect(statCmd[0]).toBe('stat');
    expect(statCmd).toContain('/workspace/docs/foo.md');
    expect(readMock).toHaveBeenCalledWith('c1', '/workspace/docs/foo.md');
  });

  it('returns 413 for files in the container that exceed the size cap', async () => {
    execMock.mockResolvedValue({
      exitCode: 0,
      stderr: '',
      stdout: `regular file\t${1024 * 1024 * 5}\n`,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/pods/abc/files/content',
      query: { path: 'big.md' },
    });
    expect(res.statusCode).toBe(413);
    expect(readMock).not.toHaveBeenCalled();
  });

  it('rejects path-traversal attempts before exec', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/pods/abc/files/content',
      query: { path: '../etc/passwd' },
    });
    expect(res.statusCode).toBe(400);
    expect(execMock).not.toHaveBeenCalled();
    expect(readMock).not.toHaveBeenCalled();
  });

  it('rejects absolute paths before exec', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/pods/abc/files/content',
      query: { path: '/etc/passwd' },
    });
    expect(res.statusCode).toBe(400);
    expect(execMock).not.toHaveBeenCalled();
  });

  it('falls back to host worktree when in-container stat fails', async () => {
    // stat in container returns non-zero (file doesn't exist there).
    execMock.mockResolvedValue({ exitCode: 1, stderr: 'no such file', stdout: '' });

    const res = await app.inject({
      method: 'GET',
      url: '/pods/abc/files/content',
      query: { path: 'OLD.md' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().content).toBe('# old');
    expect(readMock).not.toHaveBeenCalled();
  });
});
