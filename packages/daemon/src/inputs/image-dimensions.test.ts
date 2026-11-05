import { describe, expect, it } from 'vitest';
import { assertInputImageSize } from './image-dimensions.js';

describe('reference image resource bounds', () => {
  it('rejects oversized PNG/GIF headers before decoding', () => {
    const png = Buffer.alloc(24);
    png.write('IHDR', 12);
    png.writeUInt32BE(12000, 16);
    png.writeUInt32BE(12000, 20);
    expect(() => assertInputImageSize(png, 'image/png')).toThrow('40 megapixels');
    png.writeUInt32BE(1920, 16);
    png.writeUInt32BE(1080, 20);
    expect(() => assertInputImageSize(png, 'image/png')).not.toThrow();
    const gif = Buffer.alloc(10);
    gif.writeUInt16LE(60000, 6);
    gif.writeUInt16LE(1, 8);
    expect(() => assertInputImageSize(gif, 'image/gif')).toThrow('16,384');
  });
  it('reads JPEG frame and WebP lossless dimensions without decoding or executing content', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 7, 8, 0, 10, 0, 20]);
    expect(() => assertInputImageSize(jpeg, 'image/jpeg')).not.toThrow();
    const webp = Buffer.alloc(26);
    webp.write('VP8L', 12);
    webp[20] = 0x2f;
    expect(() => assertInputImageSize(webp, 'image/webp')).not.toThrow();
  });
  it.each([
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
  ])('rejects truncated %s safely', (type) => {
    expect(() => assertInputImageSize(Buffer.from([0xff]), type)).toThrow('dimensions');
  });
});
