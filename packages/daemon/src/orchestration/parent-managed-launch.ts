import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { ScopedPodTools } from '@autopod/escalation-mcp';
import {
  AutopodError,
  type EffectiveLaunchConfig,
  type JwtPayload,
  type Pod,
} from '@autopod/shared';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PodTokenIssuer } from '../crypto/pod-tokens.js';
import type { AuthModule } from '../interfaces/auth-module.js';
import { canonical, digest } from '../managed/canonical.js';
import { managedUserAuthenticator } from '../managed/user-auth.js';
import { projectManagedRecipe } from './controller-turns.js';
import type { OperatorRunSlot, OperatorRunsConfig } from './operator-runs.js';
import { ParentReportResults } from './parent-report-results.js';

export const parentLaunchPolicySchema = z
  .object({
    requestId: z.string().uuid(),
    launchDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const requestSchema = z
  .object({
    requestKey: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    recipe: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    brief: z.string().trim().min(1).max(2048),
  })
  .strict();
interface Binding {
  run_id: string;
  pod_id: string;
  launch_digest: string;
  policy_digest: string;
  policy_json: string;
  current_attempt: string | null;
}

/** Trusted daemon composition. No user-token or pod-ID input can establish runtime authority. */
export class ParentManagedLaunch {
  private readonly scope = new AsyncLocalStorage<{ podId: string; attempt: string } | undefined>();
  private readonly slots: OperatorRunSlot[];
  private readonly reports: ParentReportResults;
  constructor(
    private readonly config: OperatorRunsConfig,
    private readonly issuer: PodTokenIssuer,
    private readonly pod: (id: string) => Pod,
  ) {
    if (!config.host.usesDatabase(config.db)) throw new Error('parent-owner-database-mismatch');
    this.reports = new ParentReportResults(config.db);
    this.slots = config.slots
      .filter((s) => s.parent)
      .map((s) => ({
        ...s,
        parent: structuredClone(s.parent),
        checkpoint: structuredClone(s.checkpoint),
        catalog: structuredClone(s.catalog),
        policy: structuredClone(s.policy),
        operator: structuredClone(s.operator),
      }));
    for (const slot of this.slots) {
      const existing = this.db
        .prepare('SELECT pod_id FROM pod_launch_snapshots WHERE request_id=?')
        .get(slot.parent!.requestId) as { pod_id: string } | undefined;
      if (existing) {
        const binding = this.binding(existing.pod_id);
        if (!binding) throw new Error('parent-launch-must-be-future');
        if (this.slot(binding) !== slot) throw new Error('parent-policy-unavailable');
      }
    }
  }
  private get db(): Database.Database {
    return this.config.db;
  }
  private binding(podId: string) {
    return this.db.prepare('SELECT * FROM parent_managed_runs WHERE pod_id=?').get(podId) as
      | Binding
      | undefined;
  }
  private policy(slot: OperatorRunSlot) {
    return canonical({
      parent: slot.parent,
      checkpoint: slot.checkpoint,
      catalog: slot.catalog,
      operator: slot.operator,
      limits: slot.policy.limits,
    });
  }
  private slot(binding: Binding) {
    const slot = this.slots.find((s) => s.checkpoint.run === binding.run_id);
    if (
      !slot ||
      binding.launch_digest !== slot.parent?.launchDigest ||
      binding.policy_json !== this.policy(slot) ||
      binding.policy_digest !== digest(this.policy(slot))
    )
      throw new Error('parent-policy-unavailable');
    return slot;
  }
  /** Only the authenticated ordinary-launch route may reserve this parent identity. */
  authorizeLaunch(
    requestId: string | undefined,
    principal: Pick<JwtPayload, 'oid' | 'iss' | 'aud'> | undefined,
  ) {
    const candidates = this.slots.filter((s) => s.parent?.requestId === requestId);
    if (!candidates.length) return undefined;
    const slot = candidates[0]!;
    if (
      candidates.length !== 1 ||
      principal?.oid !== slot.operator.objectId ||
      principal.iss !== slot.operator.issuer ||
      principal.aud !== slot.operator.audience
    )
      throw new AutopodError('Enrolled parent operator required', 'PARENT_OPERATOR_REQUIRED', 403);
    return (podId: string, frozen: EffectiveLaunchConfig) => {
      if (
        frozen.digest !== slot.parent?.launchDigest ||
        frozen.intent !== 'task' ||
        !frozen.execution.networkPolicy?.enabled ||
        frozen.execution.networkPolicy.mode === 'allow-all' ||
        frozen.workflow.completion !== 'approval' ||
        frozen.pim.length ||
        frozen.githubAccess.some((access) =>
          access.rule.operations.some((op) => !op.endsWith('.read')),
        ) ||
        frozen.repository?.setup.integrations.deployment?.enabled ||
        !slot.policy.limits ||
        !this.issuer.generateAttempt ||
        !this.issuer.verifyAttempt ||
        this.pod(podId).userId !== principal.oid ||
        !this.db.inTransaction
      )
        throw new AutopodError('Frozen parent launch refused', 'PARENT_LAUNCH_REFUSED', 409);
      const policy = this.policy(slot);
      // Same transaction as ordinary pod and snapshot insertion. No provider work here.
      this.db
        .prepare(
          'INSERT INTO parent_managed_runs(run_id,pod_id,launch_digest,policy_digest,policy_json) VALUES(?,?,?,?,?)',
        )
        .run(slot.checkpoint.run, podId, frozen.digest, digest(policy), policy);
    };
  }
  /** Called only by real agent provisioning, before delivering the runtime MCP configuration. */
  async provision(podId: string): Promise<string | undefined> {
    const binding = this.binding(podId);
    if (!binding) return undefined;
    const slot = this.slot(binding);
    const pod = this.pod(podId);
    if (
      pod.userId !== slot.operator.objectId ||
      pod.launchConfigDigest !== binding.launch_digest ||
      !pod.containerId ||
      pod.status !== 'running' ||
      !this.issuer.generateAttempt ||
      !this.issuer.verifyAttempt
    )
      throw new Error('parent-launch-binding-refused');
    const attempt = randomUUID();
    this.db
      .transaction(() => {
        this.db
          .prepare(
            'INSERT INTO parent_managed_sessions(attempt,run_id,generation,container_id) VALUES(?,?,?,?)',
          )
          .run(attempt, slot.checkpoint.run, pod.lifecycleGeneration, pod.containerId);
        this.db
          .prepare('UPDATE parent_managed_runs SET current_attempt=? WHERE pod_id=?')
          .run(attempt, podId);
      })
      .immediate();
    await this.config.host.ledger.kickoff(slot.checkpoint, slot.catalog);
    return this.issuer.generateAttempt(podId, attempt);
  }
  async withIngress(podId: string, token: string | undefined, run: () => Promise<void>) {
    const session = token && this.issuer.verifyAttempt?.(token);
    // Ordinary pods retain their existing ingress. Parent actions themselves require this scope.
    return this.scope.run(session && session.podId === podId ? session : undefined, run);
  }
  private active(podId: string) {
    const session = this.scope.getStore();
    const binding = this.binding(podId);
    if (
      !session ||
      session.podId !== podId ||
      !binding ||
      session.attempt !== binding.current_attempt
    )
      throw new Error('parent-session-required');
    const pod = this.pod(podId);
    const slot = this.slot(binding);
    const run = this.db
      .prepare(
        'SELECT 1 FROM orchestration_runs WHERE id=? AND canceled=0 AND policy_digest=? AND repository=?',
      )
      .get(binding.run_id, slot.checkpoint.policyDigest, slot.checkpoint.repository);
    const current = this.db
      .prepare(
        'SELECT 1 FROM parent_managed_sessions WHERE attempt=? AND run_id=? AND generation=? AND container_id=?',
      )
      .get(session.attempt, binding.run_id, pod.lifecycleGeneration, pod.containerId ?? null);
    if (
      !current ||
      !run ||
      pod.status !== 'running' ||
      pod.launchConfigDigest !== slot.parent?.launchDigest
    )
      throw new Error('parent-session-stale');
    return { binding, slot };
  }
  tools(podId: string): ScopedPodTools | undefined {
    if (!this.binding(podId)) return undefined;
    const authenticate = () => this.active(podId).binding.run_id;
    const tools: ScopedPodTools = {
      managedChildRequest: async (raw) => {
        const input = requestSchema.parse(raw);
        const { binding, slot } = this.active(podId);
        if (!Object.hasOwn(slot.catalog, input.recipe)) throw new Error('parent-recipe-refused');
        const key = `parent-${digest([binding.run_id, input.requestKey]).slice(7)}`;
        const request = projectManagedRecipe(slot.catalog[input.recipe]!, input.brief, key);
        await this.config.host.ledger.spawnWave(slot.checkpoint, [request], () => {
          this.active(podId);
          const prior = this.db
            .prepare(
              'SELECT input_digest FROM parent_managed_requests WHERE run_id=? AND start_key=?',
            )
            .get(binding.run_id, key) as { input_digest: string } | undefined;
          if (prior) {
            if (prior.input_digest !== digest(input)) throw new Error('parent-request-conflict');
            return;
          }
          const count = Number(
            this.db
              .prepare('SELECT count(*) FROM orchestration_continuations WHERE run_id=?')
              .pluck()
              .get(binding.run_id),
          );
          const active = Number(
            this.db
              .prepare(
                `SELECT count(*) FROM orchestration_continuations c LEFT JOIN managed_pods p ON p.dispatcher_installation_id='native.'||c.run_id AND p.managed_start_key=c.start_key WHERE c.run_id=? AND coalesce(p.observed_exit,0)=0`,
              )
              .pluck()
              .get(binding.run_id),
          );
          const capacity = Number(
            this.db
              .prepare('SELECT max_active FROM orchestration_runs WHERE id=?')
              .pluck()
              .get(binding.run_id),
          );
          if (count >= slot.policy.limits!.workers || active >= capacity)
            throw new Error('parent-capacity-exhausted');
          this.db
            .prepare(
              'INSERT INTO parent_managed_requests(run_id,start_key,request_key,parent_attempt,input_digest) VALUES(?,?,?,?,?)',
            )
            .run(
              binding.run_id,
              key,
              input.requestKey,
              this.scope.getStore()!.attempt,
              digest(input),
            );
        });
        await this.config.host.ledger.recover(binding.run_id);
        return this.family(podId);
      },
      managedFamily: async () => {
        this.active(podId);
        return this.family(podId);
      },
      managedResults: async (input) => this.reports.results(input, authenticate),
      managedWait: async (input) => this.reports.wait(input, authenticate),
    };
    return tools;
  }
  registerFamily(app: FastifyInstance, auth: AuthModule) {
    const authorize = managedUserAuthenticator(
      auth,
      this.slots.map((s) => ({
        ...s.operator,
        installationId: s.checkpoint.run,
      })),
    );
    app.get('/orchestration/parents/:podId/family', async (req, reply) => {
      const actor = await authorize(req);
      if (!actor) return reply.code(401).send({ code: 'parent-owner-required' });
      const { podId } = req.params as { podId: string };
      const binding = this.binding(podId);
      if (!binding || binding.run_id !== actor)
        return reply.code(404).send({ code: 'parent-family-not-found' });
      return this.family(podId);
    });
  }
  /** Caller must independently authorize the selected parent; returns no request, grants or credentials. */
  family(podId: string) {
    const binding = this.binding(podId);
    if (!binding) throw new Error('parent-family-not-found');
    return {
      parent: podId,
      run: binding.run_id,
      children: this.db
        .prepare(`
      SELECT q.request_key AS requestKey,q.parent_attempt AS parentAttempt,coalesce(c.pod_id,p.pod_id) AS child,
      CASE WHEN p.pod_id IS NULL AND c.pod_id IS NOT NULL THEN 'unknown'
        WHEN p.observed_exit=1 THEN 'exited'
        WHEN p.state='running' AND coalesce(p.last_runtime_observation,'running')<>'unknown' THEN 'started'
        WHEN p.allocation_attempted=1 THEN 'unknown' ELSE 'reserved' END AS status
      FROM orchestration_continuations c JOIN parent_managed_requests q ON q.run_id=c.run_id AND q.start_key=c.start_key LEFT JOIN managed_pods p
        ON p.dispatcher_installation_id='native.'||c.run_id AND p.managed_start_key=c.start_key
        AND p.execution_spec_digest=json_extract(c.request_json,'$.executionSpecDigest')
        AND p.dispatcher_attempt_id=c.attempt_id
        AND (c.pod_id IS NULL OR c.pod_id=p.pod_id)
      WHERE c.run_id=? ORDER BY c.rowid`)
        .all(binding.run_id),
    };
  }
}
