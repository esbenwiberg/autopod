import { randomUUID } from 'node:crypto';
import type { NativeGoalProcessIdentity } from '@autopod/shared';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { configurationDigest } from '../configuration/configuration-digest.js';
import { configurationError } from '../configuration/configuration-store.js';

const id = z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
/** Nonsecret approval material. Runtime env values and provider tokens never enter this ledger. */
export const deploymentPlanSchema = z
  .object({
    podId: id,
    operationKey: id,
    ownerId: z.string().min(1).max(256),
    targetId: id,
    repositoryId: id,
    setupId: id,
    launchDigest: digest,
    sourceKind: z.literal('published-default'),
    sourceBranch: z.string().min(1).max(256),
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
    sourceDigest: digest,
    scriptDigest: digest,
    scriptPath: z
      .string()
      .regex(/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/)
      .refine((v) => v.split('/').every((p) => p !== '.' && p !== '..')),
    args: z
      .array(
        z
          .string()
          .max(4096)
          .refine((v) => !v.includes('\0')),
      )
      .max(64),
    image: z.string().regex(/^.+@sha256:[a-f0-9]{64}$/),
    runnerDigest: digest,
    environmentDigest: digest,
    credentialRevisions: z.record(z.number().int().positive()),
    expiresAt: z.string().datetime(),
  })
  .strict();
export type DeploymentPlan = z.infer<typeof deploymentPlanSchema>;
type State =
  | 'awaiting_approval'
  | 'approved'
  | 'denied'
  | 'running'
  | 'completed'
  | 'failed'
  | 'uncertain'
  | 'reconciled';
export interface DeploymentRun {
  id: string;
  plan: DeploymentPlan;
  digest: string;
  state: State;
  approvedBy: string | null;
  containerId: string | null;
  exec: NativeGoalProcessIdentity | null;
  receipt: { exitCode: number; containerRemoved: true; outputBytes: number } | null;
  reconciliation: {
    actorId: string;
    externalOutcome: 'deployed' | 'not-deployed';
    note: string;
    at: string;
  } | null;
}
export function createDeploymentRunRepository(db: Database.Database, now = () => new Date()) {
  function get(runId: string): DeploymentRun {
    const row = db.prepare('SELECT * FROM deployment_runs WHERE id=?').get(runId) as
      | {
          id: string;
          plan_json: string;
          plan_digest: string;
          state: State;
          approved_by: string | null;
          container_id: string | null;
          exec_json: string | null;
          receipt_json: string | null;
          reconciliation_json: string | null;
        }
      | undefined;
    if (!row) configurationError('Deployment request not found', 'DEPLOYMENT_NOT_FOUND', 404);
    const plan = deploymentPlanSchema.parse(JSON.parse(row.plan_json));
    if (configurationDigest(plan) !== row.plan_digest)
      configurationError('Deployment approval material changed', 'DEPLOYMENT_PLAN_CHANGED', 409);
    return {
      id: row.id,
      plan,
      digest: row.plan_digest,
      state: row.state,
      approvedBy: row.approved_by,
      containerId: row.container_id,
      exec: row.exec_json ? JSON.parse(row.exec_json) : null,
      receipt: row.receipt_json ? JSON.parse(row.receipt_json) : null,
      reconciliation: row.reconciliation_json ? JSON.parse(row.reconciliation_json) : null,
    };
  }
  function current(runId: string, expectedDigest: string) {
    const run = get(runId);
    if (run.digest !== expectedDigest)
      configurationError('Deployment approval digest differs', 'DEPLOYMENT_PLAN_CHANGED', 409);
    if (new Date(run.plan.expiresAt) <= now())
      configurationError('Deployment approval expired', 'DEPLOYMENT_APPROVAL_EXPIRED', 409);
    return run;
  }
  return {
    get,
    listForOwner(ownerId: string): DeploymentRun[] {
      return (
        db
          .prepare(
            'SELECT id FROM deployment_runs WHERE owner_id=? ORDER BY created_at DESC LIMIT 100',
          )
          .all(ownerId) as { id: string }[]
      ).map((row) => get(row.id));
    },
    unresolved(): DeploymentRun[] {
      return (
        db.prepare("SELECT id FROM deployment_runs WHERE state='uncertain'").all() as {
          id: string;
        }[]
      ).map((row) => get(row.id));
    },
    find(podId: string, operationKey: string) {
      const row = db
        .prepare('SELECT id FROM deployment_runs WHERE pod_id=? AND operation_key=?')
        .get(podId, operationKey) as { id: string } | undefined;
      return row ? get(row.id) : null;
    },
    deny(runId: string, expectedDigest: string, actorId: string) {
      // Expiry revokes permission to execute; it must not prevent the owner from closing the request.
      const run = get(runId);
      if (run.digest !== expectedDigest)
        configurationError('Deployment approval digest differs', 'DEPLOYMENT_PLAN_CHANGED', 409);
      if (run.plan.ownerId !== actorId)
        configurationError(
          'Only the requesting operator may deny this deployment',
          'DEPLOYMENT_APPROVAL_DENIED',
          403,
        );
      if (
        db
          .prepare(
            "UPDATE deployment_runs SET state='denied',updated_at=? WHERE id=? AND state IN ('awaiting_approval','approved')",
          )
          .run(now().toISOString(), runId).changes !== 1
      )
        configurationError(
          'Deployment is no longer awaiting approval',
          'DEPLOYMENT_STATE_CONFLICT',
          409,
        );
      return get(runId);
    },
    reserve(raw: unknown): DeploymentRun {
      const plan = deploymentPlanSchema.parse(raw);
      const hash = configurationDigest(plan);
      return db.transaction(() => {
        const prior = db
          .prepare('SELECT id FROM deployment_runs WHERE pod_id=? AND operation_key=?')
          .get(plan.podId, plan.operationKey) as { id: string } | undefined;
        if (prior) {
          const run = get(prior.id);
          if (run.digest !== hash)
            configurationError(
              'Deployment operation key was reused with different approval material',
              'DEPLOYMENT_REQUEST_CONFLICT',
              409,
            );
          return run;
        }
        if (new Date(plan.expiresAt) <= now())
          configurationError('Deployment request expired', 'DEPLOYMENT_APPROVAL_EXPIRED', 409);
        const runId = randomUUID();
        const time = now().toISOString();
        db.prepare(
          `INSERT INTO deployment_runs(id,pod_id,operation_key,owner_id,target_id,plan_digest,plan_json,state,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'awaiting_approval',?,?,?)`,
        ).run(
          runId,
          plan.podId,
          plan.operationKey,
          plan.ownerId,
          plan.targetId,
          hash,
          JSON.stringify(plan),
          plan.expiresAt,
          time,
          time,
        );
        return get(runId);
      })();
    },
    approve(runId: string, expectedDigest: string, actorId: string): DeploymentRun {
      return db.transaction(() => {
        const run = current(runId, expectedDigest);
        if (run.plan.ownerId !== actorId)
          configurationError(
            'Only the requesting operator may approve this deployment',
            'DEPLOYMENT_APPROVAL_DENIED',
            403,
          );
        if (run.state !== 'awaiting_approval' && run.state !== 'approved')
          configurationError(
            'Deployment is no longer awaiting approval',
            'DEPLOYMENT_STATE_CONFLICT',
            409,
          );
        db.prepare(
          "UPDATE deployment_runs SET state='approved',approved_by=?,updated_at=? WHERE id=? AND state='awaiting_approval'",
        ).run(actorId, now().toISOString(), runId);
        return get(runId);
      })();
    },
    claim(runId: string, expectedDigest: string, assertCurrent: () => void): boolean {
      return db.transaction(() => {
        const run = current(runId, expectedDigest);
        assertCurrent();
        if (run.state !== 'approved' || run.approvedBy !== run.plan.ownerId) return false;
        const active = db
          .prepare(
            "SELECT id FROM deployment_runs WHERE target_id=? AND state IN ('running','uncertain')",
          )
          .get(run.plan.targetId);
        if (active)
          configurationError(
            'This target has an active or uncertain deployment; reconcile it before another attempt',
            'DEPLOYMENT_TARGET_UNRESOLVED',
            409,
          );
        return (
          db
            .prepare(
              "UPDATE deployment_runs SET state='running',updated_at=? WHERE id=? AND state='approved'",
            )
            .run(now().toISOString(), runId).changes === 1
        );
      })();
    },
    recordContainer(runId: string, containerId: string) {
      z.string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(containerId);
      if (
        db
          .prepare(
            "UPDATE deployment_runs SET container_id=?,updated_at=? WHERE id=? AND state='running' AND container_id IS NULL",
          )
          .run(containerId, now().toISOString(), runId).changes !== 1
      )
        configurationError(
          'Deployment container ownership changed',
          'DEPLOYMENT_STATE_CONFLICT',
          409,
        );
    },
    recordExec(runId: string, identity: NativeGoalProcessIdentity) {
      const parsed = z
        .object({
          backend: z.literal('docker'),
          containerId: z.string().regex(/^[a-f0-9]{64}$/),
          execId: z.string().regex(/^[a-f0-9]{64}$/),
          pidPath: z.string().regex(/^\/tmp\/\.autopod-stream-exec-[a-zA-Z0-9-]+\.pid$/),
        })
        .strict()
        .parse(identity);
      if (
        db
          .prepare(
            "UPDATE deployment_runs SET exec_json=?,updated_at=? WHERE id=? AND state='running' AND container_id=? AND exec_json IS NULL",
          )
          .run(JSON.stringify(parsed), now().toISOString(), runId, parsed.containerId).changes !== 1
      )
        configurationError('Deployment exec ownership changed', 'DEPLOYMENT_STATE_CONFLICT', 409);
    },
    finish(
      runId: string,
      receipt: { exitCode: number; containerRemoved: true; outputBytes: number },
    ) {
      z.object({
        exitCode: z.number().int(),
        containerRemoved: z.literal(true),
        outputBytes: z.number().nonnegative(),
      })
        .strict()
        .parse(receipt);
      if (
        db
          .prepare(
            "UPDATE deployment_runs SET state=?,receipt_json=?,updated_at=? WHERE id=? AND state='running' AND container_id IS NOT NULL AND exec_json IS NOT NULL",
          )
          .run(
            receipt.exitCode === 0 ? 'completed' : 'failed',
            JSON.stringify(receipt),
            now().toISOString(),
            runId,
          ).changes !== 1
      )
        configurationError(
          'Deployment cannot be settled without its execution identity',
          'DEPLOYMENT_STATE_CONFLICT',
          409,
        );
      return get(runId);
    },
    markUncertain(runId: string) {
      db.prepare(
        "UPDATE deployment_runs SET state='uncertain',updated_at=? WHERE id=? AND state='running'",
      ).run(now().toISOString(), runId);
      return get(runId);
    },
    reconcile(
      runId: string,
      digest: string,
      actorId: string,
      externalOutcome: 'deployed' | 'not-deployed',
      note: string,
    ) {
      const run = get(runId);
      if (run.digest !== digest || run.plan.ownerId !== actorId || run.state !== 'uncertain')
        configurationError(
          'Only the owning operator can reconcile an uncertain deployment',
          'DEPLOYMENT_RECONCILIATION_DENIED',
          409,
        );
      const reconciliation = {
        actorId,
        externalOutcome: z.enum(['deployed', 'not-deployed']).parse(externalOutcome),
        note: z.string().trim().min(1).max(2000).parse(note),
        at: now().toISOString(),
      };
      if (
        db
          .prepare(
            "UPDATE deployment_runs SET state='reconciled',reconciliation_json=?,updated_at=? WHERE id=? AND state='uncertain'",
          )
          .run(JSON.stringify(reconciliation), reconciliation.at, runId).changes !== 1
      )
        configurationError(
          'Deployment changed during reconciliation',
          'DEPLOYMENT_STATE_CONFLICT',
          409,
        );
      return get(runId);
    },
    recoverInterrupted() {
      return db
        .prepare("UPDATE deployment_runs SET state='uncertain',updated_at=? WHERE state='running'")
        .run(now().toISOString()).changes;
    },
  };
}
