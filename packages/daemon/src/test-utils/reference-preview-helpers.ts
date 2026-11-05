import { createHash } from 'node:crypto';
import type { InputBundleRef } from '@autopod/shared';
import type { ReferencePreview } from '../inputs/reference-renderer.js';

/** Header-only validation fixture, not a decodable JPEG or visual-accuracy proof. */
export function referencePreview(
  ref: InputBundleRef,
  entrypoint: string,
  image = `sha256:${'a'.repeat(64)}`,
): ReferencePreview {
  const file = ref.files.find((candidate) => candidate.path === entrypoint);
  if (!file) throw new Error('Missing reference preview fixture entrypoint');
  const bytes = Buffer.from('ffd8ffc00011080384050003012200021101031101ffd9', 'hex');
  return {
    bytes,
    receipt: {
      bundleDigest: ref.digest,
      sourceSha256: file.sha256,
      resourceSha256s: [file.sha256],
      entrypoint,
      rendererImage: image,
      rendererProtocol: 1,
      browserVersion: '146.0.0',
      width: 1280,
      height: 900,
      mediaType: 'image/jpeg',
      jpegQuality: 80,
      byteLength: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      blockedRequests: 0,
      scriptErrors: 0,
      capturedAt: '2026-05-01T12:00:00.000Z',
    },
  };
}
