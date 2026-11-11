import { chmod, cp, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyArtifactExecutionSource } from './artifact-checks-source.js';
import { fingerprintArtifactSnapshot } from './artifact-snapshot-receipt.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'artifact-source-binding-'));
  roots.push(root);
  const snapshot = path.join(root, 'snapshot');
  const workspace = path.join(root, 'execution');
  await mkdir(path.join(snapshot, 'nested'), { recursive: true });
  await writeFile(path.join(snapshot, 'source.js'), 'export const answer = 42;\n');
  await writeFile(path.join(snapshot, 'nested', 'data.json'), '{"answer":42}\n');
  await cp(snapshot, workspace, { recursive: true });
  // Explicit fixture modes keep negative cases meaningful under any test umask.
  for (const directory of [snapshot, workspace]) {
    await chmod(directory, 0o755);
    await chmod(path.join(directory, 'nested'), 0o755);
    await chmod(path.join(directory, 'source.js'), 0o644);
    await chmod(path.join(directory, 'nested', 'data.json'), 0o644);
  }
  return { snapshot, workspace };
}
describe('source-bound independent artifact execution', () => {
  it('permits new build/report files without changing or omitting captured entries', async () => {
    const f = await fixture();
    const before = await fingerprintArtifactSnapshot(f.snapshot);
    await mkdir(path.join(f.workspace, 'evidence'));
    await writeFile(path.join(f.workspace, 'evidence', 'check.json'), '{"pass":true}\n');
    await writeFile(path.join(f.workspace, 'nested', 'generated.txt'), 'new build output');
    const current = vi.fn();
    await verifyArtifactExecutionSource(f.snapshot, f.workspace, current);
    expect(current).toHaveBeenCalled();
    expect(await fingerprintArtifactSnapshot(f.snapshot)).toEqual(before);
  });
  it.each([
    'content',
    'missing',
    'mode',
    'file-link',
    'directory-link',
    'root-mode',
  ] as const)('refuses a %s change even when source text could otherwise appear unchanged', async (mutation) => {
    const f = await fixture();
    const before = await fingerprintArtifactSnapshot(f.snapshot);
    const source = path.join(f.workspace, 'source.js');
    if (mutation === 'content') await writeFile(source, 'export const answer = 0;\n');
    if (mutation === 'missing') await unlink(source);
    if (mutation === 'mode') await chmod(source, 0o600);
    if (mutation === 'file-link') {
      await unlink(source);
      await symlink(path.join(f.snapshot, 'source.js'), source);
    }
    if (mutation === 'directory-link') {
      await rm(path.join(f.workspace, 'nested'), { recursive: true });
      await symlink(path.join(f.snapshot, 'nested'), path.join(f.workspace, 'nested'));
    }
    if (mutation === 'root-mode') await chmod(f.workspace, 0o700);
    await expect(verifyArtifactExecutionSource(f.snapshot, f.workspace, () => {})).rejects.toThrow(
      'Independent execution',
    );
    expect(await fingerprintArtifactSnapshot(f.snapshot)).toEqual(before);
  });
});
