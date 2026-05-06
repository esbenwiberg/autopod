import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ScreenshotRef, ScreenshotSource } from '@autopod/shared';

export type { ScreenshotRef, ScreenshotSource };

/** On-disk screenshot store — one directory tree per pod. */
export interface ScreenshotStore {
  /** Write a PNG to the per-pod source bucket; returns the canonical ref. */
  write(podId: string, source: ScreenshotSource, filename: string, bytes: Buffer): Promise<ScreenshotRef>;
  /** Read raw bytes for serving via HTTP / inline embedding. */
  read(ref: ScreenshotRef): Promise<Buffer>;
  /**
   * List all refs for a pod in canonical order:
   * smoke → ac → review, filename-sorted within each bucket.
   */
  list(podId: string): Promise<ScreenshotRef[]>;
  /** Delete the entire per-pod tree. Idempotent (no error when dir is missing). */
  delete(podId: string): Promise<void>;
}

/** Whitelist for safe filename characters (extension already forced to `.png`). */
const SAFE_FILENAME_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Validate a caller-supplied filename.
 * - Must match the whitelist `[A-Za-z0-9._-]+`
 * - Must not contain `..` segments
 * - Must not contain path separators
 * - Extension is coerced to lowercase `.png`; non-`.png` extension throws.
 */
function validateFilename(filename: string): string {
  if (!filename || filename.includes('/') || filename.includes('\\')) {
    throw new Error(`Screenshot filename must not contain path separators: ${JSON.stringify(filename)}`);
  }
  if (filename.includes('..')) {
    throw new Error(`Screenshot filename must not contain '..': ${JSON.stringify(filename)}`);
  }
  // Coerce extension to lowercase before whitelist check
  const lower = filename.slice(0, -path.extname(filename).length) + path.extname(filename).toLowerCase();
  if (!lower.endsWith('.png')) {
    throw new Error(`Screenshot filename must have .png extension: ${JSON.stringify(filename)}`);
  }
  const base = lower.slice(0, -4); // strip .png
  if (!SAFE_FILENAME_RE.test(lower) || !base) {
    throw new Error(`Screenshot filename contains invalid characters (allowed: [A-Za-z0-9._-]): ${JSON.stringify(filename)}`);
  }
  return lower;
}

const SOURCE_ORDER: ScreenshotSource[] = ['smoke', 'ac', 'review'];

/**
 * Create a filesystem-backed screenshot store.
 *
 * On-disk layout:
 *   <dataDir>/screenshots/<podId>/<source>/<filename>.png
 *
 * `dataDir` follows the same resolution as pod-manager.ts:4520:
 *   process.env.DATA_DIR ?? path.join(process.cwd(), '.autopod-data')
 */
export function createScreenshotStore(dataDir: string): ScreenshotStore {
  function podDir(podId: string): string {
    return path.join(dataDir, 'screenshots', podId);
  }

  function sourceDir(podId: string, source: ScreenshotSource): string {
    return path.join(podDir(podId), source);
  }

  function refToPath(ref: ScreenshotRef): string {
    return path.join(dataDir, ref.relativePath);
  }

  return {
    async write(podId, source, filename, bytes) {
      const safe = validateFilename(filename);
      const dir = sourceDir(podId, source);
      await fsp.mkdir(dir, { recursive: true });

      const filePath = path.join(dir, safe);
      const tmpPath = `${filePath}.${Math.random().toString(36).slice(2)}.tmp`;

      // Atomic write: write to a uniquely-named .tmp sibling, rename into place
      // (last writer wins; unique suffix prevents concurrent-write collisions)
      await fsp.writeFile(tmpPath, bytes);
      await fsp.rename(tmpPath, filePath);

      const relativePath = path.join('screenshots', podId, source, safe);
      return { podId, source, filename: safe, relativePath };
    },

    async read(ref) {
      return fsp.readFile(refToPath(ref));
    },

    async list(podId) {
      const refs: ScreenshotRef[] = [];
      const base = podDir(podId);

      for (const source of SOURCE_ORDER) {
        const dir = path.join(base, source);
        let entries: string[];
        try {
          entries = await fsp.readdir(dir);
        } catch {
          continue; // bucket doesn't exist yet — skip
        }
        const pngs = entries.filter((f) => f.endsWith('.png')).sort();
        for (const filename of pngs) {
          refs.push({
            podId,
            source,
            filename,
            relativePath: path.join('screenshots', podId, source, filename),
          });
        }
      }

      return refs;
    },

    async delete(podId) {
      const dir = podDir(podId);
      try {
        await fsp.rm(dir, { recursive: true, force: true });
      } catch (err) {
        // ENOENT is idempotent; rethrow anything unexpected
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    },
  };
}

/** Resolve the data directory (same logic as pod-manager.ts:4520). */
export function resolveDataDir(): string {
  return process.env.DATA_DIR ?? path.join(process.cwd(), '.autopod-data');
}

/**
 * Slugify a URL page path into a safe filename base (without extension).
 * Replaces non-alphanumeric characters with underscores, strips leading/trailing underscores.
 * Falls back to 'root' for paths that reduce to nothing (e.g. '/').
 * Includes a 0-based index prefix to avoid clashes between paths like `/foo` and `/foo/`.
 */
export function slugifyPagePath(pagePath: string, idx: number): string {
  const base =
    pagePath
      .replace(/[^A-Za-z0-9]/g, '_')
      .replace(/^_+|_+$/g, '') || 'root';
  return `${idx}-${base}`;
}
