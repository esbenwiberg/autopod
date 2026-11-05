import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { InputBundleRef } from '@autopod/shared';
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../test-utils/mock-helpers.js';
import { referencePreview } from '../test-utils/reference-preview-helpers.js';
import { deferred } from '../test-utils/resource-helpers.js';
import { InputBundleStore } from './input-bundle-store.js';
import { ReferencePreviewService } from './reference-preview-service.js';
import {
  DockerReferenceRenderer,
  type ReferencePreview,
  verifyReferencePreview,
} from './reference-renderer.js';

const image = `sha256:${'a'.repeat(64)}`;
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function setup(additionalHtml = 0) {
  const db = createTestDb();
  const store = new InputBundleStore(db);
  const bytes = Buffer.from('<!doctype html><p>Reference</p>');
  const { id } = store.create(
    {
      requestKey: randomUUID(),
      files: Array.from({ length: additionalHtml + 1 }, (_, index) => ({
        path: index === 0 ? 'design.html' : `extra-${index}.html`,
        mediaType: 'text/html',
        byteLength: bytes.length,
        sha256: digest(bytes),
      })),
    },
    'owner',
  );
  for (let index = 0; index <= additionalHtml; index++) store.put(id, 'owner', index, bytes);
  const { status: _, ...ref } = store.seal(id, 'owner');
  const preview = referencePreview(ref, 'design.html', image);
  const render = vi.fn().mockResolvedValue(preview);
  return {
    db,
    store,
    ref,
    preview,
    render,
    service: new ReferencePreviewService(store, { image, render }),
  };
}
describe('source-bound reference previews', () => {
  it('authorizes before reading/running, coalesces concurrent renders, and caches immutable bytes', async () => {
    const s = setup();
    try {
      await expect(s.service.render(s.ref.id, 'other', 'design.html')).rejects.toThrow('not found');
      await expect(s.service.render(s.ref.id, 'owner', '../design.html')).rejects.toThrow();
      expect(s.render).not.toHaveBeenCalled();
      const [a, b] = await Promise.all([
        s.service.render(s.ref.id, 'owner', 'design.html'),
        s.service.render(s.ref.id, 'owner', 'design.html'),
      ]);
      expect(a.bytes).toEqual(b.bytes);
      expect(s.render).toHaveBeenCalledTimes(1);
      expect((await s.service.render(s.ref.id, 'owner', 'design.html')).bytes).toEqual(a.bytes);
      expect(s.render).toHaveBeenCalledTimes(1);
      const upgraded = new ReferencePreviewService(s.store, {
        image: `sha256:${'b'.repeat(64)}`,
        render: s.render,
      });
      expect((await upgraded.render(s.ref.id, 'owner', 'design.html')).receipt).toEqual(a.receipt);
      expect(s.render).toHaveBeenCalledTimes(1);
      const inputs = s.store.reviewInputs(s.ref, 'owner', [a]);
      expect(inputs.images[0]).toMatchObject({
        role: 'reference',
        mediaType: 'image/jpeg',
        derivation: { sourceSha256: a.receipt.sourceSha256, rendererImage: image },
      });
      expect(inputs.context).toContain('RENDER PROVENANCE');
      expect(s.store.preview(s.ref, 'owner', 'design.html', `sha256:${'b'.repeat(64)}`)).toBeNull();
    } finally {
      s.db.close();
    }
  });
  it('does not schedule more HTML jobs after review preparation is cancelled', async () => {
    const s = setup(1);
    const stop = new AbortController();
    const ready = deferred<ReferencePreview>();
    try {
      s.render.mockReturnValue(ready.promise);
      const work = s.service.forReview(s.ref, 'owner', stop.signal);
      stop.abort();
      ready.resolve(s.preview);
      await expect(work).rejects.toThrow(/abort/i);
      expect(s.render).toHaveBeenCalledTimes(1);
      expect(s.store.preview(s.ref, 'owner', 'extra-1.html')).toBeNull();
    } finally {
      s.db.close();
    }
  });
  it('rejects forged provenance, mismatched raster dimensions and bytes', () => {
    const s = setup();
    try {
      for (const receipt of [
        { ...s.preview.receipt, sourceSha256: '0'.repeat(64) },
        { ...s.preview.receipt, rendererImage: `sha256:${'b'.repeat(64)}` },
        { ...s.preview.receipt, width: 100 },
        { ...s.preview.receipt, resourceSha256s: ['0'.repeat(64)] },
      ]) {
        expect(() =>
          verifyReferencePreview(
            { ...s.preview, receipt } as ReferencePreview,
            s.ref,
            'design.html',
            image,
          ),
        ).toThrow();
      }
      expect(() =>
        s.store.savePreview(s.ref, 'owner', { ...s.preview, bytes: Buffer.from('not a raster') }),
      ).toThrow();
      expect(() => s.store.preview(s.ref, 'other', 'design.html', image)).toThrow();
    } finally {
      s.db.close();
    }
  });
  it('does not cache failed renders or fall back to a host browser', async () => {
    const s = setup();
    try {
      s.render.mockRejectedValueOnce(new Error('isolated render failed'));
      await expect(s.service.render(s.ref.id, 'owner', 'design.html')).rejects.toThrow(
        'isolated render failed',
      );
      expect(s.store.preview(s.ref, 'owner', 'design.html', image)).toBeNull();
      await s.service.render(s.ref.id, 'owner', 'design.html');
      expect(s.render).toHaveBeenCalledTimes(2);
    } finally {
      s.db.close();
    }
  });
  it('retains immutable preview bytes across backup/restore and retained pins, then sweeps derivatives with unpinned originals', async () => {
    const s = setup();
    const root = await mkdtemp(path.join(tmpdir(), 'reference-preview-backup-'));
    let restored: Database.Database | undefined;
    try {
      const first = s.store.savePreview(s.ref, 'owner', s.preview);
      expect(
        s.store.savePreview(
          s.ref,
          'owner',
          referencePreview(s.ref, 'design.html', `sha256:${'b'.repeat(64)}`),
        ).receipt,
      ).toEqual(first.receipt);
      expect(
        s.store.savePreview(s.ref, 'owner', {
          ...s.preview,
          receipt: { ...s.preview.receipt, capturedAt: '2026-05-02T12:00:00.000Z' },
        }).receipt,
      ).toEqual(first.receipt);
      s.store.pin(s.ref, 'owner', 'retained');
      const filename = path.join(root, 'backup.db');
      await s.db.backup(filename);
      restored = new Database(filename);
      expect(new InputBundleStore(restored).preview(s.ref, 'owner', 'design.html', image)).toEqual(
        first,
      );
      expect(s.store.sweep(Date.now() + 10 * 24 * 3600_000)).toBe(0);
      s.db.prepare('DELETE FROM pod_input_bundles WHERE bundle_id=?').run(s.ref.id);
      expect(s.store.sweep(Date.now() + 10 * 24 * 3600_000)).toBe(1);
      expect(s.db.prepare('SELECT COUNT(*) AS count FROM input_reference_previews').get()).toEqual({
        count: 0,
      });
    } finally {
      restored?.close();
      s.db.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  it('limits preview growth and rejects corrupt originals even when a preview is cached', async () => {
    const s = setup(4);
    try {
      for (const file of s.ref.files.slice(0, 4))
        s.store.savePreview(s.ref, 'owner', referencePreview(s.ref, file.path, image));
      const fifth = s.ref.files[4];
      if (!fifth) throw new Error('Missing quota fixture');
      expect(() =>
        s.store.savePreview(s.ref, 'owner', referencePreview(s.ref, fifth.path, image)),
      ).toThrow('quota');
      s.db.prepare('DELETE FROM input_reference_previews').run();
      await s.service.render(s.ref.id, 'owner', 'design.html');
      s.db.prepare('DELETE FROM input_bundle_files WHERE bundle_id=?').run(s.ref.id);
      await expect(s.service.render(s.ref.id, 'owner', 'design.html')).rejects.toThrow();
      await expect(
        s.service.renderAdmitted({ ...s.ref, digest: '0'.repeat(64) }, 'owner', 'design.html'),
      ).rejects.toThrow();
    } finally {
      s.db.close();
    }
  });
  it('blocks new allocations after unconfirmed cleanup', async () => {
    const s = setup();
    const remove = vi.fn().mockRejectedValue({ statusCode: 500 });
    const createContainer = vi
      .fn()
      .mockResolvedValue({ attach: vi.fn().mockRejectedValue(new Error('attach failed')), remove });
    const docker = { createContainer } as unknown as ConstructorParameters<
      typeof DockerReferenceRenderer
    >[0];
    try {
      const renderer = new DockerReferenceRenderer(docker, image);
      await expect(
        renderer.render(s.ref, 'design.html', [Buffer.from('<!doctype html><p>Reference</p>')]),
      ).rejects.toMatchObject({ code: 'REFERENCE_RENDER_CLEANUP_UNCERTAIN' });
      await expect(renderer.render(s.ref, 'design.html', [])).rejects.toMatchObject({
        code: 'REFERENCE_RENDER_CLEANUP_UNCERTAIN',
      });
      expect(createContainer).toHaveBeenCalledTimes(1);
      expect(await renderer.available()).toBe(false);
    } finally {
      s.db.close();
    }
  });
  it('requires content-pinned images and bounded sandbox configuration', async () => {
    const createContainer = vi.fn().mockRejectedValue(new Error('fixture stops before allocating'));
    const docker = { createContainer } as unknown as ConstructorParameters<
      typeof DockerReferenceRenderer
    >[0];
    expect(() => new DockerReferenceRenderer(docker, 'worker:latest')).toThrow();
    const s = setup();
    try {
      await expect(
        new DockerReferenceRenderer(docker, image).render(s.ref as InputBundleRef, 'design.html', [
          Buffer.from('<!doctype html><p>Reference</p>'),
        ]),
      ).rejects.toThrow('Isolated reference renderer is unavailable');
      expect(createContainer.mock.calls[0]?.[0]).toMatchObject({
        Image: image,
        User: '1000:1000',
        Env: ['HOME=/tmp/reference-home'],
        HostConfig: {
          NetworkMode: 'none',
          ReadonlyRootfs: true,
          CapDrop: ['ALL'],
          AutoRemove: true,
          LogConfig: { Type: 'none' },
          Memory: 1024 ** 3,
          PidsLimit: 256,
        },
      });
      expect(createContainer.mock.calls[0]?.[0].HostConfig.Binds).toBeUndefined();
    } finally {
      s.db.close();
    }
  });
});
