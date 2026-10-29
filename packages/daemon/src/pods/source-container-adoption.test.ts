import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSourceContainerFixture } from '../test-utils/source-container-helpers.js';
import { verifyArtifactSnapshot } from './artifact-snapshot-receipt.js';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(options: { ignoredCollision?: boolean } = {}) {
  const value = await createSourceContainerFixture(options);
  roots.push(value.root);
  return value;
}
describe('retained container source application (local real-Git adapter)', () => {
  it('transfers verified history and fast-forwards exact source without deleting ignored reports or using network Git', async () => {
    const s = await fixture();
    await s.adapter.apply();
    expect((await s.git(s.guest, 'rev-parse', 'HEAD')).stdout.trim()).toBe(s.target);
    expect(await readFile(path.join(s.guest, 'code.txt'), 'utf8')).toBe('repaired');
    expect(await readFile(path.join(s.guest, 'ignored-report.bin'))).toEqual(
      Buffer.from([0, 1, 255]),
    );
    expect(await readFile(path.join(s.snapshots.container, 'code.txt'), 'utf8')).toBe('original');
    await verifyArtifactSnapshot(
      s.snapshots.container,
      path.dirname(s.snapshots.container),
      s.record.binding.generation,
      0,
    );
    expect(() => s.journal.commands.assertSettled('source-adapter')).not.toThrow();
    expect(s.cm.execInContainer).not.toHaveBeenCalled();
    expect(s.cm.start).not.toHaveBeenCalled();
    expect(s.cm.spawn).not.toHaveBeenCalled();
    const calls = vi.mocked(s.cm.execStreaming).mock.calls;
    expect(calls.some((call) => call[1].includes('--no-overwrite-ignore'))).toBe(true);
    expect(
      calls.some(
        (call) =>
          call[1].includes('--hard') || call[1].includes('clean') || call[1].includes('push'),
      ),
    ).toBe(false);
  });
  it('refuses ignored-report collisions during actual Git fast-forward and retains the original bytes', async () => {
    const s = await fixture({ ignoredCollision: true });
    await expect(s.adapter.apply()).rejects.toMatchObject({ code: 'SOURCE_COMMAND_FAILED' });
    expect((await s.git(s.guest, 'rev-parse', 'HEAD')).stdout.trim()).toBe(s.old);
    expect(await readFile(path.join(s.guest, 'ignored-report.bin'))).toEqual(
      Buffer.from([0, 1, 255]),
    );
    expect(s.journal.get('source-adapter')?.stage).toBe('applying');
    expect(() => s.journal.commands.assertSettled('source-adapter')).not.toThrow();
  });
  it('refuses a changed namespace before any command or file transfer', async () => {
    const s = await fixture();
    s.cm.getResourceKey.mockResolvedValue('other:namespace');
    await expect(s.adapter.apply()).rejects.toMatchObject({ code: 'SOURCE_RESOURCE_SUPERSEDED' });
    expect(s.cm.execStreaming).not.toHaveBeenCalled();
    expect(s.cm.writeFile).not.toHaveBeenCalled();
    expect((await s.git(s.guest, 'rev-parse', 'HEAD')).stdout.trim()).toBe(s.old);
  });
  it('does not retry or assemble after an outcome-unknown chunk write', async () => {
    const s = await fixture();
    vi.mocked(s.cm.writeFile).mockRejectedValue(new Error('Lost upload acknowledgement'));
    await expect(s.adapter.apply()).rejects.toThrow('Lost upload acknowledgement');
    expect(s.cm.writeFile).toHaveBeenCalledTimes(1);
    expect(s.journal.commands.get('source-adapter', 'assemble-bundle')).toBeNull();
    expect(s.journal.commands.get('source-adapter', 'fast-forward')).toBeNull();
    expect((await s.git(s.guest, 'rev-parse', 'HEAD')).stdout.trim()).toBe(s.old);
    expect(await readFile(path.join(s.guest, 'ignored-report.bin'))).toEqual(
      Buffer.from([0, 1, 255]),
    );
    expect(s.journal.get('source-adapter')?.stage).toBe('applying');
  });
});
