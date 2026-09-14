import { randomUUID } from 'node:crypto';
import type { PimActivation, PimEligibility, PimSelection } from '@autopod/shared';
import type Database from 'better-sqlite3';
import { configurationDigest } from '../configuration/configuration-digest.js';
import { configurationError } from '../configuration/configuration-store.js';

interface Row {
  id: string;
  assignment_key: string;
  status: PimActivation['status'];
  provider_request_id: string | null;
  provider_assignment_id: string | null;
  ownership: PimActivation['ownership'];
  expires_at: string | null;
  reason: string | null;
}
function project(row: Row): PimActivation {
  return {
    id: row.id,
    assignmentKey: row.assignment_key,
    status: row.status,
    providerRequestId: row.provider_request_id,
    providerAssignmentId: row.provider_assignment_id,
    ownership: row.ownership,
    expiresAt: row.expires_at,
    reason: row.reason,
  };
}
export function pimAssignmentKey(
  selection: Pick<
    PimSelection,
    'tenantId' | 'principalId' | 'type' | 'eligibilityId' | 'roleId' | 'scope'
  >,
): string {
  return configurationDigest({
    tenantId: selection.tenantId,
    principalId: selection.principalId,
    type: selection.type,
    eligibilityId: selection.eligibilityId,
    roleId: selection.roleId,
    scope: selection.scope,
  });
}
export interface PimActivationRepository {
  get(id: string): PimActivation;
  reserve(
    podId: string,
    requestId: string,
    selection: PimSelection,
    eligibility: PimEligibility,
  ): PimActivation;
  claim(id: string): boolean;
  observe(
    id: string,
    input: Pick<
      PimActivation,
      'status' | 'providerRequestId' | 'providerAssignmentId' | 'ownership' | 'expiresAt' | 'reason'
    >,
  ): PimActivation;
  release(podId: string): string[];
  usable(podId: string, requestId: string): boolean;
  recoverInterrupted(): number;
}
export function createPimActivationRepository(
  db: Database.Database,
  now: () => number = Date.now,
): PimActivationRepository {
  function get(id: string): PimActivation {
    const row = db.prepare('SELECT * FROM pim_activation_records WHERE id=?').get(id) as
      | Row
      | undefined;
    if (!row) configurationError('PIM activation is unavailable', 'PIM_ACTIVATION_NOT_FOUND', 404);
    return project(row);
  }
  return {
    get,
    reserve: db.transaction(
      (
        podId: string,
        requestId: string,
        selection: PimSelection,
        eligibility: PimEligibility,
      ): PimActivation => {
        const key = pimAssignmentKey(selection);
        if (key !== pimAssignmentKey(eligibility))
          configurationError(
            'PIM eligibility does not match the selected assignment',
            'PIM_ELIGIBILITY_CHANGED',
            403,
          );
        const digest = configurationDigest(selection);
        const existing = db
          .prepare(
            'SELECT activation_id,request_digest FROM pim_activation_leases WHERE pod_id=? AND request_id=?',
          )
          .get(podId, requestId) as { activation_id: string; request_digest: string } | undefined;
        if (existing) {
          if (existing.request_digest !== digest)
            configurationError(
              'PIM request ID was reused with different settings',
              'PIM_REQUEST_CONFLICT',
              409,
            );
          return get(existing.activation_id);
        }
        const timestamp = new Date(now()).toISOString();
        db.prepare(
          "UPDATE pim_activation_records SET status='expired',updated_at=? WHERE assignment_key=? AND status IN ('active','pending') AND expires_at IS NOT NULL AND expires_at<=?",
        ).run(timestamp, key, timestamp);
        let active = db
          .prepare(
            "SELECT * FROM pim_activation_records WHERE assignment_key=? AND status IN ('reserved','submitting','pending','active','uncertain')",
          )
          .get(key) as Row | undefined;
        if (!active) {
          const id = randomUUID();
          db.prepare(
            "INSERT INTO pim_activation_records(id,assignment_key,eligibility_json,status,ownership,created_at,updated_at) VALUES(?,?,?,'reserved','unconfirmed',?,?)",
          ).run(id, key, JSON.stringify(eligibility), timestamp, timestamp);
          active = db.prepare('SELECT * FROM pim_activation_records WHERE id=?').get(id) as Row;
        }
        const match = /^PT([1-9][0-9]*)(H|M)$/.exec(selection.duration);
        if (!match) configurationError('Invalid selected PIM duration', 'PIM_INVALID_DURATION');
        const minutes = Number(match[1]) * (match[2] === 'H' ? 60 : 1);
        const until = new Date(now() + minutes * 60_000).toISOString();
        db.prepare(
          'INSERT INTO pim_activation_leases(pod_id,request_id,request_digest,activation_id,requested_until,created_at) VALUES(?,?,?,?,?,?)',
        ).run(podId, requestId, digest, active.id, until, timestamp);
        return project(active);
      },
    ),
    claim(id: string): boolean {
      return (
        db
          .prepare(
            "UPDATE pim_activation_records SET status='submitting',provider_request_id=id,updated_at=? WHERE id=? AND status='reserved'",
          )
          .run(new Date(now()).toISOString(), id).changes === 1
      );
    },
    observe(
      id: string,
      input: Pick<
        PimActivation,
        | 'status'
        | 'providerRequestId'
        | 'providerAssignmentId'
        | 'ownership'
        | 'expiresAt'
        | 'reason'
      >,
    ): PimActivation {
      if (
        input.status === 'active' &&
        (!input.providerAssignmentId ||
          (input.expiresAt === null
            ? input.ownership !== 'pre-existing'
            : !Number.isFinite(Date.parse(input.expiresAt)) ||
              Date.parse(input.expiresAt) <= now()))
      )
        configurationError(
          'PIM active status requires a current provider assignment and expiry',
          'PIM_ACTIVATION_UNCONFIRMED',
          409,
        );
      const changed = db
        .prepare(
          "UPDATE pim_activation_records SET status=?,provider_request_id=?,provider_assignment_id=?,ownership=?,expires_at=?,reason=?,updated_at=? WHERE id=? AND status IN ('reserved','submitting','pending','active','uncertain')",
        )
        .run(
          input.status,
          input.providerRequestId,
          input.providerAssignmentId,
          input.ownership,
          input.expiresAt,
          input.reason,
          new Date(now()).toISOString(),
          id,
        ).changes;
      if (changed !== 1)
        configurationError('PIM activation state changed', 'PIM_ACTIVATION_CHANGED', 409);
      return get(id);
    },
    release(podId: string): string[] {
      return db.transaction(() => {
        const active = db
          .prepare(
            'SELECT DISTINCT activation_id FROM pim_activation_leases WHERE pod_id=? AND released_at IS NULL',
          )
          .all(podId) as Array<{ activation_id: string }>;
        db.prepare(
          'UPDATE pim_activation_leases SET released_at=? WHERE pod_id=? AND released_at IS NULL',
        ).run(new Date(now()).toISOString(), podId);
        return active
          .filter(
            (row) =>
              !db
                .prepare(
                  'SELECT 1 FROM pim_activation_leases WHERE activation_id=? AND released_at IS NULL AND requested_until>?',
                )
                .get(row.activation_id, new Date(now()).toISOString()),
          )
          .map((row) => row.activation_id);
      })();
    },
    /** A lease cannot extend the provider activation or its user's selected duration. */
    usable(podId: string, requestId: string): boolean {
      return !!db
        .prepare(
          "SELECT 1 FROM pim_activation_leases l JOIN pim_activation_records a ON a.id=l.activation_id WHERE l.pod_id=? AND l.request_id=? AND l.released_at IS NULL AND l.requested_until>? AND a.status='active' AND (a.expires_at>? OR (a.expires_at IS NULL AND a.ownership='pre-existing'))",
        )
        .get(podId, requestId, new Date(now()).toISOString(), new Date(now()).toISOString());
    },
    recoverInterrupted(): number {
      return db
        .prepare(
          "UPDATE pim_activation_records SET status='uncertain',reason='Daemon restarted before activation outcome was recorded',updated_at=? WHERE status='submitting'",
        )
        .run(new Date(now()).toISOString()).changes;
    },
  };
}
