import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

const DEFAULT_TTL_SECONDS = 24 * 60 * 60; // 24 hours

export interface PodTokenIssuer {
  /** Generate a short-lived token scoped to a pod ID. */
  generate(podId: string, ttlSeconds?: number): string;
  /** Verify a token and return the pod ID it was issued for, or null if invalid/expired. */
  verify(token: string): string | null;
}

/**
 * Create a pod token issuer using HMAC-SHA256.
 *
 * Derives a signing key from the existing secrets.key via HMAC (so we never
 * reuse the AES encryption key directly for a different purpose).
 *
 * Token format: base64url( podId + "." + expiresEpoch + "." + hex(signature) )
 */
export function createPodTokenIssuer(secretsKeyPath: string): PodTokenIssuer {
  const masterKey = readFileSync(secretsKeyPath);
  // Derive a purpose-specific key: HMAC(masterKey, "pod-tokens")
  const signingKey = createHmac('sha256', masterKey).update('pod-tokens').digest();

  return {
    generate(podId: string, ttlSeconds = DEFAULT_TTL_SECONDS): string {
      const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
      const payload = `${podId}.${expires}`;
      const sig = createHmac('sha256', signingKey).update(payload).digest('hex');
      return toBase64Url(`${payload}.${sig}`);
    },

    verify(token: string): string | null {
      let decoded: string;
      try {
        decoded = fromBase64Url(token);
      } catch {
        return null;
      }

      const parts = decoded.split('.');
      if (parts.length !== 3) return null;

      const [podId, expiresStr, providedSig] = parts as [string, string, string];

      // Check expiry
      const expires = Number(expiresStr);
      if (Number.isNaN(expires) || Math.floor(Date.now() / 1000) > expires) {
        return null;
      }

      // Verify signature (timing-safe comparison)
      const payload = `${podId}.${expiresStr}`;
      const expectedSig = createHmac('sha256', signingKey).update(payload).digest('hex');

      if (providedSig.length !== expectedSig.length) return null;
      const sigMatch = timingSafeEqual(
        Buffer.from(providedSig, 'utf8'),
        Buffer.from(expectedSig, 'utf8'),
      );
      if (!sigMatch) return null;

      return podId;
    },
  };
}

function toBase64Url(str: string): string {
  return Buffer.from(str, 'utf8').toString('base64url');
}

function fromBase64Url(b64: string): string {
  return Buffer.from(b64, 'base64url').toString('utf8');
}
