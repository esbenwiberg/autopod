import { describe, expect, it } from 'vitest';
import {
  type ProviderErrorEvidence,
  classifyProviderError,
  classifySettledPiProviderError,
} from './provider-error-classifier.js';

const quotaFixtures = [
  {
    runtime: 'claude' as const,
    evidence: {
      code: 'usage_limit_reached',
      message: "You've hit your usage limit",
      retryAfter: '2026-07-25T17:00:00Z',
    },
  },
  {
    runtime: 'claude' as const,
    evidence: {
      message: "You've hit your session limit · resets 12:30pm (UTC)",
    },
  },
  {
    runtime: 'codex' as const,
    evidence: {
      code: 'usage_limit_reached',
      message: "You've hit your usage limit.",
      retryAfter: '3600',
    },
  },
  {
    runtime: 'copilot' as const,
    evidence: {
      code: 'premium_request_limit_reached',
      message: 'You have exhausted your premium requests.',
    },
  },
] as const;

describe('classifyProviderError', () => {
  it.each(quotaFixtures)(
    'classifies fixture-backed terminal $runtime quota evidence as definitive',
    ({ runtime, evidence }) => {
      expect(classifyProviderError(runtime, evidence)).toEqual({
        category: 'quota_exhausted',
        definitive: true,
        sanitizedMessage: evidence.message,
        retryAfter: 'retryAfter' in evidence ? (evidence.retryAfter ?? null) : null,
      });
    },
  );

  it.each(['claude', 'codex', 'copilot', 'pi'] as const)(
    'treats a bare HTTP 429 from %s as transient',
    (runtime) => {
      expect(
        classifyProviderError(runtime, { status: 429, message: 'Unexpected HTTP response' }),
      ).toMatchObject({ category: 'transient', definitive: false });
    },
  );

  it.each([
    { code: 'invalid_api_key', message: 'Invalid API key.', category: 'auth' },
    {
      code: 'provider_unavailable',
      message: 'Provider unavailable.',
      category: 'provider_unavailable',
    },
  ])('prioritizes structured $category evidence over a mixed HTTP 429', (evidence) => {
    expect(classifyProviderError('pi', { ...evidence, status: 429 })).toMatchObject({
      category: evidence.category,
      definitive: false,
    });
  });

  it.each(['claude', 'codex', 'pi'] as const)(
    'fails closed when %s emits a known quota code with drifted text',
    (runtime) => {
      expect(
        classifyProviderError(runtime, {
          code: 'usage_limit_reached',
          message: 'A newly formatted upstream failure',
        }),
      ).toMatchObject({ category: 'unknown', definitive: false });
    },
  );

  it.each([
    "You've hit your session limit · resets soon (UTC)",
    "You've hit your session limit - resets 12:30pm (UTC)",
    "You've hit your session limit · resets 12:30pm UTC",
    "You've hit your session limit · resets 13:30pm (UTC)",
    "You've hit your session limit · resets 12:60pm (UTC)",
    "You've hit your session limit · resets 12:30pm (UTC).",
  ])('fails closed for drifted Claude session-limit text: %s', (message) => {
    expect(classifyProviderError('claude', { message })).toMatchObject({
      category: 'unknown',
      definitive: false,
    });
  });

  it.each([
    {
      runtime: 'claude' as const,
      code: 'billing_error',
      message: "You've hit your usage limit",
    },
    {
      runtime: 'codex' as const,
      code: 'insufficient_quota',
      message: "You've hit your usage limit.",
    },
    {
      runtime: 'pi' as const,
      code: 'usage_limit_reached',
      message: 'Provider quota exhausted',
    },
  ])(
    'fails closed for mismatched $runtime quota signature halves',
    ({ runtime, code, message }) => {
      const classify =
        runtime === 'pi'
          ? classifySettledPiProviderError
          : (evidence: ProviderErrorEvidence) => classifyProviderError(runtime, evidence);
      expect(classify({ code, message })).toMatchObject({
        definitive: false,
      });
    },
  );

  it.each(['claude', 'codex', 'copilot', 'pi'] as const)(
    'classifies recognized %s authentication failures without quota definitiveness',
    (runtime) => {
      expect(
        classifyProviderError(runtime, {
          code: 'invalid_api_key',
          message: 'Invalid API key: token=secret-value',
        }),
      ).toMatchObject({
        category: 'auth',
        definitive: false,
        sanitizedMessage: 'Invalid API key: [REDACTED]',
      });
    },
  );

  it.each(['claude', 'codex', 'copilot', 'pi'] as const)(
    'classifies recognized %s provider outages without quota definitiveness',
    (runtime) => {
      expect(
        classifyProviderError(runtime, {
          code: 'service_unavailable',
          message: 'Service temporarily unavailable.',
        }),
      ).toMatchObject({ category: 'provider_unavailable', definitive: false });
    },
  );

  it.each(['claude', 'codex', 'copilot', 'pi'] as const)(
    'fails closed for malformed %s evidence',
    (runtime) => {
      expect(
        classifyProviderError(runtime, {
          code: { nested: 'usage_limit_reached' },
          message: { private: 'payload' },
          retryAfter: { seconds: 30 },
        }),
      ).toEqual({
        category: 'unknown',
        definitive: false,
        sanitizedMessage: `${runtime} provider error`,
        retryAfter: null,
      });
    },
  );

  it.each(['claude', 'codex', 'copilot', 'pi'] as const)(
    'fails closed for unknown %s upstream text',
    (runtime) => {
      expect(
        classifyProviderError(runtime, { message: 'Vendor changed this terminal error shape' }),
      ).toMatchObject({ category: 'unknown', definitive: false });
    },
  );

  it('keeps Pi quota-shaped evidence transient until native retries settle', () => {
    const evidence: ProviderErrorEvidence = {
      code: 'quota_exceeded',
      message: 'Provider quota exhausted',
    };

    expect(classifyProviderError('pi', evidence)).toMatchObject({
      category: 'transient',
      definitive: false,
    });
    expect(classifySettledPiProviderError(evidence)).toMatchObject({
      category: 'quota_exhausted',
      definitive: true,
    });
  });

  it('rejects unsupported reset metadata and bounds the sanitized operator message', () => {
    const jwt = `eyJ${'a'.repeat(24)}.eyJ${'b'.repeat(24)}.${'c'.repeat(24)}`;
    const result = classifyProviderError('codex', {
      message: `Unknown failure api_key=secret user@example.com ${jwt} ${'x'.repeat(1_500)}`,
      retryAfter: 'tomorrow-ish',
    });

    expect(result.retryAfter).toBeNull();
    expect(result.sanitizedMessage).not.toContain('secret');
    expect(result.sanitizedMessage).not.toContain('user@example.com');
    expect(result.sanitizedMessage).not.toContain(jwt);
    expect(result.sanitizedMessage.length).toBeLessThanOrEqual(1_200);
  });

  it.each([
    'Bearer opaque-access-token',
    'Authorization: Bearer opaque.access.token',
    'Authorization: Basic dXNlcjpwYXNzd29yZA==',
  ])('redacts whitespace-delimited authorization credentials: %s', (credential) => {
    const result = classifyProviderError('claude', {
      message: `Authentication failed: ${credential}`,
    });

    expect(result.sanitizedMessage).not.toContain(credential.split(' ').at(-1));
    expect(result.sanitizedMessage).toContain('[REDACTED]');
  });
});
