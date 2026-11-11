import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { artifactChecksError } from './artifact-checks-recovery-repository.js';
import { fingerprintPreservedWorkspace } from './artifact-snapshot-receipt.js';

/** Check every captured entry, while allowing separately generated build/report files.
 * Never ignore changed/missing source, directory modes, links or replaced entry types.
 */
export async function verifyArtifactExecutionSource(
  snapshot: string,
  workspace: string,
  assertCurrent: () => void,
): Promise<void> {
  const selected = new Set<string>();
  async function visit(relative: string): Promise<void> {
    assertCurrent();
    const entry = await lstat(path.join(snapshot, relative));
    selected.add(relative);
    if (entry.isDirectory()) {
      for (const name of (await readdir(path.join(snapshot, relative))).sort())
        await visit(path.join(relative, name));
    } else if (!entry.isFile()) {
      artifactChecksError('Captured artifact source contains unsupported entries');
    }
  }
  await visit('');
  const expectedRoot = await lstat(snapshot);
  const currentRoot = await lstat(workspace);
  if (!currentRoot.isDirectory() || currentRoot.mode !== expectedRoot.mode)
    artifactChecksError('Independent execution source root changed');
  const exclude = (relative: string) => !selected.has(relative);
  const expected = await fingerprintPreservedWorkspace(snapshot, assertCurrent, exclude);
  const actual = await fingerprintPreservedWorkspace(workspace, assertCurrent, exclude);
  // The projected inventory deliberately neutralizes the root mode. Bind it
  // separately before AND after inventory; all selected child modes stay hashed.
  if (
    actual.sha256 !== expected.sha256 ||
    actual.entries !== expected.entries ||
    actual.bytes !== expected.bytes ||
    (await lstat(workspace)).mode !== expectedRoot.mode ||
    (await lstat(snapshot)).mode !== expectedRoot.mode
  )
    artifactChecksError('Independent execution changed captured artifact source');
  assertCurrent();
}
