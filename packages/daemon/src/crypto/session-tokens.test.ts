import { randomBytes } from 'node:crypto';
import fs, { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSessionTokenIssuer } from './session-tokens.js';

describe('SessionTokenIssuer', () => {
  let keyPath: string;
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-tokens-test-'));
    keyPath = path.join(tmpDir, 'secrets.key');
    writeFileSync(keyPath, randomBytes(32));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('generates and verifies a valid token', () => {
    const issuer = createSessionTokenIssuer(keyPath);
    const token = issuer.generate('test-session-123');
    const result = issuer.verify(token);
    expect(result).toBe('test-session-123');
  });

  it('rejects expired tokens', () => {
    const issuer = createSessionTokenIssuer(keyPath);
    // Generate with negative TTL (already expired)
    const token = issuer.generate('test-session', -1);
    const result = issuer.verify(token);
    expect(result).toBeNull();
  });

  it('rejects tampered tokens', () => {
    const issuer = createSessionTokenIssuer(keyPath);
    const token = issuer.generate('session-a');

    // Decode, modify session ID, re-encode
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    const tampered = decoded.replace('session-a', 'session-b');
    const tamperedToken = Buffer.from(tampered, 'utf8').toString('base64url');

    expect(issuer.verify(tamperedToken)).toBeNull();
  });

  it('rejects garbage tokens', () => {
    const issuer = createSessionTokenIssuer(keyPath);
    expect(issuer.verify('')).toBeNull();
    expect(issuer.verify('not-a-token')).toBeNull();
    expect(issuer.verify('aGVsbG8=')).toBeNull();
  });

  it('tokens from different keys are incompatible', () => {
    const otherKeyPath = path.join(tmpDir, 'other.key');
    writeFileSync(otherKeyPath, randomBytes(32));

    const issuer1 = createSessionTokenIssuer(keyPath);
    const issuer2 = createSessionTokenIssuer(otherKeyPath);

    const token = issuer1.generate('session-x');
    expect(issuer2.verify(token)).toBeNull();
  });

  it('respects custom TTL', () => {
    const issuer = createSessionTokenIssuer(keyPath);
    // 1 hour TTL
    const token = issuer.generate('session-ttl', 3600);
    expect(issuer.verify(token)).toBe('session-ttl');
  });

  it('scopes token to specific session ID', () => {
    const issuer = createSessionTokenIssuer(keyPath);
    const token = issuer.generate('session-scoped');
    // Token should verify to the exact session ID it was created for
    expect(issuer.verify(token)).toBe('session-scoped');
  });
});
