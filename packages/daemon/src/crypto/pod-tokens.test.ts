import { randomBytes } from 'node:crypto';
import fs, { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPodTokenIssuer } from './pod-tokens.js';

describe('PodTokenIssuer', () => {
  let keyPath: string;
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pod-tokens-test-'));
    keyPath = path.join(tmpDir, 'secrets.key');
    writeFileSync(keyPath, randomBytes(32));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('generates and verifies a valid token', () => {
    const issuer = createPodTokenIssuer(keyPath);
    const token = issuer.generate('test-pod-123');
    const result = issuer.verify(token);
    expect(result).toBe('test-pod-123');
  });

  it('rejects expired tokens', () => {
    const issuer = createPodTokenIssuer(keyPath);
    // Generate with negative TTL (already expired)
    const token = issuer.generate('test-pod', -1);
    const result = issuer.verify(token);
    expect(result).toBeNull();
  });

  it('rejects tampered tokens', () => {
    const issuer = createPodTokenIssuer(keyPath);
    const token = issuer.generate('pod-a');

    // Decode, modify pod ID, re-encode
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    const tampered = decoded.replace('pod-a', 'pod-b');
    const tamperedToken = Buffer.from(tampered, 'utf8').toString('base64url');

    expect(issuer.verify(tamperedToken)).toBeNull();
  });

  it('rejects garbage tokens', () => {
    const issuer = createPodTokenIssuer(keyPath);
    expect(issuer.verify('')).toBeNull();
    expect(issuer.verify('not-a-token')).toBeNull();
    expect(issuer.verify('aGVsbG8=')).toBeNull();
  });

  it('tokens from different keys are incompatible', () => {
    const otherKeyPath = path.join(tmpDir, 'other.key');
    writeFileSync(otherKeyPath, randomBytes(32));

    const issuer1 = createPodTokenIssuer(keyPath);
    const issuer2 = createPodTokenIssuer(otherKeyPath);

    const token = issuer1.generate('pod-x');
    expect(issuer2.verify(token)).toBeNull();
  });

  it('respects custom TTL', () => {
    const issuer = createPodTokenIssuer(keyPath);
    // 1 hour TTL
    const token = issuer.generate('pod-ttl', 3600);
    expect(issuer.verify(token)).toBe('pod-ttl');
  });

  it('scopes token to specific pod ID', () => {
    const issuer = createPodTokenIssuer(keyPath);
    const token = issuer.generate('pod-scoped');
    // Token should verify to the exact pod ID it was created for
    expect(issuer.verify(token)).toBe('pod-scoped');
  });
});
