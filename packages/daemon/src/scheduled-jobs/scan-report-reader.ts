import {
  type ScanReportView,
  type ScheduledScanReport,
  scheduledScanPolicySchema,
} from '@autopod/shared';
import { z } from 'zod';
import { scanFindingSchema } from './scan-record-reader.js';

export const scanReportProjection = `id, job_id, status, created_at, completed_at,
  collection IS NOT NULL AS collection_present,
  CASE WHEN length(CAST(policy AS BLOB)) <= 65536 THEN policy END AS policy,
  CASE WHEN length(CAST(collection AS BLOB)) <= 2097152 THEN collection END AS collection,
  CASE WHEN length(CAST(judgment AS BLOB)) <= 131072 THEN judgment END AS judgment`;
const sha = z.string().regex(/^[a-f0-9]{40,64}$/);
const text = z.string().max(4096);
const scanner = z.enum(['secrets', 'dependencies']);
const collectionSchema = z
  .object({
    version: z.literal(1),
    repository: text.min(1),
    baseSha: sha.nullable(),
    headSha: sha.nullable(),
    baseKind: z.enum(['commit', 'empty_tree']).optional(),
    window: z
      .object({
        start: text,
        end: text,
        semantics: z.literal('first_parent_committer_time_net_delta'),
        selectedCommits: z.array(sha).max(5000),
      })
      .strict()
      .optional(),
    files: z
      .array(
        z.object({ path: text.min(1), change: z.enum(['added', 'modified', 'deleted']) }).strict(),
      )
      .max(200),
    stacks: z.array(text).max(100),
    scanners: z
      .array(
        z
          .object({
            scanner,
            version: text.nullable(),
            status: z.enum([
              'completed',
              'not_applicable',
              'skipped_empty',
              'unavailable',
              'failed',
            ]),
            diagnostic: text.optional(),
            findingCount: z.number().int().nonnegative().safe().nullable(),
            evidenceHash: text.optional(),
          })
          .strict(),
      )
      .max(2),
    findings: z.array(scanFindingSchema).max(1000),
    diagnostics: z.array(text).max(1000),
  })
  .strict();
const judgmentSchema = z
  .object({
    status: z.enum(['not_requested', 'skipped_empty', 'pending', 'complete', 'unavailable']),
    text: z.string().max(16000).optional(),
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative().safe(),
        outputTokens: z.number().int().nonnegative().safe(),
        costUsd: z.number().finite().nonnegative().nullable(),
        durationMs: z.number().finite().nonnegative(),
        model: text.min(1),
        provider: text.min(1),
        providerAccountId: text.nullable(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** Validate without transforming the immutable evidence or its key ordering. */
export function readScanReport(row: Record<string, unknown>): ScanReportView {
  const evidenceDiagnostics: string[] = [];
  function read<T>(field: string, schema: z.ZodType<T>): T | null {
    try {
      if (typeof row[field] !== 'string') throw new Error('Unavailable projection');
      const value: unknown = JSON.parse(row[field]);
      schema.parse(value);
      if (field === 'policy' && !(value && typeof value === 'object' && 'judgment' in value))
        throw new Error('Missing recorded judgment policy');
      return value as T;
    } catch {
      evidenceDiagnostics.push(
        `${field[0]?.toUpperCase()}${field.slice(1)} evidence unavailable: malformed, oversized or unsupported stored record. Reconcile the original evidence before recording decisions or launching repairs.`,
      );
      return null;
    }
  }
  const collection = row.collection_present ? read('collection', collectionSchema) : null;
  if (
    !collection &&
    !row.collection_present &&
    ['complete', 'empty_delta'].includes(String(row.status))
  )
    evidenceDiagnostics.push(
      'Collection evidence unavailable for the recorded completion; no clean result can be verified.',
    );
  return {
    kind: 'scan_report',
    id: row.id as string,
    jobId: row.job_id as string,
    status: row.status as ScheduledScanReport['status'],
    policy: read('policy', scheduledScanPolicySchema),
    collection,
    judgment: read('judgment', judgmentSchema),
    createdAt: row.created_at as string,
    completedAt: row.completed_at as string | null,
    evidenceDiagnostics,
  };
}
