import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { hashImplementationInputs } from './build-input-identity.js';

it('identifies actual implementation content, dependency lock and permissions without guessing missing or external inputs', () => {
  const root = mkdtempSync(join(tmpdir(), 'implementation-inputs-'));
  try {
    writeFileSync(join(root, 'engine.ts'), 'original engine');
    writeFileSync(join(root, 'lock.yaml'), 'dependency:1');
    const files = ['engine.ts', 'lock.yaml'];
    const first = hashImplementationInputs(root, files);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(hashImplementationInputs(root, [...files].reverse())).toBe(first);
    writeFileSync(join(root, 'engine.ts'), 'modified engine');
    const changed = hashImplementationInputs(root, files);
    expect(changed).not.toBe(first);
    writeFileSync(join(root, 'lock.yaml'), 'dependency:2');
    const dependency = hashImplementationInputs(root, files);
    expect(dependency).not.toBe(changed);
    chmodSync(join(root, 'engine.ts'), 0o755);
    expect(hashImplementationInputs(root, files)).not.toBe(dependency);
    expect(hashImplementationInputs(root, [...files, 'missing'])).toBeNull();
    symlinkSync('/etc/hosts', join(root, 'external'));
    expect(hashImplementationInputs(root, ['external'])).toBeNull();
    expect(hashImplementationInputs(root, [])).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
