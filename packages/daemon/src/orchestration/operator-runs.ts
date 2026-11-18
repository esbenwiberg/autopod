import type { ManagedPodRequest } from '@autopod/shared';
import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthModule } from '../interfaces/auth-module.js';
import { digest } from '../managed/canonical.js';
import { type ManagedUserBinding, managedUserAuthenticator } from '../managed/user-auth.js';
import type { ProfileLlmClient } from '../providers/llm-client.js';
import type { ContinuationCheckpoint } from './continuations.js';
import type { ControllerConfig } from './controller-turns.js';
import type { LocalCheckpointHost } from './local-checkpoints.js';
import { tryOperatorDaemonOwner } from './local-recovery-claim.js';

// One configured slot is one run lifetime. No caller-supplied grant, source, profile,
// mission, run owner or budget. Rebinding the operator creates a DIFFERENT run ID.
export function operatorRunId(binding: ManagedUserBinding, slot: string) {
  return digest(['operator-run/v1', binding, slot]).slice(7);
}
export interface OperatorRunSlot {
  slot: string;
  operator: ManagedUserBinding;
  checkpoint: ContinuationCheckpoint;
  catalog: Readonly<Record<string, ManagedPodRequest>>;
  policy: ControllerConfig;
  provider: ProfileLlmClient;
}
export interface OperatorRunsConfig {
  /** Called with exclusive operator ownership, before any scheduler is attached. */
  lifetimeOwner?: { owns: (db: Database.Database) => boolean };
  prepare?: () => Promise<void>;
  cleanup?: (run: string) => Promise<{ run: string; cleaned: number }>;
  host: LocalCheckpointHost;
  db: Database.Database;
  slots: readonly OperatorRunSlot[];
}
const approvedAlias = /^[a-z][a-z0-9-]{0,63}$/;
const fence = z
  .object({
    kind: z.enum(['controller', 'allocation']),
    key: z.string().min(1).max(200),
    binding: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    caseRef: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  })
  .strict();
export function registerOperatorRuns(
  app: FastifyInstance,
  config: OperatorRunsConfig,
  auth: AuthModule,
) {
  const { host, db } = config;
  if (!host.usesDatabase(db) || !config.slots.length || config.slots.length > 32)
    throw new Error('invalid-operator-run-config');
  const slots = new Map<string, OperatorRunSlot>();
  const bindings = new Map<string, ManagedUserBinding>();
  for (const input of config.slots) {
    const { provider, ...data } = input;
    const s = { ...structuredClone(data), provider };
    const run = operatorRunId(s.operator, s.slot);
    if (!approvedAlias.test(s.slot) || s.checkpoint.run !== run || slots.has(run))
      throw new Error('invalid-operator-slot');
    // The authentication adapter returns an opaque actor, rather than the shared installation.
    const actor = digest(['operator/v1', s.operator]).slice(7);
    bindings.set(actor, { ...s.operator, installationId: actor });
    slots.set(run, s);
  }
  const authorize = managedUserAuthenticator(auth, [...bindings.values()]);
  const byActor = new Map(
    [...slots.values()].map((s) => [
      digest(['operator/v1', s.operator]).slice(7) + ':' + s.slot,
      s,
    ]),
  );
  const loops = new Map<string, ReturnType<LocalCheckpointHost['watchController']>>();
  const pending = new Map<string, Promise<void>>();
  let closed = false;
  const canceled = (run: string) =>
    db.prepare('SELECT canceled FROM orchestration_runs WHERE id=?').pluck().get(run);
  async function start(slot: OperatorRunSlot) {
    const run = slot.checkpoint.run;
    if (closed || canceled(run) !== 0) throw new Error('operator-run-inactive');
    if (loops.has(run)) return;
    const prior = pending.get(run);
    if (prior) return prior;
    const task = (async () => {
      await host.ledger.kickoff(slot.checkpoint, slot.catalog);
      if (closed || canceled(run) !== 0) throw new Error('operator-run-inactive');
      loops.set(run, host.watchController(run, slot.policy, slot.provider));
    })();
    pending.set(run, task);
    try {
      await task;
    } finally {
      pending.delete(run);
    }
  }
  const kicked = (run: string) =>
    !!db.prepare('SELECT 1 FROM orchestration_kickoffs WHERE run_id=?').get(run);
  let releaseOwner: (() => void) | undefined;
  const drain = async () => {
    closed = true;
    await Promise.allSettled(pending.values());
    await Promise.all([...loops.values()].map((l) => l.close()));
    releaseOwner?.();
    releaseOwner = undefined;
  };
  app.addHook('onReady', async () => {
    if (config.lifetimeOwner) {
      if (!config.lifetimeOwner.owns(db)) throw new Error('operator-daemon-owner-invalid');
    } else {
      releaseOwner = tryOperatorDaemonOwner(db) ?? undefined;
      if (!releaseOwner) throw new Error('operator-daemon-owner-active');
    }
    try {
      await config.prepare?.();
      // Check every enrollment before waking any run. A boot with a stale catalog
      // must not charge a different slot and then fail halfway through startup.
      const active = [...slots].filter(([run]) => kicked(run) && canceled(run) === 0);
      for (const [, slot] of active) await host.ledger.kickoff(slot.checkpoint, slot.catalog);
      for (const [run, slot] of active)
        loops.set(run, host.watchController(run, slot.policy, slot.provider));
    } catch (error) {
      await drain();
      throw error;
    }
  });
  app.addHook('onClose', drain);
  for (const op of ['status', 'start', 'cancel', 'fence', 'cleanup'] as const) {
    app.route({
      method: op === 'status' ? 'GET' : 'POST',
      url: `/orchestration/runs/:slot/${op}`,
      bodyLimit: 2048,
      handler: async (req: FastifyRequest, reply) => {
        const actor = await authorize(req);
        if (!actor) return reply.code(401).send({ code: 'operator-auth-required' });
        const slot = byActor.get(actor + ':' + (req.params as { slot: string }).slot);
        if (!slot) return reply.code(404).send({ code: 'operator-run-not-found' });
        const run = slot.checkpoint.run;
        if (
          op !== 'fence' &&
          req.body !== undefined &&
          !z.object({}).strict().safeParse(req.body).success
        )
          return reply.code(400).send({ code: 'operator-body-invalid' });
        try {
          if (op === 'start') {
            await start(slot);
            return reply.code(202).send({ run });
          }
          if (op === 'cancel') {
            host.ledger.cancel(run);
            return reply.code(202).send({ run, stopRequested: true });
          }
          if (op === 'cleanup') {
            if (!config.cleanup) throw new Error('cleanup-unavailable');
            return await config.cleanup(run);
          }
          if (op === 'fence') {
            const v = fence.safeParse(req.body);
            if (!v.success) return reply.code(400).send({ code: 'operator-body-invalid' });
            const { caseRef, ...target } = v.data;
            return host.interventions.fence({ ...target, run_id: run }, actor, caseRef);
          }
          return db.transaction(() => ({
            run,
            canceled: canceled(run) === 1,
            started: kicked(run),
            controller: loops.get(run)?.status() ?? { planning: 'detached' },
            remainingRequests: db
              .prepare('SELECT remaining FROM orchestration_request_balances WHERE id=?')
              .pluck()
              .get(run),
            acceptedCommit: db
              .prepare('SELECT accepted_commit FROM orchestration_runs WHERE id=?')
              .pluck()
              .get(run),
            children: db
              .prepare(
                `SELECT c.start_key AS child,p.pod_id AS pod,p.state,p.observed_exit AS observedExit,p.cleanup FROM orchestration_continuations c LEFT JOIN managed_pods p ON p.dispatcher_installation_id=('native.'||c.run_id) AND p.managed_start_key=c.start_key WHERE c.run_id=? ORDER BY c.rowid`,
              )
              .all(run),
            ...host.interventions.inspect(run),
          }))();
        } catch {
          return reply.code(409).send({ code: 'operator-run-refused' });
        }
      },
    });
  }
  return { settled: (run: string) => loops.get(run)?.settled() };
}
