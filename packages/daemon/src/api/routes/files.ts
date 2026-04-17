import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { PodManager } from '../../pods/pod-manager.js';

interface FileEntry {
  path: string;
  size: number;
  modified: number;
}

interface ListResponse {
  files: FileEntry[];
}

interface ContentResponse {
  path: string;
  content: string;
  size: number;
}

const DEFAULT_EXTENSIONS = ['md'];
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_LIST_FILES = 2000;
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.turbo',
  '.next',
  '.nuxt',
  'out',
  'coverage',
  '.cache',
  '.vs',
  'bin',
  'obj',
]);

export function filesRoutes(app: FastifyInstance, podManager: PodManager): void {
  // GET /pods/:podId/files — list files in the pod worktree filtered by extension.
  app.get('/pods/:podId/files', async (request, reply) => {
    const { podId } = request.params as { podId: string };
    const query = request.query as { ext?: string };
    const pod = podManager.getSession(podId);

    const rootPath = pod.worktreePath ?? pod.artifactsPath;
    if (!rootPath) {
      reply.status(404);
      return { error: 'No files available for this pod' };
    }

    const extensions = parseExtensions(query.ext);
    const root = path.resolve(rootPath);
    const files = await walk(root, extensions);
    files.sort((a, b) => a.path.localeCompare(b.path));

    return { files } satisfies ListResponse;
  });

  // GET /pods/:podId/files/content?path=... — read a file from the pod worktree.
  app.get('/pods/:podId/files/content', async (request, reply) => {
    const { podId } = request.params as { podId: string };
    const query = request.query as { path?: string };
    const pod = podManager.getSession(podId);

    const rootPath = pod.worktreePath ?? pod.artifactsPath;
    if (!rootPath) {
      reply.status(404);
      return { error: 'No files available for this pod' };
    }

    const relPath = query.path;
    if (!relPath || typeof relPath !== 'string') {
      reply.status(400);
      return { error: 'path query parameter is required' };
    }

    const root = path.resolve(rootPath);
    const resolved = path.resolve(root, relPath);
    // Path-traversal guard — resolved must stay under the root.
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
      reply.status(400);
      return { error: 'path escapes the pod root' };
    }

    let stats: Awaited<ReturnType<typeof stat>>;
    try {
      stats = await stat(resolved);
    } catch {
      reply.status(404);
      return { error: 'file not found' };
    }

    if (!stats.isFile()) {
      reply.status(400);
      return { error: 'path is not a regular file' };
    }
    if (stats.size > MAX_FILE_BYTES) {
      reply.status(413);
      return { error: `file exceeds ${MAX_FILE_BYTES} bytes` };
    }

    const content = await readFile(resolved, 'utf8');
    return {
      path: path.relative(root, resolved),
      content,
      size: stats.size,
    } satisfies ContentResponse;
  });
}

function parseExtensions(ext: string | undefined): Set<string> {
  const raw = (ext ?? DEFAULT_EXTENSIONS.join(',')).split(',');
  const cleaned = raw
    .map((e) => e.trim().toLowerCase().replace(/^\./, ''))
    .filter((e) => e.length > 0 && /^[a-z0-9]+$/.test(e));
  return new Set(cleaned.length > 0 ? cleaned : DEFAULT_EXTENSIONS);
}

async function walk(root: string, extensions: Set<string>): Promise<FileEntry[]> {
  const out: FileEntry[] = [];

  async function visit(dir: string): Promise<void> {
    if (out.length >= MAX_LIST_FILES) return;

    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (out.length >= MAX_LIST_FILES) return;
      if (entry.name.startsWith('.') && entry.name !== '.') {
        if (entry.isDirectory()) continue;
      }

      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await visit(full);
        continue;
      }

      if (!entry.isFile()) continue;

      const ext = path.extname(entry.name).slice(1).toLowerCase();
      if (!extensions.has(ext)) continue;

      try {
        const stats = await stat(full);
        out.push({
          path: path.relative(root, full),
          size: stats.size,
          modified: stats.mtimeMs,
        });
      } catch {
        // File disappeared between readdir and stat — skip it.
      }
    }
  }

  await visit(root);
  return out;
}
