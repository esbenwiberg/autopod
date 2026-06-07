import { describe, expect, it } from 'vitest';
import {
  nullableReadinessReviewSchema,
  readinessAreaStatusSchema,
  readinessReviewSchema,
  readinessStatusSchema,
} from '../schemas/pod.schema.js';
import type {
  ReadinessAreaStatus,
  ReadinessReview,
  ReadinessStatus,
} from './readiness.js';

const compactSnapshot: ReadinessReview = {
  status: 'needs_review',
  summary: 'Validation passed, but denied egress needs operator review.',
  computedAt: '2026-06-07T12:00:00.000Z',
  scope: 'pod',
  areas: [
    {
      area: 'validation',
      status: 'ready',
      title: 'Validation',
      summary: 'Latest blocking validation passed.',
      sourceRefs: [{ kind: 'validation', label: 'Validation', id: 'attempt-1' }],
    },
    {
      area: 'network',
      status: 'needs_review',
      title: 'Network',
      summary: 'Denied egress events were recorded.',
      sourceRefs: [{ kind: 'event', label: 'Denied egress' }],
    },
    {
      area: 'advisory_qa',
      status: 'not_available',
      title: 'Advisory QA',
      summary: 'Advisory QA has not completed.',
      sourceRefs: [],
    },
    {
      area: 'pr',
      status: 'not_applicable',
      title: 'PR',
      summary: 'No PR exists yet.',
      sourceRefs: [],
    },
  ],
  findings: [
    {
      id: 'network-denied-egress',
      area: 'network',
      severity: 'warning',
      title: 'Denied egress observed',
      detail: 'The pod attempted an outbound connection blocked by policy.',
      sourceRefs: [{ kind: 'event', label: 'Denied egress' }],
    },
  ],
  approval: {
    approvedAt: '2026-06-07T12:05:00.000Z',
    approvedBy: 'human',
    statusAtApproval: 'needs_review',
    scope: 'pod',
    reason: 'Connection was expected during package restore.',
  },
};

describe('Readiness Review types and schemas', () => {
  it('accepts the intended top-level and area statuses', () => {
    const readinessStatuses: ReadinessStatus[] = ['ready', 'needs_review', 'risky', 'waived'];
    const areaStatuses: ReadinessAreaStatus[] = [
      ...readinessStatuses,
      'not_applicable',
      'not_available',
    ];

    for (const status of readinessStatuses) {
      expect(readinessStatusSchema.parse(status)).toBe(status);
    }
    for (const status of areaStatuses) {
      expect(readinessAreaStatusSchema.parse(status)).toBe(status);
    }
  });

  it('models a compact readiness snapshot without raw evidence fields', () => {
    const parsed = readinessReviewSchema.parse({
      ...compactSnapshot,
      futureField: { tolerated: true },
    });

    expect(parsed.status).toBe('needs_review');
    expect(parsed.areas.map((area) => area.status)).toContain('not_available');
    expect(parsed.findings[0]?.sourceRefs[0]).toEqual({
      kind: 'event',
      label: 'Denied egress',
    });

    const forbiddenRawFields = [
      'logs',
      'screenshots',
      'diff',
      'actionAuditBundle',
      'securityScanOutput',
      'prCheckPayload',
    ];
    for (const field of forbiddenRawFields) {
      expect(field in parsed).toBe(false);
    }
  });

  it('rejects known raw evidence payload fields while tolerating future fields', () => {
    const result = readinessReviewSchema.safeParse({
      ...compactSnapshot,
      futureField: { tolerated: true },
      findings: [
        {
          ...compactSnapshot.findings[0],
          screenshots: [{ path: '/tmp/raw.png' }],
        },
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['findings', 0, 'screenshots']);
    }
  });

  it('accepts null and undefined for old pods with no readiness snapshot', () => {
    expect(nullableReadinessReviewSchema.parse(null)).toBeNull();
    expect(nullableReadinessReviewSchema.parse(undefined)).toBeUndefined();
  });
});
