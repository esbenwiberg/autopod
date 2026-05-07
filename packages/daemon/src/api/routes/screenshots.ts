import type { ScreenshotSource } from '@autopod/shared';
import type { FastifyInstance } from 'fastify';
import type { ScreenshotStore } from '../../pods/screenshot-store.js';

const VALID_SOURCES: ReadonlySet<ScreenshotSource> = new Set<ScreenshotSource>([
  'smoke',
  'ac',
  'review',
]);

function isScreenshotSource(value: string): value is ScreenshotSource {
  return VALID_SOURCES.has(value as ScreenshotSource);
}

/**
 * Matches filenames that are safe to serve: [A-Za-z0-9._-]+.png
 * Defence-in-depth against path traversal — the store also validates, but the
 * route must not construct a ref the store can't handle.
 */
const SAFE_FILENAME_RE = /^[A-Za-z0-9._-]+\.png$/;

export function screenshotRoutes(app: FastifyInstance, screenshotStore: ScreenshotStore): void {
  // GET /pods/:podId/screenshots/:source/:filename
  // Returns the raw PNG bytes for a stored proof-of-work screenshot.
  // Auth: default (Bearer token) — matches the auth posture of files.ts.
  // Cache-Control: immutable per-pod path; bytes are stable until retention deletes them.
  app.get('/pods/:podId/screenshots/:source/:filename', async (request, reply) => {
    const { podId, source, filename } = request.params as {
      podId: string;
      source: string;
      filename: string;
    };

    if (!isScreenshotSource(source)) {
      reply.status(400);
      return { error: 'source must be one of: smoke, ac, review' };
    }

    if (filename.includes('..') || filename.includes('/') || !SAFE_FILENAME_RE.test(filename)) {
      reply.status(400);
      return {
        error:
          'filename must match ^[A-Za-z0-9._-]+\\.png$ and must not contain path separators or ..',
      };
    }

    // source is narrowed to ScreenshotSource by the guard above
    const ref = {
      podId,
      source,
      filename,
      relativePath: `screenshots/${podId}/${source}/${filename}`,
    };

    let bytes: Buffer;
    try {
      bytes = await screenshotStore.read(ref);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        reply.status(404);
        return { error: 'Screenshot not found' };
      }
      throw err;
    }

    reply.header('Content-Type', 'image/png');
    reply.header('Content-Length', String(bytes.length));
    reply.header('Cache-Control', 'private, max-age=31536000, immutable');
    return reply.send(bytes);
  });
}
