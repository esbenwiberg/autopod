import {
  AutopodError,
  type ScanFindingPage,
  type ScanRecordDiagnostic,
  type ScanTriageDecision,
} from '@autopod/shared';
import { z } from 'zod';

// Bound legacy fields in SQLite before transferring or parsing their contents.
// Oversized records remain stored and explicitly unavailable for operator use.
export const scanFindingProjection = `f.id,
  CASE WHEN length(CAST(f.finding AS BLOB)) <= 65536 THEN f.finding END AS finding,
  f.disposition`;
export const scanDecisionProjection = `t.id, t.request_key, t.report_id, t.action, t.created_at,
  CASE WHEN length(CAST(t.finding_ids AS BLOB)) <= 65536 THEN t.finding_ids END AS finding_ids,
  CASE WHEN length(CAST(t.actor AS BLOB)) <= 16384 THEN t.actor END AS actor,
  CASE WHEN length(CAST(t.reason AS BLOB)) <= 16000 THEN t.reason END AS reason`;
const identity = z.string().min(1).max(200);
export const scanFindingSchema = z.object({
  id: identity,
  scanner: z.enum(['secrets', 'dependencies']),
  ruleId: z.string().min(1).max(1000),
  file: z.string().min(1).max(4096),
  line: z.number().int().positive().safe().optional(),
  severity: z.enum(['info', 'low', 'moderate', 'high', 'critical']),
  summary: z.string().max(60_000),
});
const actorSchema = z
  .object({
    type: z.literal('human'),
    userId: z.string().min(1).max(4096),
    displayName: z.string().max(4096).optional(),
  })
  .strict();
const selectedIds = z
  .array(identity)
  .min(1)
  .max(100)
  .refine((ids) => new Set(ids).size === ids.length);

export function scanRecordDiagnostic(
  kind: 'finding' | 'decision',
  id: string,
): ScanRecordDiagnostic {
  return {
    kind,
    recordId: id,
    message: `${kind === 'finding' ? 'Finding' : 'Decision'} evidence unavailable: malformed, oversized or inconsistent stored record. It remains stored and cannot authorize a repair; reconcile the original evidence.`,
  };
}
function unavailable(kind: 'finding' | 'decision', id: string): AutopodError {
  return new AutopodError(
    `${scanRecordDiagnostic(kind, id).message} Record: ${id.slice(0, 200)}`,
    'SCAN_RECONCILIATION_REQUIRED',
    409,
  );
}
function json(value: unknown): unknown {
  if (typeof value !== 'string') throw new Error('Unavailable projection');
  return JSON.parse(value);
}
export function readScanFinding(row: {
  id: string;
  finding: string | null;
  disposition: string;
}): ScanFindingPage['items'][number] {
  try {
    const finding = scanFindingSchema.parse(json(row.finding));
    if (finding.id !== row.id) throw new Error('Finding identity mismatch');
    const disposition = z.enum(['unresolved', 'deferred']).parse(row.disposition);
    return { ...finding, disposition };
  } catch {
    throw unavailable('finding', row.id);
  }
}
export function readScanDecision(row: Record<string, unknown>): ScanTriageDecision {
  try {
    const actor = json(row.actor);
    actorSchema.parse(actor);
    return {
      id: identity.parse(row.id),
      requestKey: identity.parse(row.request_key),
      reportId: identity.parse(row.report_id),
      findingIds: selectedIds.parse(json(row.finding_ids)),
      action: z.enum(['defer', 'resolve', 'select_repair']).parse(row.action),
      // Validation must not reorder the original actor used by idempotency.
      actor: actor as ScanTriageDecision['actor'],
      reason: z
        .string()
        .min(1)
        .max(4000)
        .refine((value) => value.trim().length > 0)
        .parse(row.reason),
      createdAt: z.string().min(1).max(100).parse(row.created_at),
    };
  } catch {
    throw unavailable('decision', typeof row.id === 'string' ? row.id : 'unavailable');
  }
}
