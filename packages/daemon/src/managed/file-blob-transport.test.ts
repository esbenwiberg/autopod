import { mkdtemp, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { FileBlobTransport } from './file-blob-transport.js';

it('atomically publishes immutable bytes under concurrency and survives recreation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'managed-files-'));
  try {
    const first = new FileBlobTransport(root);
    const bytes = Buffer.from('reviewed artifact');
    await Promise.all(
      Array.from({ length: 8 }, () => first.putIfAbsent('pod/artifact/bundle.tar.gz', bytes)),
    );
    const restarted = new FileBlobTransport(root);
    expect(await restarted.get('pod/artifact/bundle.tar.gz')).toEqual(bytes);
    await expect(
      restarted.putIfAbsent('pod/artifact/bundle.tar.gz', Buffer.from('replacement')),
    ).rejects.toThrow('immutable-conflict');
    expect(await readdir(root)).toHaveLength(1);
    await expect(restarted.get('../outside')).rejects.toThrow('unsafe-object-name');
    const alias = `${root}-alias`;
    await symlink(root, alias);
    try {
      await expect(new FileBlobTransport(alias).get('pod/artifact/bundle.tar.gz')).rejects.toThrow(
        'local-root-invalid',
      );
    } finally {
      await rm(alias);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
