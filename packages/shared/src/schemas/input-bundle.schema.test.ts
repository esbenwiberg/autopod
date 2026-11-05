import { describe, expect, it } from 'vitest';
import { inputManifestSchema, inputPathSchema } from './input-bundle.schema.js';

const file = (path: string) => ({
  path,
  mediaType: 'text/html',
  byteLength: 12,
  sha256: 'a'.repeat(64),
});
describe('input manifest', () => {
  it.each([
    '../escape.html',
    '/absolute.html',
    'a//b.html',
    'a/./b.html',
    'a/../b.html',
    'C:/x.html',
    '.env',
    'a\\b.html',
    'x\ny.html',
    'x`y.html',
    'a./b.html',
  ])('rejects unsafe path %s', (value) => {
    expect(inputPathSchema.safeParse(value).success).toBe(false);
  });
  it('bounds UTF-8 filename bytes and rejects unpaired surrogates', () => {
    expect(inputPathSchema.safeParse(`${'é'.repeat(130)}.html`).success).toBe(false);
    expect(inputPathSchema.safeParse('\ud800.png').success).toBe(false);
    expect(inputPathSchema.safeParse('design/🖼️.png').success).toBe(true);
  });

  it('accepts nested portable paths and rejects case/prefix collisions', () => {
    expect(inputManifestSchema.parse({ files: [file('design/index.html')] }).files).toHaveLength(1);
    expect(
      inputManifestSchema.safeParse({ files: [file('index.html'), file('INDEX.HTML')] }).success,
    ).toBe(false);
    expect(
      inputManifestSchema.safeParse({ files: [file('a.html'), file('a.html/b.html')] }).success,
    ).toBe(false);
  });
  it('bounds sizes, count and media types', () => {
    expect(
      inputManifestSchema.safeParse({ files: [{ ...file('x.html'), mediaType: 'image/png' }] })
        .success,
    ).toBe(false);
    expect(
      inputManifestSchema.safeParse({
        files: [{ ...file('x.html'), byteLength: 11 * 1024 * 1024 }],
      }).success,
    ).toBe(false);
    expect(
      inputManifestSchema.safeParse({
        files: Array.from({ length: 3 }, (_, index) => ({
          ...file(`${index}.html`),
          byteLength: 10 * 1024 * 1024,
        })),
      }).success,
    ).toBe(false);
    expect(
      inputManifestSchema.safeParse({
        files: Array.from({ length: 51 }, (_, index) => file(`${index}.html`)),
      }).success,
    ).toBe(false);
  });
});
