import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectInputs, uploadInputs } from './input-attachments.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cli-inputs-'));
  roots.push(root);
  return root;
}
describe('reference file collection and upload', () => {
  it('preserves binary bytes and nested relative assets without hidden/dependency files', () => {
    const root = fixture();
    mkdirSync(join(root, 'assets'));
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'index.html'), '<img src="assets/design.png">');
    writeFileSync(join(root, 'assets/design.png'), Buffer.from([0x89, 0x50, 0, 0xff]));
    writeFileSync(join(root, '.env'), 'secret');
    writeFileSync(join(root, 'node_modules/private.txt'), 'secret');
    const files = collectInputs({ attachDir: [root] });
    expect(files).toHaveLength(2);
    expect(files[0]?.file.path).toMatch(/\/assets\/design.png$/);
    expect(files[0]?.bytes).toEqual(Buffer.from([0x89, 0x50, 0, 0xff]));
  });
  it('rejects symlinks, collisions, unsupported files and excessive sizes', () => {
    const root = fixture();
    writeFileSync(join(root, 'design.html'), 'html');
    symlinkSync(join(root, 'design.html'), join(root, 'link.html'));
    expect(() => collectInputs({ attach: [join(root, 'link.html')] })).toThrow('symlinks');
    expect(() => collectInputs({ attachDir: [root] })).toThrow('Symlinks');
    expect(() =>
      collectInputs({ attach: [join(root, 'design.html'), join(root, 'design.html')] }),
    ).toThrow('collide');
    writeFileSync(join(root, 'secret.exe'), 'x');
    expect(() => collectInputs({ attach: [join(root, 'secret.exe')] })).toThrow('Unsupported');
    writeFileSync(join(root, 'large.html'), Buffer.alloc(10 * 1024 * 1024 + 1));
    expect(() => collectInputs({ attach: [join(root, 'large.html')] })).toThrow('limits');
  });
  it('uploads frozen bytes, seals before launch and uses a stable retry key', async () => {
    const root = fixture();
    const path = join(root, 'design.html');
    writeFileSync(path, 'original');
    const inputs = collectInputs({ attach: [path] });
    writeFileSync(path, 'changed');
    const ref = {
      id: 'inputs-fixture',
      digest: 'a'.repeat(64),
      files: inputs.map((item) => item.file),
    };
    const client = {
      createInputBundle: vi.fn().mockResolvedValue({ ...ref, status: 'uploading' }),
      uploadInputFile: vi.fn(),
      sealInputBundle: vi.fn().mockResolvedValue({ ...ref, status: 'sealed' }),
    };
    expect(await uploadInputs(client, inputs)).toEqual(ref);
    expect(client.uploadInputFile).toHaveBeenCalledWith(ref.id, 0, Buffer.from('original'));
    const key = client.createInputBundle.mock.calls[0]?.[0].requestKey;
    client.createInputBundle.mockResolvedValue({ ...ref, status: 'sealed' });
    client.uploadInputFile.mockClear();
    await uploadInputs(client, inputs);
    expect(client.createInputBundle.mock.calls[1]?.[0].requestKey).toBe(key);
    expect(client.uploadInputFile).not.toHaveBeenCalled();
  });
});
