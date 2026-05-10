import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { ContainerManager } from '../../interfaces/container-manager.js';
import type { ContainerManagerFactory, PodManager } from '../../pods/pod-manager.js';

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
  /** "base64" when `content` is base64-encoded bytes (binary types like png/pdf).
   *  Absent for utf-8 text. */
  encoding?: 'base64';
}

const DEFAULT_EXTENSIONS = ['md'];
const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** Extensions returned as base64-encoded bytes — utf-8 decoding would corrupt them. */
const BINARY_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'pdf', 'webp', 'ico']);
const MAX_LIST_FILES = 2000;
const CONTAINER_WORKDIR = '/workspace';
const SKIP_DIRS = [
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
  '.venv',
  '.idea',
  '.gradle',
  '.nx',
  '.pnpm-store',
  '.yarn',
  '.vercel',
  '.svelte-kit',
];
const SKIP_DIRS_SET = new Set(SKIP_DIRS);

export function filesRoutes(
  app: FastifyInstance,
  podManager: PodManager,
  containerManagerFactory?: ContainerManagerFactory,
): void {
  // GET /pods/:podId/files — list files in the pod worktree filtered by extension.
  // Prefers the live container's /workspace when available so workspace pods (which
  // only sync /workspace → host worktree at completion) don't appear empty mid-run.
  app.get('/pods/:podId/files', async (request, reply) => {
    const { podId } = request.params as { podId: string };
    const query = request.query as { ext?: string };
    const pod = podManager.getSession(podId);

    const extensions = parseExtensions(query.ext);

    if (containerManagerFactory && pod.containerId) {
      const cm = containerManagerFactory.get(pod.executionTarget);
      const fromContainer = await tryListFromContainer(cm, pod.containerId, extensions);
      if (fromContainer) {
        fromContainer.sort((a, b) => a.path.localeCompare(b.path));
        return { files: fromContainer } satisfies ListResponse;
      }
    }

    const rootPath = pod.worktreePath ?? pod.artifactsPath;
    if (!rootPath) {
      reply.status(404);
      return { error: 'No files available for this pod' };
    }

    const root = path.resolve(rootPath);
    const files = await walk(root, extensions);
    files.sort((a, b) => a.path.localeCompare(b.path));

    return { files } satisfies ListResponse;
  });

  // GET /pods/:podId/files/content?path=... — read a file from the pod worktree.
  // Same container-first preference as the listing endpoint.
  app.get('/pods/:podId/files/content', async (request, reply) => {
    const { podId } = request.params as { podId: string };
    const query = request.query as { path?: string };
    const pod = podManager.getSession(podId);

    const relPath = query.path;
    if (!relPath || typeof relPath !== 'string') {
      reply.status(400);
      return { error: 'path query parameter is required' };
    }

    if (!isSafeContainerRelPath(relPath)) {
      reply.status(400);
      return { error: 'path escapes the pod root' };
    }

    const isBinary = isBinaryPath(relPath);

    if (containerManagerFactory && pod.containerId) {
      const cm = containerManagerFactory.get(pod.executionTarget);
      const fromContainer = await tryReadFromContainer(cm, pod.containerId, relPath, isBinary);
      if (fromContainer === 'too-large') {
        reply.status(413);
        return { error: `file exceeds ${MAX_FILE_BYTES} bytes` };
      }
      if (fromContainer) {
        return fromContainer satisfies ContentResponse;
      }
    }

    const rootPath = pod.worktreePath ?? pod.artifactsPath;
    if (!rootPath) {
      reply.status(404);
      return { error: 'No files available for this pod' };
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

    if (isBinary) {
      const buf = await readFile(resolved);
      return {
        path: path.relative(root, resolved),
        content: buf.toString('base64'),
        size: stats.size,
        encoding: 'base64',
      } satisfies ContentResponse;
    }

    const content = await readFile(resolved, 'utf8');
    return {
      path: path.relative(root, resolved),
      content,
      size: stats.size,
    } satisfies ContentResponse;
  });
}

function isBinaryPath(relPath: string): boolean {
  const ext = path.extname(relPath).slice(1).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
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

      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (SKIP_DIRS_SET.has(entry.name)) continue;
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

async function tryListFromContainer(
  cm: ContainerManager,
  containerId: string,
  extensions: Set<string>,
): Promise<FileEntry[] | null> {
  const cmd = buildContainerFindCommand(extensions);
  let result: Awaited<ReturnType<ContainerManager['execInContainer']>>;
  try {
    result = await cm.execInContainer(containerId, cmd, { timeout: 15_000 });
  } catch {
    return null;
  }
  if (result.exitCode !== 0 && !result.stdout.trim()) {
    return null;
  }

  const out: FileEntry[] = [];
  for (const line of result.stdout.split('\n')) {
    if (out.length >= MAX_LIST_FILES) break;
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const [relPath, sizeStr, mtimeStr] = parts;
    if (!relPath) continue;
    const size = Number(sizeStr);
    const mtimeSec = Number(mtimeStr);
    out.push({
      path: relPath,
      size: Number.isFinite(size) ? size : 0,
      modified: Number.isFinite(mtimeSec) ? mtimeSec * 1000 : 0,
    });
  }
  return out;
}

function buildContainerFindCommand(extensions: Set<string>): string[] {
  const args: string[] = ['find', CONTAINER_WORKDIR];

  // Prune skip-dirs branch: ( -type d ( -name X -o -name Y ... ) ) -prune
  args.push('-type', 'd', '(');
  SKIP_DIRS.forEach((dir, i) => {
    if (i > 0) args.push('-o');
    args.push('-name', dir);
  });
  args.push(')', '-prune', '-o');

  // Match-files branch: -type f ( -name *.md -o -name *.txt ... ) -printf ...
  args.push('-type', 'f', '(');
  [...extensions].forEach((ext, i) => {
    if (i > 0) args.push('-o');
    args.push('-name', `*.${ext}`);
  });
  args.push(')', '-printf', '%P\t%s\t%T@\n');

  return args;
}

async function tryReadFromContainer(
  cm: ContainerManager,
  containerId: string,
  relPath: string,
  isBinary: boolean,
): Promise<ContentResponse | 'too-large' | null> {
  const fullPath = `${CONTAINER_WORKDIR}/${relPath}`;

  let statResult: Awaited<ReturnType<ContainerManager['execInContainer']>>;
  try {
    // %F = file type, %s = size in bytes
    statResult = await cm.execInContainer(containerId, ['stat', '-c', '%F\t%s', fullPath], {
      timeout: 5_000,
    });
  } catch {
    return null;
  }

  if (statResult.exitCode !== 0) {
    return null;
  }

  const [fileType, sizeStr] = statResult.stdout.trim().split('\t');
  if (fileType !== 'regular file' && fileType !== 'regular empty file') {
    return null;
  }
  const size = Number(sizeStr);
  if (!Number.isFinite(size)) return null;
  if (size > MAX_FILE_BYTES) return 'too-large';

  if (isBinary) {
    let buf: Buffer;
    try {
      buf = await cm.readFileBinary(containerId, fullPath);
    } catch {
      return null;
    }
    return { path: relPath, content: buf.toString('base64'), size, encoding: 'base64' };
  }

  let content: string;
  try {
    content = await cm.readFile(containerId, fullPath);
  } catch {
    return null;
  }

  return { path: relPath, content, size };
}

/**
 * Reject any path that could escape /workspace when joined: leading slash,
 * a `..` segment, or a `~` segment. We pass the resulting path as a literal
 * argv to `stat` and `getArchive` (no shell), so the only thing that matters
 * is path resolution, not shell-meta escaping.
 */
function isSafeContainerRelPath(relPath: string): boolean {
  if (relPath.length === 0) return false;
  if (relPath.startsWith('/')) return false;
  const segments = relPath.split('/');
  for (const seg of segments) {
    if (seg === '..' || seg === '~') return false;
  }
  return true;
}
