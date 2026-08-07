import { describe, expect, it } from 'vitest';
import {
  MAX_REVIEW_RESPONSE_BYTES,
  ReviewStructuredOutputError,
  parseAxisResponse,
  reviewAxisOutputContract,
  reviewSynthesisOutputContract,
} from './review-structured-output.js';

const finding = {
  severity: 'HIGH',
  path: 'src/a.ts',
  line: 4,
  symbol: 'guard',
  claim: 'missing guard',
  evidence: 'the route has no guard',
  remediation: 'add authorization',
  confidence: 0.9,
};
const parse = (value: unknown) =>
  parseAxisResponse(
    typeof value === 'string' ? value : JSON.stringify(value),
    'security_authority',
  );

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function expectProviderCompatibleSchema(value: unknown): void {
  const record = asRecord(value);
  if (!record) return;

  if (record.type === 'object') {
    expect(record.additionalProperties).toBe(false);
    const properties = asRecord(record.properties) ?? {};
    const required = Array.isArray(record.required) ? record.required : [];
    expect([...required].sort()).toEqual(Object.keys(properties).sort());
  }

  const properties = asRecord(record.properties);
  if (properties) Object.values(properties).forEach(expectProviderCompatibleSchema);
  if (record.items) expectProviderCompatibleSchema(record.items);
  if (Array.isArray(record.anyOf)) record.anyOf.forEach(expectProviderCompatibleSchema);
}

describe('parseAxisResponse', () => {
  it('emits provider-compatible schema contracts', () => {
    expectProviderCompatibleSchema(JSON.parse(reviewAxisOutputContract.jsonSchema));
    expectProviderCompatibleSchema(JSON.parse(reviewSynthesisOutputContract.jsonSchema));
  });

  it('normalizes nullable optional fields from the provider transport', () => {
    const [normalized] = parse({ findings: [{ ...finding, line: null, symbol: null }] });
    expect(normalized).not.toHaveProperty('line');
    expect(normalized).not.toHaveProperty('symbol');
  });

  it.each([
    { findings: [finding] },
    { result: JSON.stringify({ findings: [finding] }) },
    { item: { text: JSON.stringify({ findings: [finding] }) } },
    '```json\n{"findings":[{"severity":"HIGH","path":"src/a.ts","line":4,"symbol":"guard","claim":"missing guard","evidence":"the route has no guard","remediation":"add authorization","confidence":0.9}]}\n```',
  ])('accepts supported plain, envelope, and fenced JSON', (value) => {
    expect(parse(value)).toMatchObject([{ axis: 'security_authority', id: '', ...finding }]);
  });

  it.each([
    { findings: [{ ...finding, unknown: true }] },
    { findings: [{ ...finding, severity: 'LOW' }] },
    { findings: [{ ...finding, evidence: undefined }] },
    { findings: [{ ...finding, line: 0 }] },
    { findings: [{ ...finding, confidence: 2 }] },
    { findings: Array.from({ length: 101 }, () => finding) },
  ])('rejects invalid strict contracts', (value) => {
    expect(() => parse(value)).toThrow(ReviewStructuredOutputError);
  });

  it('rejects oversized responses before parsing', () => {
    expect(() => parse(`{"findings":[]}${' '.repeat(MAX_REVIEW_RESPONSE_BYTES)}`)).toThrow(
      ReviewStructuredOutputError,
    );
  });

  it('rejects arbitrary prose around JSON rather than extracting a substring', () => {
    expect(() => parse(`model preface ${JSON.stringify({ findings: [finding] })}`)).toThrow(
      ReviewStructuredOutputError,
    );
  });
});
