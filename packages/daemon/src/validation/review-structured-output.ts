import type { ReviewAxis, StructuredReviewFinding } from '@autopod/shared';
import { z } from 'zod';

export const MAX_REVIEW_RESPONSE_BYTES = 1_000_000;
export const MAX_AXIS_FINDINGS = 100;
export const REVIEW_VALIDATION_CODE = 'REVIEW_AXIS_RESPONSE_INVALID';

const bounded = (max: number) => z.string().trim().min(1).max(max);
const findingSchema = z
  .object({
    severity: z.enum(['MEDIUM', 'HIGH', 'CRITICAL']),
    path: bounded(1_024),
    line: z.number().int().positive().optional(),
    symbol: bounded(512).optional(),
    claim: bounded(4_000),
    evidence: bounded(8_000),
    remediation: bounded(4_000),
    confidence: z.number().finite().min(0).max(1),
  })
  .strict();

export const axisResponseSchema = z
  .object({ findings: z.array(findingSchema).max(MAX_AXIS_FINDINGS) })
  .strict();

export interface ReviewerOutputContract {
  name: 'review-axis-v1';
  jsonSchema: string;
}

export const reviewAxisOutputContract: ReviewerOutputContract = {
  name: 'review-axis-v1',
  jsonSchema: JSON.stringify({
    type: 'object',
    additionalProperties: false,
    required: ['findings'],
    properties: {
      findings: {
        type: 'array',
        maxItems: MAX_AXIS_FINDINGS,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['severity', 'path', 'claim', 'evidence', 'remediation', 'confidence'],
          properties: {
            severity: { type: 'string', enum: ['MEDIUM', 'HIGH', 'CRITICAL'] },
            path: { type: 'string', minLength: 1, maxLength: 1024 },
            line: { type: 'integer', minimum: 1 },
            symbol: { type: 'string', minLength: 1, maxLength: 512 },
            claim: { type: 'string', minLength: 1, maxLength: 4000 },
            evidence: { type: 'string', minLength: 1, maxLength: 8000 },
            remediation: { type: 'string', minLength: 1, maxLength: 4000 },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
          },
        },
      },
    },
  }),
};

export class ReviewStructuredOutputError extends Error {
  readonly code = REVIEW_VALIDATION_CODE;
  constructor() {
    super('Reviewer response did not satisfy the required structured response contract');
    this.name = 'ReviewStructuredOutputError';
  }
}

export function parseAxisResponse(stdout: string, axis: ReviewAxis): StructuredReviewFinding[] {
  if (Buffer.byteLength(stdout, 'utf8') > MAX_REVIEW_RESPONSE_BYTES)
    throw new ReviewStructuredOutputError();
  let value: unknown;
  try {
    value = JSON.parse(unwrapJson(stdout));
  } catch {
    throw new ReviewStructuredOutputError();
  }
  const parsed = axisResponseSchema.safeParse(unwrapEnvelope(value));
  if (!parsed.success) throw new ReviewStructuredOutputError();
  return parsed.data.findings.map((finding) => ({ ...finding, axis, id: '' }));
}

function unwrapJson(input: string): string {
  const trimmed = input.trim();
  const fence = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  if (fence) return fence[1] ?? '';
  return trimmed;
}

function unwrapEnvelope(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  for (const key of ['result', 'output', 'response']) {
    const wrapped = record[key];
    if (typeof wrapped === 'string') {
      try {
        return JSON.parse(wrapped);
      } catch {
        return value;
      }
    }
    if (wrapped && typeof wrapped === 'object') return wrapped;
  }
  return value;
}
