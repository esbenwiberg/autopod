import { chmodSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadOrCreateKey } from './credentials-cipher.js';

describe('loadOrCreateKey', () => {
  let tmpDir: string;
  let keyPath: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `autopod-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    keyPath = join(tmpDir, 'secrets.key');
  });

  afterEach(() => {
    try {
      chmodSync(keyPath, 0o600);
    } catch {
      // Ignore if file doesn't exist
    }
  });

  it('generates a new key file with mode 0600 when none exists', () => {
    loadOrCreateKey(keyPath);
    const mode = statSync(keyPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('encrypts and decrypts a round-trip', () => {
    const cipher = loadOrCreateKey(keyPath);
    const plaintext = 'sensitive-credential-value';
    const encrypted = cipher.encrypt(plaintext);
    expect(encrypted).not.toBe(plaintext);
    expect(cipher.decrypt(encrypted)).toBe(plaintext);
  });

  it('throws on startup when key file has permissions wider than 0600', () => {
    const key = Buffer.alloc(32, 0xab);
    writeFileSync(keyPath, key, { mode: 0o644 });
    expect(() => loadOrCreateKey(keyPath)).toThrow('must be 0600');
  });

  it('throws when key file has group-readable permissions', () => {
    const key = Buffer.alloc(32, 0xcd);
    writeFileSync(keyPath, key, { mode: 0o640 });
    expect(() => loadOrCreateKey(keyPath)).toThrow('must be 0600');
  });

  it('accepts an existing key with exactly 0600 permissions', () => {
    const key = Buffer.alloc(32, 0xef);
    writeFileSync(keyPath, key, { mode: 0o600 });
    expect(() => loadOrCreateKey(keyPath)).not.toThrow();
  });

  it('throws when key file is wrong length', () => {
    writeFileSync(keyPath, Buffer.alloc(16), { mode: 0o600 });
    expect(() => loadOrCreateKey(keyPath)).toThrow('16 bytes, expected 32');
  });
});
