import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createScreenshotStore, slugifyPagePath } from './screenshot-store.js';

// Minimal 4×4 PNG (8 bytes header + IHDR + IDAT + IEND — valid enough for buffer tests)
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000004000000040806000000a9f1' +
    '9e7e00000001735247424201d9c92c0000000c4944415478016360606000' +
    '0000040001f6178d530000000049454e44ae426082',
  'hex',
);

describe('ScreenshotStore', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'screenshot-store-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ── write + read round-trip ──────────────────────────────────────

  it('write and read round-trip for smoke source', async () => {
    const store = createScreenshotStore(tmpDir);
    const ref = await store.write('pod1', 'smoke', 'root.png', TINY_PNG);
    expect(ref.podId).toBe('pod1');
    expect(ref.source).toBe('smoke');
    expect(ref.filename).toBe('root.png');
    expect(ref.relativePath).toBe('screenshots/pod1/smoke/root.png');

    const bytes = await store.read(ref);
    expect(bytes).toEqual(TINY_PNG);
  });

  it('write and read round-trip for ac source', async () => {
    const store = createScreenshotStore(tmpDir);
    const ref = await store.write('pod2', 'ac', '0-check.png', TINY_PNG);
    const bytes = await store.read(ref);
    expect(bytes).toEqual(TINY_PNG);
    expect(ref.source).toBe('ac');
  });

  it('write and read round-trip for review source', async () => {
    const store = createScreenshotStore(tmpDir);
    const ref = await store.write('pod3', 'review', 'screenshot.png', TINY_PNG);
    const bytes = await store.read(ref);
    expect(bytes).toEqual(TINY_PNG);
    expect(ref.source).toBe('review');
  });

  // ── filename sanitisation ────────────────────────────────────────

  it('rejects path traversal filename', async () => {
    const store = createScreenshotStore(tmpDir);
    await expect(store.write('pod1', 'smoke', '../evil.png', TINY_PNG)).rejects.toThrow();
  });

  it('rejects filename with forward slash', async () => {
    const store = createScreenshotStore(tmpDir);
    await expect(store.write('pod1', 'smoke', 'sub/dir.png', TINY_PNG)).rejects.toThrow(
      'path separators',
    );
  });

  it('rejects filename with backslash', async () => {
    const store = createScreenshotStore(tmpDir);
    await expect(store.write('pod1', 'smoke', 'sub\\dir.png', TINY_PNG)).rejects.toThrow(
      'path separators',
    );
  });

  it('rejects non-PNG extension', async () => {
    const store = createScreenshotStore(tmpDir);
    await expect(store.write('pod1', 'smoke', 'root.jpg', TINY_PNG)).rejects.toThrow('.png');
  });

  it('rejects filename with special characters', async () => {
    const store = createScreenshotStore(tmpDir);
    await expect(store.write('pod1', 'smoke', 'ro!ot.png', TINY_PNG)).rejects.toThrow(
      'invalid characters',
    );
  });

  it('coerces uppercase .PNG extension to .png', async () => {
    const store = createScreenshotStore(tmpDir);
    const ref = await store.write('pod1', 'smoke', 'ROOT.PNG', TINY_PNG);
    expect(ref.filename).toBe('ROOT.png');
  });

  it('rejects empty filename', async () => {
    const store = createScreenshotStore(tmpDir);
    await expect(store.write('pod1', 'smoke', '', TINY_PNG)).rejects.toThrow();
  });

  // ── list ordering invariant ──────────────────────────────────────

  it('list returns refs in smoke→ac→review order, filename-sorted within bucket', async () => {
    const store = createScreenshotStore(tmpDir);
    const podId = 'pod-list';
    // Write out-of-canonical-order
    await store.write(podId, 'review', 'z.png', TINY_PNG);
    await store.write(podId, 'ac', 'b.png', TINY_PNG);
    await store.write(podId, 'smoke', 'b.png', TINY_PNG);
    await store.write(podId, 'ac', 'a.png', TINY_PNG);
    await store.write(podId, 'smoke', 'a.png', TINY_PNG);
    await store.write(podId, 'review', 'a.png', TINY_PNG);

    const refs = await store.list(podId);
    expect(refs.map((r) => `${r.source}/${r.filename}`)).toEqual([
      'smoke/a.png',
      'smoke/b.png',
      'ac/a.png',
      'ac/b.png',
      'review/a.png',
      'review/z.png',
    ]);
  });

  it('list returns empty array for pod with no screenshots', async () => {
    const store = createScreenshotStore(tmpDir);
    const refs = await store.list('nonexistent-pod');
    expect(refs).toEqual([]);
  });

  it('list returns only existing buckets', async () => {
    const store = createScreenshotStore(tmpDir);
    await store.write('pod-partial', 'smoke', 'root.png', TINY_PNG);
    const refs = await store.list('pod-partial');
    expect(refs).toHaveLength(1);
    expect(refs[0]?.source).toBe('smoke');
  });

  // ── delete idempotency ───────────────────────────────────────────

  it('delete removes the per-pod tree', async () => {
    const store = createScreenshotStore(tmpDir);
    await store.write('pod-del', 'smoke', 'root.png', TINY_PNG);
    await store.delete('pod-del');
    const refs = await store.list('pod-del');
    expect(refs).toEqual([]);
  });

  it('delete is idempotent — second call is a no-op', async () => {
    const store = createScreenshotStore(tmpDir);
    await store.write('pod-del2', 'smoke', 'root.png', TINY_PNG);
    await store.delete('pod-del2');
    // Second delete should not throw
    await expect(store.delete('pod-del2')).resolves.toBeUndefined();
  });

  it('delete on nonexistent pod is a no-op', async () => {
    const store = createScreenshotStore(tmpDir);
    await expect(store.delete('never-written')).resolves.toBeUndefined();
  });

  // ── concurrent writes ────────────────────────────────────────────

  it('concurrent writes for the same (podId, source, filename) — last writer wins, no torn files', async () => {
    const store = createScreenshotStore(tmpDir);
    const bufA = Buffer.alloc(1024, 0xaa);
    const bufB = Buffer.alloc(1024, 0xbb);

    // Fire off many concurrent writes for the same file
    const writes = [
      ...Array.from({ length: 5 }, () => store.write('pod-conc', 'smoke', 'shot.png', bufA)),
      ...Array.from({ length: 5 }, () => store.write('pod-conc', 'smoke', 'shot.png', bufB)),
    ];
    const refs = await Promise.all(writes);

    // All refs should describe the same location
    for (const ref of refs) {
      expect(ref.filename).toBe('shot.png');
      expect(ref.source).toBe('smoke');
    }

    // The file should be one of the two buffers (no torn writes)
    const bytes = await store.read(refs[0]!);
    const isA = bytes.equals(bufA);
    const isB = bytes.equals(bufB);
    expect(isA || isB).toBe(true);
  });
});

// ── slugifyPagePath ──────────────────────────────────────────────────────────

describe('slugifyPagePath', () => {
  it('converts / to root with index prefix', () => {
    expect(slugifyPagePath('/', 0)).toBe('0-root');
  });

  it('includes path segments', () => {
    expect(slugifyPagePath('/about', 1)).toBe('1-about');
  });

  it('separates segments with underscores', () => {
    expect(slugifyPagePath('/foo/bar', 2)).toBe('2-foo_bar');
  });

  it('disambiguates /foo and /foo/ via index', () => {
    const a = slugifyPagePath('/foo', 0);
    const b = slugifyPagePath('/foo/', 1);
    expect(a).not.toBe(b);
  });

  it('strips leading and trailing underscores', () => {
    expect(slugifyPagePath('///deep///', 3)).toBe('3-deep');
  });
});
