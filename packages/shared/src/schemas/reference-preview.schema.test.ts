import { describe, expect, it } from 'vitest';
import {
  referencePreviewReceiptSchema,
  referenceRendererImageSchema,
} from './reference-preview.schema.js';

const receipt = {
  bundleDigest: 'a'.repeat(64),
  sourceSha256: 'b'.repeat(64),
  resourceSha256s: ['b'.repeat(64)],
  entrypoint: 'design/index.html',
  rendererImage: `sha256:${'c'.repeat(64)}`,
  rendererProtocol: 1,
  browserVersion: '146.0.0',
  width: 1280,
  height: 900,
  mediaType: 'image/jpeg',
  jpegQuality: 80,
  byteLength: 12,
  sha256: 'd'.repeat(64),
  blockedRequests: 0,
  scriptErrors: 0,
  capturedAt: '2026-05-01T12:00:00.000Z',
};
describe('bounded source-bound reference preview protocol', () => {
  it('accepts fixed-view, source-linked raster receipts and content-pinned image identities', () => {
    expect(referencePreviewReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(
      referenceRendererImageSchema.parse(`registry.example/renderer@sha256:${'a'.repeat(64)}`),
    ).toContain('@sha256:');
  });
  it.each([
    'renderer:latest',
    'registry.example/renderer',
    'https://registry.example/renderer',
    `renderer@sha256:${'0'.repeat(63)}`,
    'sha256:abc',
  ])('rejects non-content-pinned renderer identity %s', (image) => {
    expect(referenceRendererImageSchema.safeParse(image).success).toBe(false);
  });
  it.each([
    { width: 1920 },
    { height: 0 },
    { rendererProtocol: 2 },
    { jpegQuality: 70 },
    { mediaType: 'text/html' },
    { byteLength: 2 * 1024 * 1024 + 1 },
    { blockedRequests: -1 },
    { entrypoint: '../secret' },
    { sourceSha256: 'unknown' },
    { resourceSha256s: [] },
    { browserVersion: 'bad\nversion' },
    { baseUrl: 'http://localhost' },
  ])('rejects unsupported or unsafe receipt fields %j', (override) => {
    expect(referencePreviewReceiptSchema.safeParse({ ...receipt, ...override }).success).toBe(
      false,
    );
  });
});
