import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { BlobTransport } from './artifact-store.js';

/** Daemon-owned immutable storage for a local installation. Workers never mount this root. */
export class FileBlobTransport implements BlobTransport {
  constructor(private readonly root: string) {
    if (!path.isAbsolute(root)) throw new Error('artifact-local-root-invalid');
  }

  private async location(name: string): Promise<string> {
    if (!name || name.startsWith('/') || name.split('/').some((p) => !p || p === '..' || p === '.'))
      throw new Error('artifact-unsafe-object-name');
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0)
      throw new Error('artifact-local-root-invalid');
    return path.join(this.root, createHash('sha256').update(name).digest('hex'));
  }

  async putIfAbsent(name: string, bytes: Buffer): Promise<void> {
    const destination = await this.location(name);
    const temporary = path.join(this.root, `.pending-${randomUUID()}`);
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
      await file.close();
      try {
        // Atomic publication without replacing a concurrent writer's object.
        await link(temporary, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (!(await this.get(name)).equals(bytes)) throw new Error('artifact-immutable-conflict');
      }
      const directory = await open(this.root, 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await file.close();
      await unlink(temporary).catch(() => undefined);
    }
  }

  async get(name: string): Promise<Buffer> {
    const location = await this.location(name);
    const stat = await lstat(location);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('artifact-local-object-invalid');
    return readFile(location);
  }
}
