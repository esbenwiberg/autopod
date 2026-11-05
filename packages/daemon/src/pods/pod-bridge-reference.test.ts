import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { InputBundleStore } from '../inputs/input-bundle-store.js';
import type { ReferencePreviewService } from '../inputs/reference-preview-service.js';
import { createAdmissionFixture, deferred } from '../test-utils/admission-queries-helpers.js';
import { referencePreview } from '../test-utils/reference-preview-helpers.js';
import { createSessionBridge } from './pod-bridge-impl.js';

describe('pod-scoped HTML reference rendering', () => {
  function setup() {
    const f = createAdmissionFixture();
    const store = new InputBundleStore(f.db);
    const bytes = Buffer.from('<!doctype html><p>Reference</p>');
    const bundle = store.create(
      {
        requestKey: randomUUID(),
        files: [
          {
            path: 'design.html',
            mediaType: 'text/html',
            byteLength: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          },
        ],
      },
      'operator',
    );
    store.put(bundle.id, 'operator', 0, bytes);
    const { status: _, ...ref } = store.seal(bundle.id, 'operator');
    f.insert('reference', { status: 'running', inputBundle: ref });
    const preview = referencePreview(ref, 'design.html');
    const renderAdmitted = vi
      .fn<ReferencePreviewService['renderAdmitted']>()
      .mockResolvedValue(preview);
    const bridge = createSessionBridge({
      ...f.deps,
      podManager: f.manager(),
      pendingRequestsByPod: new Map(),
      referencePreviews: { renderAdmitted },
    });
    return { f, ref, preview, renderAdmitted, bridge };
  }
  it('uses only the current admitted bundle and does not stage image bytes into source', async () => {
    const s = setup();
    expect(await s.bridge.renderReference?.('reference', 'design.html')).toMatchObject({
      base64: s.preview.bytes.toString('base64'),
      receipt: s.preview.receipt,
    });
    expect(s.renderAdmitted).toHaveBeenCalledExactlyOnceWith(s.ref, 'operator', 'design.html');
    s.f.podRepo.update('reference', { status: 'paused' });
    await expect(s.bridge.renderReference?.('reference', 'design.html')).rejects.toThrow(
      'only accepted while',
    );
  });
  it('withholds results when the lifecycle changes while rendering', async () => {
    const s = setup();
    const pending = deferred<Awaited<ReturnType<ReferencePreviewService['renderAdmitted']>>>();
    s.renderAdmitted.mockReturnValue(pending.promise);
    const result = s.bridge.renderReference?.('reference', 'design.html');
    s.f.podRepo.incrementLifecycleGeneration('reference');
    pending.resolve(s.preview);
    await expect(result).rejects.toThrow('Pod changed');
  });
  it('rejects oversized native tool images rather than silently falling back to text', async () => {
    const s = setup();
    s.renderAdmitted.mockResolvedValue({ ...s.preview, bytes: Buffer.alloc(512 * 1024 + 1) });
    await expect(s.bridge.renderReference?.('reference', 'design.html')).rejects.toThrow('512 KiB');
  });
});
