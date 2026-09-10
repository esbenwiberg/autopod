import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawImage } from '@huggingface/transformers';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

describe('security dependency overrides against their consuming APIs', () => {
  it('loads Transformers and resizes raw pixels through its actual Sharp dependency offline', async () => {
    const input = new RawImage(new Uint8ClampedArray([255, 0, 0, 0, 255, 0]), 2, 1, 3);
    const output = await input.resize(4, 2);
    expect([output.width, output.height, output.channels, output.data.length]).toEqual([
      4, 2, 3, 24,
    ]);
  });

  it('extracts an ONNX package entry with the patched zip API', () => {
    const transformersRequire = createRequire(require.resolve('@huggingface/transformers'));
    const onnxRequire = createRequire(transformersRequire.resolve('onnxruntime-node'));
    const AdmZip = onnxRequire('adm-zip');
    const directory = mkdtempSync(join(tmpdir(), 'autopod-zip-compat-'));
    try {
      const archive = new AdmZip();
      archive.addFile('runtimes/native/library.bin', Buffer.from('offline-fixture'));
      const file = join(directory, 'fixture.zip');
      archive.writeZip(file);
      const loaded = new AdmZip(file);
      loaded.extractEntryTo(loaded.getEntry('runtimes/native/library.bin'), directory, false, true);
      expect(readFileSync(join(directory, 'library.bin'), 'utf8')).toBe('offline-fixture');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('retains CommonJS uuid.v4 used by the existing MSAL authentication client', () => {
    const cliRequire = createRequire(new URL('../../../cli/package.json', import.meta.url));
    const msalRequire = createRequire(cliRequire.resolve('@azure/msal-node'));
    const uuid = msalRequire('uuid');
    const first = uuid.v4();
    expect(uuid.validate(first)).toBe(true);
    expect(uuid.version(first)).toBe(4);
    expect(uuid.v4()).not.toBe(first);
  });
});
