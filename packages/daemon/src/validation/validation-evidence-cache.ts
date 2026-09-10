import { createHash, randomUUID } from 'node:crypto';
import type { ReusedValidationEvidence, ValidationInputIdentity } from '@autopod/shared';
import type Database from 'better-sqlite3';
export type { ValidationInputIdentity } from '@autopod/shared';

export type ReusableValidationStage = 'lint' | 'test';
export interface ReusedPhaseResult {
  status: 'pass';
  infrastructureFailure?: never;
  duration: number;
  output: string;
  stdout?: string;
  stderr?: string;
  reusedEvidence: ReusedValidationEvidence;
}
export interface ValidationEvidenceCache {
  get(
    stage: ReusableValidationStage,
    identity: ValidationInputIdentity | undefined,
  ): ReusedPhaseResult | null;
  record(
    podId: string,
    stage: ReusableValidationStage,
    identity: ValidationInputIdentity | undefined,
    result: unknown,
  ): string | null;
}
const fields = [
  'sourceTree',
  'contract',
  'toolchain',
  'commands',
  'dependencies',
  'environment',
  'implementation',
] as const;
export function validationIdentityHash(
  identity: ValidationInputIdentity | undefined,
): string | null {
  if (
    !identity ||
    identity.version !== 1 ||
    identity.hermetic !== true ||
    fields.some((field) => !/^[a-f0-9]{64}$/.test(identity[field] ?? ''))
  )
    return null;
  return createHash('sha256')
    .update(JSON.stringify([identity.version, ...fields.map((field) => identity[field])]))
    .digest('hex');
}
function successfulResult(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  if (
    result.status !== 'pass' ||
    typeof result.duration !== 'number' ||
    !Number.isSafeInteger(result.duration) ||
    result.duration < 0 ||
    result.infrastructureFailure ||
    result.reusedEvidence
  )
    return null;
  for (const field of ['output', 'stdout', 'stderr'])
    if (result[field] !== undefined && typeof result[field] !== 'string') return null;
  return result;
}
export function createValidationEvidenceCache(db: Database.Database): ValidationEvidenceCache {
  return {
    get(stage, identity) {
      const hash = validationIdentityHash(identity);
      if (!hash) return null;
      const row = db
        .prepare(`SELECT id, pod_id, result, duration_ms, executed_at FROM validation_phase_evidence
        WHERE stage = ? AND identity_hash = ? AND length(result) <= 1000000 ORDER BY executed_at DESC, id DESC LIMIT 1`)
        .get(stage, hash) as
        | { id: string; pod_id: string; result: string; duration_ms: number; executed_at: string }
        | undefined;
      if (!row) return null;
      try {
        const result = successfulResult(JSON.parse(row.result));
        if (!result || result.duration !== row.duration_ms) return null;
        return {
          status: 'pass',
          duration: 0,
          output: typeof result.output === 'string' ? result.output : '',
          ...(typeof result.stdout === 'string' ? { stdout: result.stdout } : {}),
          ...(typeof result.stderr === 'string' ? { stderr: result.stderr } : {}),
          reusedEvidence: {
            receiptId: row.id,
            identityHash: hash,
            originalPodId: row.pod_id,
            originalExecutedAt: row.executed_at,
            originalDurationMs: row.duration_ms,
          },
        };
      } catch {
        return null;
      }
    },
    record(podId, stage, identity, value) {
      const hash = validationIdentityHash(identity);
      const result = successfulResult(value);
      if (!hash || !result) return null;
      const encoded = JSON.stringify(result);
      if (encoded.length > 1000000) return null;
      const id = randomUUID();
      db.prepare(`INSERT INTO validation_phase_evidence (id, pod_id, stage, identity_hash, identity, result, duration_ms, executed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id,
        podId,
        stage,
        hash,
        JSON.stringify(identity),
        encoded,
        result.duration,
        new Date().toISOString(),
      );
      return id;
    },
  };
}
