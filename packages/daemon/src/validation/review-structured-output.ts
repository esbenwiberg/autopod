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
  name: string;
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

/** Provider-native guard for synthesis; local source-backed validation remains authoritative. */
export const reviewSynthesisOutputContract: ReviewerOutputContract = {
  name: 'review-synthesis-v1',
  jsonSchema: JSON.stringify({
    type: 'object',
    additionalProperties: false,
    required: ['decisions'],
    properties: {
      decisions: {
        type: 'array',
        maxItems: 600,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['action', 'sourceIds'],
          properties: {
            action: { type: 'string', enum: ['accept', 'reject', 'merge'] },
            sourceIds: { type: 'array', minItems: 1, maxItems: 101, items: { type: 'string' } },
            reason: { type: 'string', minLength: 1, maxLength: 4000 },
            finding: { type: 'object' },
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
  const parsed = axisResponseSchema.safeParse(parseReviewStructuredJson(stdout));
  if (!parsed.success) throw new ReviewStructuredOutputError();
  return parsed.data.findings.map((finding) => ({ ...finding, axis, id: '' }));
}

/** Shared transport-only parser for every frozen review protocol response. */
export function parseReviewStructuredJson(stdout: string): unknown {
  if (Buffer.byteLength(stdout, 'utf8') > MAX_REVIEW_RESPONSE_BYTES)
    throw new ReviewStructuredOutputError();
  let value: unknown;
  try {
    value = JSON.parse(unwrapJson(stdout));
  } catch {
    throw new ReviewStructuredOutputError();
  }
  return unwrapEnvelope(value);
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
  const item = record.item;
  if (item && typeof item === 'object' && !Array.isArray(item)) {
    const text = (item as Record<string, unknown>).text;
    if (typeof text === 'string') {
      try {
        return JSON.parse(text);
      } catch {
        return value;
      }
    }
  }
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
