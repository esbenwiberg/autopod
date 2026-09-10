import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, readlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AutopodError } from '@autopod/shared';

const MAX_ENTRIES = 100_000;
const MAX_BYTES = 1_073_741_824;

async function fingerprint(
  root: string,
): Promise<{ sha256: string; entries: number; bytes: number }> {
  const digest = createHash('sha256');
  let entries = 0;
  let bytes = 0;
  async function visit(relative: string): Promise<void> {
    if (++entries > MAX_ENTRIES) throw new Error('Artifact inventory exceeds 100000 entries');
    const fullPath = path.join(root, relative);
    const before = await lstat(fullPath);
    const metadata = { path: relative, mode: before.mode };
    if (before.isSymbolicLink()) {
      if (!relative) throw new Error('Artifact snapshot root cannot be a symlink');
      digest.update(JSON.stringify({ ...metadata, link: await readlink(fullPath) }));
    } else if (before.isDirectory()) {
      digest.update(JSON.stringify({ ...metadata, type: 'directory' }));
      for (const name of (await readdir(fullPath)).sort()) await visit(path.join(relative, name));
    } else if (before.isFile()) {
      bytes += before.size;
      if (bytes > MAX_BYTES) throw new Error('Artifact inventory exceeds 1 GiB');
      digest.update(JSON.stringify({ ...metadata, type: 'file', size: before.size }));
      const handle = await open(fullPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = await handle.stat();
        if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size)
          throw new Error('Artifact file changed during inventory');
        let readBytes = 0;
        for await (const chunk of handle.createReadStream({ autoClose: false })) {
          readBytes += chunk.length;
          if (readBytes > before.size) throw new Error('Artifact file grew during inventory');
          digest.update(chunk);
        }
        const after = await handle.stat();
        if (
          readBytes !== before.size ||
          after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs ||
          after.ctimeMs !== before.ctimeMs
        )
          throw new Error('Artifact file changed during inventory');
      } finally {
        await handle.close();
      }
    } else {
      throw new Error('Unsupported artifact filesystem entry');
    }
  }
  await visit('');
  return { sha256: digest.digest('hex'), entries, bytes };
}

export async function writeArtifactSnapshotReceipt(
  staging: string,
  snapshot: string,
  generation: number,
  cycle: number,
): Promise<void> {
  const identity = await fingerprint(staging);
  await writeFile(
    `${snapshot}.receipt.json`,
    JSON.stringify({
      version: 1,
      generation,
      cycle,
      snapshot: path.basename(snapshot),
      ...identity,
    }),
    { flag: 'wx', mode: 0o600 },
  );
}

/** Reuse requires the recorded generation and all collected bytes, paths and modes to match. */
export async function verifyArtifactSnapshot(
  snapshot: string,
  artifactRoot: string,
  generation: number,
  cycle = 0,
): Promise<void> {
  try {
    if (
      path.dirname(path.resolve(snapshot)) !== path.resolve(artifactRoot) ||
      !new RegExp(`^generation-${generation}-[0-9a-f-]{36}$`).test(path.basename(snapshot))
    )
      throw new Error('Snapshot location does not match this lifecycle');
    const handle = await open(
      `${snapshot}.receipt.json`,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    let encoded: string;
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.size > 4096) throw new Error('Invalid artifact receipt');
      const buffer = Buffer.alloc(4097);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 4096) throw new Error('Invalid artifact receipt');
      encoded = buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
    const receipt = JSON.parse(encoded);
    if (
      receipt?.version !== 1 ||
      receipt.generation !== generation ||
      receipt.cycle !== cycle ||
      receipt.snapshot !== path.basename(snapshot)
    )
      throw new Error('Artifact receipt does not match this lifecycle');
    const actual = await fingerprint(snapshot);
    if (
      receipt.sha256 !== actual.sha256 ||
      receipt.entries !== actual.entries ||
      receipt.bytes !== actual.bytes
    )
      throw new Error('Artifact snapshot differs from its preservation receipt');
  } catch {
    throw new AutopodError(
      'Saved artifact snapshot could not be verified. Restore its snapshot and receipt before finalizing; the settled worker was not restarted.',
      'ARTIFACT_SNAPSHOT_UNVERIFIED',
      409,
    );
  }
}
