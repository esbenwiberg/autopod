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

  it('revokes retained-resource credentials without invalidating other pods', () => {
    const epochs = new Map<string, string>();
    const issuer = createPodTokenIssuer(keyPath, (id) => epochs.get(id) ?? null);
    const old = issuer.generate('retained');
    const unrelated = issuer.generate('unrelated');
    epochs.set('retained', 'recovery-one');
    expect(issuer.verify(old)).toBeNull();
    expect(issuer.verify(unrelated)).toBe('unrelated');
    const replacement = issuer.generate('retained');
    expect(issuer.verify(replacement)).toBe('retained');
    const reopened = createPodTokenIssuer(keyPath, (id) => epochs.get(id) ?? null);
    expect(reopened.verify(old)).toBeNull();
    expect(reopened.verify(replacement)).toBe('retained');
    epochs.set('retained', 'recovery-two');
    expect(reopened.verify(replacement)).toBeNull();
  });

  it('signs the epoch and rejects recovery tokens in a legacy verifier', () => {
    const issuer = createPodTokenIssuer(keyPath, () => 'recovery-one');
    const token = issuer.generate('retained');
    const tampered = Buffer.from(token, 'base64url')
      .toString('utf8')
      .replace('recovery-one', 'recovery-two');
    expect(issuer.verify(Buffer.from(tampered).toString('base64url'))).toBeNull();
    expect(createPodTokenIssuer(keyPath).verify(token)).toBeNull();
  });

  it('fails closed when the credential epoch cannot be read', () => {
    const token = createPodTokenIssuer(keyPath).generate('retained');
    const unavailable = createPodTokenIssuer(keyPath, () => {
      throw new Error('database unavailable');
    });
    expect(unavailable.verify(token)).toBeNull();
    expect(() => unavailable.generate('retained')).toThrow('database unavailable');
  });

  it('rejects ambiguous epoch delimiters on issuance', () => {
    expect(() => createPodTokenIssuer(keyPath, () => 'bad.epoch').generate('retained')).toThrow(
      'Invalid pod credential epoch',
    );
  });

  it('scopes token to specific pod ID', () => {
    const issuer = createPodTokenIssuer(keyPath);
    const token = issuer.generate('pod-scoped');
    // Token should verify to the exact pod ID it was created for
    expect(issuer.verify(token)).toBe('pod-scoped');
  });
});
