import { z } from 'zod';
import { inputPathSchema } from './input-bundle.schema.js';

export const REFERENCE_PREVIEW_VIEWPORT = { width: 1280, height: 900 } as const;
export const MAX_REFERENCE_PREVIEW_BYTES = 2 * 1024 * 1024;
export const REFERENCE_RENDERER_PROTOCOL = 1;
export const referenceRendererImageSchema = z
  .string()
  .max(300)
  .regex(/^(?:sha256:[a-f0-9]{64}|[a-z0-9./:_-]+@sha256:[a-f0-9]{64})$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const referencePreviewReceiptSchema = z
  .object({
    bundleDigest: hash,
    sourceSha256: hash,
    resourceSha256s: z.array(hash).min(1).max(50),
    entrypoint: inputPathSchema,
    rendererImage: referenceRendererImageSchema,
    rendererProtocol: z.literal(REFERENCE_RENDERER_PROTOCOL),
    browserVersion: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[a-zA-Z0-9 ._-]+$/),
    width: z.literal(REFERENCE_PREVIEW_VIEWPORT.width),
    height: z.literal(REFERENCE_PREVIEW_VIEWPORT.height),
    mediaType: z.literal('image/jpeg'),
    jpegQuality: z.literal(80),
    byteLength: z.number().int().positive().max(MAX_REFERENCE_PREVIEW_BYTES),
    sha256: hash,
    blockedRequests: z.number().int().min(0).max(1_000_000),
    scriptErrors: z.number().int().min(0).max(1_000_000),
    capturedAt: z.string().datetime(),
  })
  .strict();
export type ReferencePreviewReceipt = z.infer<typeof referencePreviewReceiptSchema>;
export interface ReferencePreviewResponse {
  receipt: ReferencePreviewReceipt;
  /** JPEG raster only, never active HTML. Owner-scoped and bounded. */
  base64: string;
}
