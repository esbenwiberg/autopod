import { createHash } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  AutopodError,
  type ScreenshotRef,
  type ValidationExecutionBinding,
  type ValidationResult,
} from '@autopod/shared';
import type Database from 'better-sqlite3';
import { slugifyPagePath } from './screenshot-store.js';
import {
  requiresValidationFailureSettlement,
  requiresValidationSettlement,
} from './validation-recovery-policy.js';
export const validationResultHash = (result: ValidationResult) =>
  createHash('sha256').update(JSON.stringify(result)).digest('hex');
const validationRecoveryError = (
  message: string,
  code = 'VALIDATION_EXECUTION_UNVERIFIED',
): never => {
  throw new AutopodError(message, code, 409);
};

/** Only the two fields populated by screenshot collection may extend engine evidence.
 * Compare the remaining serialized bytes, preserving order, identity and every
 * execution/usage/failure field. Existing refs are never removed for comparison.
 */
export function assertValidationScreenshotEnrichment(
  raw: ValidationResult,
  enriched: ValidationResult,
): void {
  const comparable = JSON.parse(JSON.stringify(enriched)) as ValidationResult;
  const canonicalRef = (ref: ScreenshotRef, source: 'smoke' | 'fact', name: string) => {
    const filename = name.toLowerCase();
    return (
      !filename.includes('..') &&
      isDeepStrictEqual(ref, {
        podId: raw.podId,
        source,
        filename,
        relativePath: path.join('screenshots', raw.podId, source, filename),
      })
    );
  };
  // Unknown execution cannot authorize even derived evidence collection.
  if (!requiresValidationSettlement({ lastValidationResult: raw })) {
    for (const [index, page] of comparable.smoke.pages.entries()) {
      const original = raw.smoke.pages[index];
      const screenshot = page.screenshot;
      if (!original || original.screenshot !== undefined || screenshot === undefined) continue;
      // The existing collector attaches duplicate paths to the first matching
      // page. Any collected duplicate may supply that ref; array positions stay fixed.
      const first = raw.smoke.pages.findIndex(
        (candidate) => candidate.path === original.path && candidate.screenshot === undefined,
      );
      if (
        first === index &&
        raw.smoke.pages.some(
          (candidate, sourceIndex) =>
            candidate.path === original.path &&
            candidate.screenshot === undefined &&
            !!candidate.screenshotPath &&
            canonicalRef(
              screenshot,
              'smoke',
              `${slugifyPagePath(candidate.path, sourceIndex)}.png`,
            ),
        )
      )
        page.screenshot = undefined;
    }
    for (const [factIndex, fact] of (comparable.factValidation?.results ?? []).entries()) {
      const original = raw.factValidation?.results[factIndex];
      for (const [index, attachment] of (fact.attachments ?? []).entries()) {
        const prior = original?.attachments?.[index];
        if (
          !original ||
          !prior ||
          prior.screenshot !== undefined ||
          attachment.screenshot === undefined
        )
          continue;
        const relative = path.normalize(prior.path);
        if (
          prior.kind !== 'screenshot' ||
          path.isAbsolute(prior.path) ||
          relative === '..' ||
          relative.startsWith(`..${path.sep}`) ||
          !prior.path.toLowerCase().endsWith('.png')
        )
          continue;
        const basename = path.basename(prior.path, path.extname(prior.path));
        const factId = original.factId.replace(/[^A-Za-z0-9._-]/g, '_') || 'fact';
        const safeBase = basename.replace(/[^A-Za-z0-9._-]/g, '_') || 'screenshot';
        if (canonicalRef(attachment.screenshot, 'fact', `${factId}-${index}-${safeBase}.png`))
          attachment.screenshot = undefined;
      }
    }
  }
  if (validationResultHash(comparable) !== validationResultHash(raw))
    validationRecoveryError('Validation publication may only add collected screenshot references');
}
export interface UnsettledValidationDispatch {
  id: string;
  binding: ValidationExecutionBinding;
  resultHash: string | null;
  timestamp: string | null;
  published: boolean;
}
export function unsettledDispatches(
  db: Database.Database,
  taskId: string | null = null,
): UnsettledValidationDispatch[] {
  const rows = db
    .prepare(`SELECT d.id,d.binding,r.dispatch_id AS published_id,o.dispatch_id AS outcome_id,
      r.result_hash AS published_hash,o.result_hash AS outcome_hash,
      json_extract(r.result,'$.timestamp') AS published_timestamp,
      json_extract(o.result,'$.timestamp') AS outcome_timestamp,
      json_extract(r.result,'$.infrastructureFailure') AS published_failure,
      json_extract(o.result,'$.infrastructureFailure') AS outcome_failure
      FROM validation_dispatches d
      LEFT JOIN validation_dispatch_results r ON r.dispatch_id=d.id
      LEFT JOIN validation_dispatch_outcomes o ON o.dispatch_id=d.id
      WHERE (? IS NULL OR d.task_id=?) ORDER BY d.created_at,d.id`)
    .all(taskId, taskId) as Array<{
    id: string;
    binding: string;
    published_id: string | null;
    outcome_id: string | null;
    published_hash: string | null;
    outcome_hash: string | null;
    published_timestamp: string | null;
    outcome_timestamp: string | null;
    published_failure: string | null;
    outcome_failure: string | null;
  }>;
  return rows
    .filter(
      (row) =>
        !row.published_id ||
        requiresValidationFailureSettlement(
          row.published_failure ? JSON.parse(row.published_failure) : undefined,
        ) ||
        requiresValidationFailureSettlement(
          row.outcome_failure ? JSON.parse(row.outcome_failure) : undefined,
        ),
    )
    .map((row) => ({
      id: row.id,
      binding: JSON.parse(row.binding) as ValidationExecutionBinding,
      resultHash: row.published_hash ?? row.outcome_hash,
      timestamp: row.published_timestamp ?? row.outcome_timestamp,
      published: row.published_id !== null,
    }));
}
/** Provider transport fence: immutable dispatch custody survives changed pod pointers. */
export function assertValidationResourceSettled(db: Database.Database, containerId: string): void {
  const held = unsettledDispatches(db).find((row) => row.binding.containerId === containerId);
  if (held)
    validationRecoveryError(
      `Validation dispatch ${held.id} retains this exact execution resource; no wake or release is authorized.`,
    );
  // Old rows cannot establish retrospective ownership, but a current unknown
  // projection is still a reason to refuse mutation, never permission to delete.
  const legacy = db
    .prepare(
      'SELECT last_validation_result AS result FROM pods WHERE container_id=? AND last_validation_result IS NOT NULL',
    )
    .all(containerId) as Array<{ result: string }>;
  if (
    legacy.some((row) =>
      requiresValidationSettlement({ lastValidationResult: JSON.parse(row.result) }),
    )
  )
    validationRecoveryError('Validation termination is unverified for this retained resource.');
}

export function listValidationExecutionResourceIds(db: Database.Database): string[] {
  return unsettledDispatches(db).map((row) => row.binding.containerId);
}

export function assertTaskValidationSettled(db: Database.Database, podId: string): void {
  // Archived pods retain history but cannot acquire new execution membership.
  // Leave their established admission rejection to the owning ledger.
  const member = db.prepare('SELECT task_id FROM task_executions WHERE pod_id=?').get(podId) as
    | { task_id: string }
    | undefined;
  if (!member) return;
  const rows = db
    .prepare(`SELECT p.id,p.lifecycle_generation AS generation,p.last_validation_result AS result
        FROM pods p JOIN task_executions e ON e.pod_id=p.id WHERE e.task_id=? AND p.last_validation_result IS NOT NULL`)
    .all(member.task_id) as Array<{ id: string; generation: number; result: string }>;
  for (const row of rows) {
    const result = JSON.parse(row.result) as ValidationResult;
    if (requiresValidationSettlement({ lastValidationResult: result }))
      validationRecoveryError(
        `Validation execution termination is unverified for task owner ${row.id}. Inspect ap reconcile-validation ${row.id} --json before retry or repair.`,
        'VALIDATION_EXECUTION_UNVERIFIED',
      );
  }
  const unresolved = unsettledDispatches(db, member.task_id)[0];
  if (unresolved)
    validationRecoveryError(
      `Validation dispatch ${unresolved.id} for task owner ${unresolved.binding.podId} has no verified execution settlement. Inspect ap reconcile-validation ${unresolved.binding.podId} --json; missing result publication is not permission to repeat work.`,
      'VALIDATION_EXECUTION_UNVERIFIED',
    );
}
