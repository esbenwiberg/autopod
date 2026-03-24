import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 12; // 96 bits — recommended for GCM
const TAG_LENGTH = 16;

export interface CredentialsCipher {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
}

/**
 * Load encryption key from file, or generate and persist a new one.
 * Key file is created with 0o600 permissions (owner read/write only).
 */
export function loadOrCreateKey(keyPath: string): CredentialsCipher {
  let key: Buffer;

  try {
    key = readFileSync(keyPath);
    if (key.length !== KEY_LENGTH) {
      throw new Error(`Key file at ${keyPath} is ${key.length} bytes, expected ${KEY_LENGTH}`);
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;

    // Generate new key and persist it
    key = randomBytes(KEY_LENGTH);
    mkdirSync(dirname(keyPath), { recursive: true });
    writeFileSync(keyPath, key, { mode: 0o600 });
  }

  return createCipher(key);
}

function createCipher(key: Buffer): CredentialsCipher {
  return {
    encrypt(plaintext: string): string {
      const iv = randomBytes(IV_LENGTH);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      // Format: hex(iv):hex(authTag):hex(ciphertext)
      return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
    },

    decrypt(ciphertext: string): string {
      const parts = ciphertext.split(':');
      if (parts.length !== 3) throw new Error('Invalid encrypted credential format');
      const [ivHex, tagHex, dataHex] = parts as [string, string, string];
      const iv = Buffer.from(ivHex, 'hex');
      const tag = Buffer.from(tagHex, 'hex');
      const data = Buffer.from(dataHex, 'hex');
      const decipher = createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(tag);
      return decipher.update(data) + decipher.final('utf8');
    },
  };
}
