import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, symlink } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import type { Logger } from 'pino';
import { extract } from 'tar-stream';
import type { DirectoryExtractionOptions } from '../interfaces/container-manager.js';
import { assertDirectoryExtractionCurrent } from './directory-extraction-ownership.js';
import type { SandboxApiClient } from './sandbox-api-client.js';

// Each readFile response is buffered by the data-plane client. Never download an
// unbounded archive, or use buffered exec stdout to transport binary contents.
const CHUNK_BYTES = 8 * 1024 * 1024;

/** Full workspace export avoids one remote request per dependency/source file. */
export async function exportSandboxWorkspace(
  client: SandboxApiClient,
  sandboxId: string,
  root: string,
  staging: string,
  options?: DirectoryExtractionOptions,
  logger?: Pick<Logger, 'warn'>,
): Promise<void> {
  const remote = `/tmp/.autopod-export-${randomUUID()}`;
  try {
    assertDirectoryExtractionCurrent(options);
    const result = await client.exec(
      sandboxId,
      [
        'sh',
        '-c',
        'set -e; mkdir -m 700 -- "$2"; tar --hard-dereference -czf "$2/archive" -C "$1" .; split -b "$3" -d -a 8 "$2/archive" "$2/part-"; rm -- "$2/archive"',
        'autopod-workspace-export',
        root,
        remote,
        String(CHUNK_BYTES),
      ],
      { timeoutMs: 120_000 },
    );
    // GNU tar can exit zero while warning that sockets were omitted. A full
    // workspace snapshot must not silently lose entries the old copy rejected.
    if (result.exitCode !== 0 || result.stderr.trim().length > 0) {
      throw new Error(
        `Sandbox workspace archive failed (exit ${result.exitCode}): ${result.stderr}`,
      );
    }
    assertDirectoryExtractionCurrent(options);
    const listing = await client.listFiles(sandboxId, remote);
    const parts = listing.entries.map((entry) => entry.name).sort();
    if (
      !parts.length ||
      parts.some((name, index) => name !== `part-${String(index).padStart(8, '0')}`)
    ) {
      throw new Error('Sandbox workspace archive has missing or unexpected parts');
    }
    const unpack = extract();
    const links: Array<{ name: string; relative: string; target: string }> = [];
    const directories: Array<{ name: string; mode: number }> = [];
    const seen = new Set<string>();
    unpack.on('entry', (header, stream, next) => {
      void (async () => {
        assertDirectoryExtractionCurrent(options);
        const name = archiveRelativePath(header.name);
        if (seen.has(name)) throw new Error('Duplicate sandbox archive entry');
        seen.add(name);
        const target = join(staging, name);
        if (header.type === 'directory') {
          await mkdir(target, { recursive: true });
          directories.push({ name: target, mode: (header.mode ?? 0o755) & 0o777 });
          stream.resume();
        } else if (header.type === 'symlink' && name && header.linkname) {
          // Create links only after all file writes, so archive members cannot
          // redirect extraction outside staging through an earlier symlink.
          links.push({ name: target, relative: name, target: header.linkname });
          stream.resume();
        } else if (header.type === 'file' && name) {
          await mkdir(dirname(target), { recursive: true });
          await pipeline(stream, createWriteStream(target, { flags: 'wx', mode: 0o600 }));
          await chmod(target, (header.mode ?? 0o644) & 0o777);
        } else {
          throw new Error(`Unsupported sandbox archive entry type: ${header.type}`);
        }
      })().then(
        () => next(),
        (error: Error) => unpack.destroy(error),
      );
    });
    async function* chunks() {
      for (const part of parts) {
        assertDirectoryExtractionCurrent(options);
        const content = await client.readFile(sandboxId, `${remote}/${part}`);
        if (content.length === 0 || content.length > CHUNK_BYTES) {
          throw new Error('Invalid sandbox archive chunk size');
        }
        yield content;
      }
    }
    await pipeline(Readable.from(chunks()), createGunzip(), unpack);
    assertDirectoryExtractionCurrent(options);
    const linkPaths = new Set(links.map((link) => link.relative));
    for (const name of seen) {
      for (let parent = posix.dirname(name); parent !== '.'; parent = posix.dirname(parent)) {
        if (linkPaths.has(parent)) throw new Error('Sandbox archive writes through a symlink');
      }
    }
    for (const link of links) {
      await mkdir(dirname(link.name), { recursive: true });
      await symlink(link.target, link.name);
    }
    // Apply restrictive directory modes after children have been written.
    for (const directory of directories.reverse()) await chmod(directory.name, directory.mode);
  } finally {
    // Keep the source workspace intact on all failures and late completions.
    // Cleanup failure must not mask the original export failure.
    try {
      const cleanup = await client.exec(sandboxId, ['rm', '-rf', '--', remote], {
        timeoutMs: 30_000,
      });
      if (cleanup.exitCode !== 0) {
        logger?.warn(
          { sandboxId, remote, exitCode: cleanup.exitCode },
          'Sandbox export temporary archive cleanup failed',
        );
      }
    } catch (err) {
      logger?.warn({ err, sandboxId, remote }, 'Sandbox export temporary archive cleanup failed');
    }
  }
}

function archiveRelativePath(name: string): string {
  if (posix.isAbsolute(name) || name.includes('\\') || name.split('/').includes('..')) {
    throw new Error('Unsafe sandbox archive entry path');
  }
  const relative = posix.normalize(name).replace(/^\.\//, '').replace(/\/$/, '');
  return relative === '.' ? '' : relative;
}
