import { PassThrough } from 'node:stream';
import { expect, it } from 'vitest';
import { captureBoundedStderr } from './bounded-stderr.js';

it.each([1, 100])(
  'retains only a bounded diagnostic tail across %s oversized chunks',
  async (chunks) => {
    const stream = new PassThrough();
    const capture = captureBoundedStderr(stream);
    for (let i = 0; i < chunks; i++) stream.write(Buffer.alloc(100000, 120));
    stream.end('final diagnostic');
    const result = await capture.finish();
    expect(Buffer.byteLength(result.text)).toBe(16 * 1024);
    expect(result.text.endsWith('final diagnostic')).toBe(true);
    expect(result.complete).toBe(false);
    expect(result.truncated).toBe(true);
    expect(stream.listenerCount('data')).toBe(0);
    expect(stream.listenerCount('end')).toBe(0);
  },
);

it('stops capturing on disposal while tolerating late transport errors', async () => {
  const stream = new PassThrough();
  const capture = captureBoundedStderr(stream);
  stream.write('early');
  capture.dispose();
  expect(stream.listenerCount('data')).toBe(0);
  stream.write(Buffer.alloc(100000, 120));
  expect(() => stream.emit('error', new Error('late transport failure'))).not.toThrow();
  expect(await capture.finish()).toEqual({ text: '', complete: false, truncated: false });
  stream.destroy();
});
