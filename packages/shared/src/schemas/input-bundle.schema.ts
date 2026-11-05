import { z } from 'zod';

export const MAX_INPUT_FILES = 50;
export const MAX_INPUT_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_INPUT_BUNDLE_BYTES = 25 * 1024 * 1024;
export const INPUTS_CONTAINER_DIR = '/autopod/inputs';

const mediaTypes: Record<string, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  json: 'application/json',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  csv: 'text/csv',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  pdf: 'application/pdf',
  drawio: 'application/xml',
};
export function inputMediaType(path: string): string | undefined {
  const extension = path.split('.').at(-1)?.toLowerCase() ?? '';
  return Object.hasOwn(mediaTypes, extension) ? mediaTypes[extension] : undefined;
}
function utf8Length(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
}
export const inputPathSchema = z
  .string()
  .min(1)
  .max(240)
  .refine((value) => {
    const segments = value.split('/');
    return (
      value === value.normalize('NFC') &&
      segments.length <= 16 &&
      !/[\\:*?"<>|`\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value) &&
      segments.every(
        (part) =>
          part.length > 0 &&
          utf8Length(part) <= 240 &&
          !part.startsWith('.') &&
          !part.endsWith('.') &&
          !part.endsWith(' '),
      )
    );
  }, 'Input paths must be portable relative paths without hidden, empty or traversal segments');
export const inputFileSchema = z
  .object({
    path: inputPathSchema,
    mediaType: z.string().max(80),
    byteLength: z.number().int().min(0).max(MAX_INPUT_FILE_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .refine((file) => inputMediaType(file.path) === file.mediaType, 'Unsupported input file type');
export const inputManifestSchema = z
  .object({
    files: z.array(inputFileSchema).min(1).max(MAX_INPUT_FILES),
  })
  .strict()
  .superRefine(({ files }, ctx) => {
    if (files.reduce((sum, file) => sum + file.byteLength, 0) > MAX_INPUT_BUNDLE_BYTES)
      ctx.addIssue({ code: 'custom', message: 'Input bundle exceeds 25 MiB' });
    const paths = files.map((file) => file.path.toLowerCase());
    if (
      paths.some((name, index) =>
        paths.some((other, j) => j !== index && (name === other || name.startsWith(`${other}/`))),
      )
    )
      ctx.addIssue({ code: 'custom', message: 'Input file paths collide' });
  });
export const inputBundleRefSchema = inputManifestSchema.safeExtend({
  id: z.string().regex(/^inputs-[a-f0-9-]{36}$/),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
});
export const createInputBundleSchema = inputManifestSchema.safeExtend({
  requestKey: z.string().uuid(),
});
export const inputBundleResponseSchema = inputBundleRefSchema.safeExtend({
  status: z.enum(['uploading', 'sealed']),
});
export type InputFile = z.infer<typeof inputFileSchema>;
export type InputBundleRef = z.infer<typeof inputBundleRefSchema>;
export type InputBundleResponse = z.infer<typeof inputBundleResponseSchema>;
export type CreateInputBundleRequest = z.infer<typeof createInputBundleSchema>;
