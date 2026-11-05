import { AutopodError } from '@autopod/shared';

/** Header-only limits before any model/renderer decodes an uploaded raster image. */
export function inputImageDimensions(
  bytes: Buffer,
  mediaType: string,
): { width: number; height: number } | null {
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mediaType)) return null;
  let width = 0;
  let height = 0;
  if (
    mediaType === 'image/png' &&
    bytes.length >= 24 &&
    bytes.toString('ascii', 12, 16) === 'IHDR'
  ) {
    width = bytes.readUInt32BE(16);
    height = bytes.readUInt32BE(20);
  } else if (mediaType === 'image/gif' && bytes.length >= 10) {
    width = bytes.readUInt16LE(6);
    height = bytes.readUInt16LE(8);
  } else if (mediaType === 'image/webp' && bytes.length >= 25) {
    const kind = bytes.toString('ascii', 12, 16);
    if (kind === 'VP8X' && bytes.length >= 30) {
      width = bytes.readUIntLE(24, 3) + 1;
      height = bytes.readUIntLE(27, 3) + 1;
    } else if (
      kind === 'VP8 ' &&
      bytes.length >= 30 &&
      bytes.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))
    ) {
      width = bytes.readUInt16LE(26) & 0x3fff;
      height = bytes.readUInt16LE(28) & 0x3fff;
    } else if (kind === 'VP8L' && bytes[20] === 0x2f) {
      const bits = bytes.readUInt32LE(21);
      width = (bits & 0x3fff) + 1;
      height = ((bits >>> 14) & 0x3fff) + 1;
    }
  } else if (mediaType === 'image/jpeg') {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) break;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === undefined || marker === 0xda || marker === 0xd9 || offset + 2 > bytes.length)
        break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if (
        [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
          marker,
        ) &&
        length >= 7
      ) {
        height = bytes.readUInt16BE(offset + 3);
        width = bytes.readUInt16BE(offset + 5);
        break;
      }
      offset += length;
    }
  }
  if (!width || !height || width > 16384 || height > 16384 || width * height > 40_000_000)
    throw new AutopodError(
      'Reference raster images require valid dimensions, at most 16,384 pixels per side and 40 megapixels',
      'INPUT_IMAGE_DIMENSIONS',
      400,
    );
  return { width, height };
}
export function assertInputImageSize(bytes: Buffer, mediaType: string): void {
  inputImageDimensions(bytes, mediaType);
}
