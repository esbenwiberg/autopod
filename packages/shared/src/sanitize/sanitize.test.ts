import { describe, expect, it } from 'vitest';
import { getPresetConfig, sanitize, sanitizeDeep } from './sanitize.js';

describe('getPresetConfig', () => {
  it('returns config for strict preset', () => {
    const config = getPresetConfig('strict');
    expect(config).toHaveProperty('preset', 'strict');
  });

  it('returns config for standard preset', () => {
    const config = getPresetConfig('standard');
    expect(config).toHaveProperty('preset', 'standard');
  });

  it('returns config for relaxed preset', () => {
    const config = getPresetConfig('relaxed');
    expect(config).toHaveProperty('preset', 'relaxed');
  });

  it('returns a proper DataSanitizationConfig shape', () => {
    const config = getPresetConfig('strict');
    expect(config).toHaveProperty('preset');
    // allowedDomains is optional, so it may or may not be present
    expect(typeof config.preset).toBe('string');
  });
});

describe('sanitize', () => {
  const sk = 'sk-abcdefghijklmnopqrstuvwx';
  const email = 'user@example.com';
  const phone = '212-555-1234';
  const ip = '192.168.1.100';
  const aws = 'AKIA1234567890ABCDEF';

  describe('preset filtering', () => {
    it('relaxed: redacts API keys but NOT emails, phones, or IPs', () => {
      const config = getPresetConfig('relaxed');
      const text = `key: ${sk}, email: ${email}, phone: ${phone}, ip: ${ip}`;
      const result = sanitize(text, config);
      expect(result).toContain('[API_KEY_REDACTED]');
      expect(result).toContain(email);
      expect(result).toContain(phone);
      expect(result).toContain(ip);
    });

    it('standard: redacts API keys and emails but NOT phones or IPs', () => {
      const config = getPresetConfig('standard');
      const text = `key: ${sk}, email: ${email}, phone: ${phone}, ip: ${ip}`;
      const result = sanitize(text, config);
      expect(result).toContain('[API_KEY_REDACTED]');
      expect(result).toContain('[EMAIL_REDACTED]');
      expect(result).toContain(phone);
      expect(result).toContain(ip);
    });

    it('strict: redacts API keys, emails, phones, AND IPs', () => {
      const config = getPresetConfig('strict');
      const text = `key: ${sk}, email: ${email}, phone: ${phone}, ip: ${ip}`;
      const result = sanitize(text, config);
      expect(result).toContain('[API_KEY_REDACTED]');
      expect(result).toContain('[EMAIL_REDACTED]');
      expect(result).toContain('[PHONE_REDACTED]');
      expect(result).toContain('[IP_REDACTED]');
    });

    it('relaxed: redacts AWS keys', () => {
      const config = getPresetConfig('relaxed');
      const result = sanitize(`key: ${aws}`, config);
      expect(result).toContain('[AWS_KEY_REDACTED]');
    });
  });

  describe('allowedDomains', () => {
    it('preserves emails from allowed domains', () => {
      const config = { ...getPresetConfig('strict'), allowedDomains: ['example.com'] };
      const result = sanitize('Contact user@example.com for help', config);
      expect(result).toContain('user@example.com');
    });

    it('still redacts emails from non-allowed domains', () => {
      const config = { ...getPresetConfig('strict'), allowedDomains: ['example.com'] };
      const result = sanitize('Contact user@evil.com for help', config);
      expect(result).toContain('[EMAIL_REDACTED]');
      expect(result).not.toContain('user@evil.com');
    });

    it('does not match subdomains of allowed domains', () => {
      const config = { ...getPresetConfig('strict'), allowedDomains: ['example.com'] };
      const result = sanitize('user@sub.example.com', config);
      // subdomain should NOT be allowed — it's not an exact domain match
      expect(result).toContain('[EMAIL_REDACTED]');
    });

    it('handles multiple allowed domains', () => {
      const config = {
        ...getPresetConfig('strict'),
        allowedDomains: ['safe.com', 'trusted.org'],
      };
      const text = 'a@safe.com b@trusted.org c@evil.com';
      const result = sanitize(text, config);
      expect(result).toContain('a@safe.com');
      expect(result).toContain('b@trusted.org');
      expect(result).toContain('[EMAIL_REDACTED]');
      expect(result).not.toContain('c@evil.com');
    });

    it('allowedDomains has no effect on non-email patterns', () => {
      const config = { ...getPresetConfig('strict'), allowedDomains: ['example.com'] };
      const result = sanitize(`key: ${sk}`, config);
      expect(result).toContain('[API_KEY_REDACTED]');
    });
  });

  describe('multiple PII types in one string', () => {
    it('redacts both API key and email in strict mode', () => {
      const config = getPresetConfig('strict');
      const text = `Send ${sk} to user@secret.com immediately`;
      const result = sanitize(text, config);
      expect(result).toContain('[API_KEY_REDACTED]');
      expect(result).toContain('[EMAIL_REDACTED]');
      expect(result).not.toContain(sk);
      expect(result).not.toContain('user@secret.com');
    });

    it('redacts AWS key, email, phone, and IP together in strict', () => {
      const config = getPresetConfig('strict');
      const text = `AWS: ${aws}, email: admin@corp.com, phone: (555) 123-4567, server: 10.0.0.5`;
      const result = sanitize(text, config);
      expect(result).toContain('[AWS_KEY_REDACTED]');
      expect(result).toContain('[EMAIL_REDACTED]');
      expect(result).toContain('[PHONE_REDACTED]');
      expect(result).toContain('[IP_REDACTED]');
    });
  });

  describe('robustness', () => {
    it('handles empty string', () => {
      const config = getPresetConfig('strict');
      expect(sanitize('', config)).toBe('');
    });

    it('returns text unchanged when no PII present', () => {
      const config = getPresetConfig('strict');
      const text = 'This is perfectly clean text with no sensitive data.';
      expect(sanitize(text, config)).toBe(text);
    });
  });
});

describe('sanitizeDeep', () => {
  const strictConfig = getPresetConfig('strict');

  describe('primitive handling', () => {
    it('preserves numbers', () => {
      expect(sanitizeDeep(42, strictConfig)).toBe(42);
    });

    it('preserves booleans', () => {
      expect(sanitizeDeep(true, strictConfig)).toBe(true);
      expect(sanitizeDeep(false, strictConfig)).toBe(false);
    });

    it('preserves null', () => {
      expect(sanitizeDeep(null, strictConfig)).toBeNull();
    });

    it('sanitizes top-level strings', () => {
      const result = sanitizeDeep('sk-abcdefghijklmnopqrstuvwx', strictConfig);
      expect(result).toBe('[API_KEY_REDACTED]');
    });
  });

  describe('nested objects', () => {
    it('walks and sanitizes nested string values', () => {
      const obj = {
        outer: {
          inner: {
            data: 'Contact user@example.com',
          },
        },
      };
      const result = sanitizeDeep(obj, strictConfig) as typeof obj;
      expect(result.outer.inner.data).toContain('[EMAIL_REDACTED]');
    });

    it('handles deeply nested structures', () => {
      // 10 levels deep
      let obj: Record<string, unknown> = { value: 'sk-abcdefghijklmnopqrstuvwx' };
      for (let i = 0; i < 10; i++) {
        obj = { nested: obj };
      }
      const result = sanitizeDeep(obj, strictConfig) as Record<string, unknown>;
      let current = result;
      for (let i = 0; i < 10; i++) {
        current = current.nested as Record<string, unknown>;
      }
      expect(current.value).toBe('[API_KEY_REDACTED]');
    });
  });

  describe('arrays', () => {
    it('sanitizes strings within arrays', () => {
      const arr = ['normal', 'user@evil.com', 'also normal'];
      const result = sanitizeDeep(arr, strictConfig) as string[];
      expect(result[0]).toBe('normal');
      expect(result[1]).toContain('[EMAIL_REDACTED]');
      expect(result[2]).toBe('also normal');
    });

    it('handles arrays of mixed types', () => {
      const arr = [42, 'sk-abcdefghijklmnopqrstuvwx', true, null, { key: 'value' }];
      const result = sanitizeDeep(arr, strictConfig) as unknown[];
      expect(result[0]).toBe(42);
      expect(result[1]).toBe('[API_KEY_REDACTED]');
      expect(result[2]).toBe(true);
      expect(result[3]).toBeNull();
      expect(result[4]).toEqual({ key: 'value' });
    });
  });

  describe('redact known field names', () => {
    it('redacts password field regardless of value', () => {
      const obj = { password: 'my-super-secret-password' };
      const result = sanitizeDeep(obj, strictConfig) as typeof obj;
      expect(result.password).toBe('[REDACTED]');
    });

    it('redacts token field', () => {
      const obj = { token: 'some-random-token-value' };
      const result = sanitizeDeep(obj, strictConfig) as typeof obj;
      expect(result.token).toBe('[REDACTED]');
    });

    it('redacts secret field', () => {
      const obj = { secret: 'shh-dont-tell' };
      const result = sanitizeDeep(obj, strictConfig) as typeof obj;
      expect(result.secret).toBe('[REDACTED]');
    });

    it('redacts email field name variants', () => {
      const obj = {
        email: 'user@example.com',
        userEmail: 'admin@corp.com',
        author_email: 'dev@dev.com',
      };
      const result = sanitizeDeep(obj, strictConfig) as typeof obj;
      expect(result.email).toBe('[REDACTED]');
      expect(result.userEmail).toBe('[REDACTED]');
      expect(result.author_email).toBe('[REDACTED]');
    });

    it('redacts api_key and apiKey fields', () => {
      const obj = { api_key: 'abc123', apiKey: 'def456' };
      const result = sanitizeDeep(obj, strictConfig) as typeof obj;
      expect(result.api_key).toBe('[REDACTED]');
      expect(result.apiKey).toBe('[REDACTED]');
    });

    it('redacts access_token and accessToken fields', () => {
      const obj = { access_token: 'tok1', accessToken: 'tok2' };
      const result = sanitizeDeep(obj, strictConfig) as typeof obj;
      expect(result.access_token).toBe('[REDACTED]');
      expect(result.accessToken).toBe('[REDACTED]');
    });

    it('redacts private_key and privateKey fields', () => {
      const obj = { private_key: 'pk1', privateKey: 'pk2' };
      const result = sanitizeDeep(obj, strictConfig) as typeof obj;
      expect(result.private_key).toBe('[REDACTED]');
      expect(result.privateKey).toBe('[REDACTED]');
    });

    it('does not redact non-sensitive field names', () => {
      const obj = { username: 'john', displayName: 'John Doe', id: '123' };
      const result = sanitizeDeep(obj, strictConfig) as typeof obj;
      expect(result.username).toBe('john');
      expect(result.displayName).toBe('John Doe');
      expect(result.id).toBe('123');
    });
  });

  describe('extraRedactFields', () => {
    it('redacts custom field names', () => {
      const obj = { ssn: '123-45-6789', name: 'John' };
      const result = sanitizeDeep(obj, strictConfig, ['ssn']) as typeof obj;
      expect(result.ssn).toBe('[REDACTED]');
      expect(result.name).toBe('John');
    });

    it('works alongside built-in redact fields', () => {
      const obj = { password: 'secret', custom_field: 'sensitive', safe: 'visible' };
      const result = sanitizeDeep(obj, strictConfig, ['custom_field']) as typeof obj;
      expect(result.password).toBe('[REDACTED]');
      expect(result.custom_field).toBe('[REDACTED]');
      expect(result.safe).toBe('visible');
    });
  });

  describe('mixed deep structure with redact fields', () => {
    it('redacts known fields nested inside arrays of objects', () => {
      const obj = {
        users: [
          { name: 'Alice', email: 'alice@example.com', password: 'pass1' },
          { name: 'Bob', email: 'bob@example.com', token: 'tok123' },
        ],
      };
      const result = sanitizeDeep(obj, strictConfig) as typeof obj;
      expect(result.users[0].name).toBe('Alice');
      expect(result.users[0].email).toBe('[REDACTED]');
      expect(result.users[0].password).toBe('[REDACTED]');
      expect(result.users[1].name).toBe('Bob');
      expect(result.users[1].email).toBe('[REDACTED]');
      expect(result.users[1].token).toBe('[REDACTED]');
    });

    it('sanitizes PII in non-redacted fields within deep structures', () => {
      const obj = {
        logs: [
          {
            message: 'Error for sk-abcdefghijklmnopqrstuvwx at 192.168.1.50',
            level: 'error',
          },
        ],
      };
      const result = sanitizeDeep(obj, strictConfig) as typeof obj;
      expect(result.logs[0].message).toContain('[API_KEY_REDACTED]');
      expect(result.logs[0].message).toContain('[IP_REDACTED]');
      expect(result.logs[0].level).toBe('error');
    });
  });
});
