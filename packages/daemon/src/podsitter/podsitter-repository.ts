import {
  type OperatorActor,
  type PodsitterAction,
  type PodsitterAttention,
  type PodsitterAttentionState,
  type PodsitterConfiguration,
  type PodsitterDecision,
  type PodsitterDecisionOutcome,
  type PodsitterDecisionRecord,
  type PodsitterDecisionTarget,
  type PodsitterProviderCircuitStatus,
  type PodsitterProviderState,
  type SystemSandboxRunOutcome,
  operatorActorSchema,
  podsitterActionArgumentsSchemas,
  podsitterConfigurationInputSchema,
  podsitterDecisionSchema,
} from '@autopod/shared';
import type Database from 'better-sqlite3';
import { validatePodsitterActivation } from './activation.js';

const DEFAULT_BUDGETS = { maxDecisionsPerWindow: 20, maxActionsPerWindow: 10 };
const SENSITIVE_KEY = /(credential|password|secret|token|api.?key|authorization)/i;
const MAX_PERSISTED_PAYLOAD_BYTES = 32_000;

export interface PodsitterConfigurationInput {
  enabled: boolean;
  activation: PodsitterConfiguration['activation'];
  authorizedUntil: string | null;
  profileScope: string[] | null;
  decisionTarget: PodsitterDecisionTarget | null;
  budgets?: PodsitterConfiguration['budgets'];
  updatedBy: OperatorActor;
}

export interface PodsitterRepository {
  getConfiguration(): PodsitterConfiguration | null;
  replaceConfiguration(input: PodsitterConfigurationInput, now?: string): PodsitterConfiguration;
  recordAttention(input: {
    id: string;
    podId: string;
    signature: string;
    failureSignature?: string | null;
    now?: string;
  }): PodsitterAttention;
  listPendingAttention(): PodsitterAttention[];
  acquireAttentionLease(
    id: string,
    owner: string,
    expiresAt: string,
    now?: string,
  ): PodsitterAttention | null;
  releaseAttentionLease(
    id: string,
    owner: string,
    state?: PodsitterAttentionState,
    decisionId?: string | null,
    now?: string,
  ): boolean;
  getProviderState(providerAccountId: string): PodsitterProviderState | null;
  setProviderState(
    providerAccountId: string,
    update: {
      status: PodsitterProviderCircuitStatus;
      consecutiveFailures: number;
      retryAt?: string | null;
      resetAt?: string | null;
      sanitizedReason?: string | null;
      recoveredAt?: string | null;
    },
    now?: string,
  ): PodsitterProviderState;
  acquireProviderProbeLease(
    providerAccountId: string,
    owner: string,
    expiresAt: string,
    now?: string,
  ): boolean;
  releaseProviderProbeLease(providerAccountId: string, owner: string, now?: string): boolean;
  reserveAction(input: {
    id: string;
    idempotencyKey: string;
    podId: string;
    decisionId: string;
    failureSignature?: string | null;
    actor: OperatorActor;
    action: PodsitterAction;
    arguments: Record<string, unknown>;
    policyResult: string;
    now?: string;
  }): boolean;
  completeAction(idempotencyKey: string, daemonResult: string, now?: string): boolean;
  getDecisionForAttention(attentionId: string): PodsitterDecisionRecord | null;
  createDecision(input: {
    id: string;
    attentionId: string;
    leaseOwner: string;
    podId: string;
    attentionSignature: string;
    configurationGeneration: number;
    evidenceHash: string;
    evidenceVersion: number;
    target: PodsitterDecisionTarget;
    now?: string;
  }): PodsitterDecisionRecord;
  completeDecision(
    id: string,
    update: {
      decision?: PodsitterDecision | null;
      outcome: PodsitterDecisionOutcome;
      failureCode?: string | null;
      inputTokens?: number | null;
      outputTokens?: number | null;
      costUsd?: number | null;
      executedAt?: string | null;
    },
    now?: string,
  ): PodsitterDecisionRecord;
  createSandboxRun(input: {
    id: string;
    decisionId?: string | null;
    backend: string;
    containerId?: string | null;
    now?: string;
  }): void;
  closeSandboxRun(
    id: string,
    update: {
      outcome: SystemSandboxRunOutcome;
      cleanupState: string;
      failureCode?: string | null;
    },
    now?: string,
  ): boolean;
}

function json<T>(value: T): string {
  return JSON.stringify(value);
}

function parse<T>(value: unknown): T {
  return JSON.parse(value as string) as T;
}

function normalizeIso(value: string, field: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error(`${field} must be an ISO timestamp`);
  return new Date(milliseconds).toISOString();
}

function normalizeFutureLease(expiresAt: string, now: string): string {
  const normalizedExpiresAt = normalizeIso(expiresAt, 'expiresAt');
  if (normalizedExpiresAt <= now) {
    throw new Error('expiresAt must be later than now');
  }
  return normalizedExpiresAt;
}

function assertRedacted(value: unknown, key = 'arguments'): void {
  if (Array.isArray(value)) {
    for (const item of value) assertRedacted(item, key);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [childKey, childValue] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(childKey) && childValue !== null && childValue !== '[redacted]') {
        throw new Error(`Podsitter action arguments contain sensitive field "${childKey}"`);
      }
      assertRedacted(childValue, childKey);
    }
  } else if (typeof value === 'string' && value.length > 4_000) {
    throw new Error(`Podsitter ${key} exceeds the bounded field limit`);
  }
}

function assertBoundedRedactedPayload(value: unknown, field: string): void {
  assertRedacted(value, field);
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_PERSISTED_PAYLOAD_BYTES) {
    throw new Error(`Podsitter ${field} exceeds the bounded payload limit`);
  }
}

function hydrateConfiguration(row: Record<string, unknown>): PodsitterConfiguration {
  const decisionTarget =
    row.provider_account_id === null
      ? null
      : {
          providerAccountId: row.provider_account_id as string,
          runtime: row.runtime as PodsitterDecisionTarget['runtime'],
          model: row.model as string,
          ...(row.reasoning_effort
            ? {
                reasoningEffort: row.reasoning_effort as PodsitterDecisionTarget['reasoningEffort'],
              }
            : {}),
        };
  return {
    enabled: row.enabled === 1,
    activation: parse(row.activation),
    authorizedUntil: row.authorized_until as string | null,
    generation: row.generation as number,
    profileScope: row.profile_scope === null ? null : parse(row.profile_scope),
    decisionTarget,
    budgets: parse(row.budgets),
    updatedBy: parse(row.updated_by),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function hydrateAttention(row: Record<string, unknown>): PodsitterAttention {
  return {
    id: row.id as string,
    podId: row.pod_id as string,
    signature: row.signature as string,
    state: row.state as PodsitterAttentionState,
    failureSignature: row.failure_signature as string | null,
    decisionId: row.decision_id as string | null,
    leaseOwner: row.lease_owner as string | null,
    leaseExpiresAt: row.lease_expires_at as string | null,
    firstSeenAt: row.first_seen_at as string,
    lastSeenAt: row.last_seen_at as string,
    supersededAt: row.superseded_at as string | null,
  };
}

function hydrateProviderState(row: Record<string, unknown>): PodsitterProviderState {
  return {
    providerAccountId: row.provider_account_id as string,
    status: row.status as PodsitterProviderCircuitStatus,
    consecutiveFailures: row.consecutive_failures as number,
    retryAt: row.retry_at as string | null,
    resetAt: row.reset_at as string | null,
    sanitizedReason: row.sanitized_reason as string | null,
    probeLeaseOwner: row.probe_lease_owner as string | null,
    probeLeaseExpiresAt: row.probe_lease_expires_at as string | null,
    recoveredAt: row.recovered_at as string | null,
    updatedAt: row.updated_at as string,
  };
}

function hydrateDecision(row: Record<string, unknown>): PodsitterDecisionRecord {
  return {
    id: row.id as string,
    attentionId: row.attention_id as string,
    podId: row.pod_id as string,
    attentionSignature: row.attention_signature as string,
    configurationGeneration: row.configuration_generation as number,
    evidenceHash: row.evidence_hash as string,
    evidenceVersion: row.evidence_version as number,
    target: {
      providerAccountId: row.provider_account_id as string,
      runtime: row.runtime as PodsitterDecisionTarget['runtime'],
      model: row.model as string,
      ...(row.reasoning_effort
        ? { reasoningEffort: row.reasoning_effort as PodsitterDecisionTarget['reasoningEffort'] }
        : {}),
    },
    decision: row.decision === null ? null : parse(row.decision),
    outcome: row.outcome as PodsitterDecisionOutcome,
    failureCode: row.failure_code as string | null,
    inputTokens: row.input_tokens as number | null,
    outputTokens: row.output_tokens as number | null,
    costUsd: row.cost_usd as number | null,
    createdAt: row.created_at as string,
    completedAt: row.completed_at as string | null,
    executedAt: row.executed_at as string | null,
  };
}

export function createPodsitterRepository(db: Database.Database): PodsitterRepository {
  const getAttention = (id: string): PodsitterAttention => {
    const row = db.prepare('SELECT * FROM podsitter_attention WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new Error(`Podsitter attention "${id}" not found`);
    return hydrateAttention(row);
  };
  const getDecision = (id: string): PodsitterDecisionRecord => {
    const row = db.prepare('SELECT * FROM podsitter_decisions WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new Error(`Podsitter decision "${id}" not found`);
    return hydrateDecision(row);
  };

  const replaceConfiguration = db.transaction(
    (input: PodsitterConfigurationInput, now: string): PodsitterConfiguration => {
      const normalized = podsitterConfigurationInputSchema.parse({
        ...input,
        budgets: input.budgets ?? DEFAULT_BUDGETS,
      });
      const authorizedUntil =
        normalized.authorizedUntil === null
          ? null
          : normalizeIso(normalized.authorizedUntil, 'authorizedUntil');
      validatePodsitterActivation(normalized.activation);
      const current = db
        .prepare('SELECT generation, created_at FROM podsitter_config WHERE singleton_id = 1')
        .get() as { generation: number; created_at: string } | undefined;
      const generation = (current?.generation ?? 0) + 1;
      db.prepare(
        `INSERT INTO podsitter_config (
          singleton_id, enabled, activation, authorized_until, profile_scope,
          provider_account_id, runtime, model, reasoning_effort, generation,
          budgets, updated_by, created_at, updated_at
        ) VALUES (
          1, @enabled, @activation, @authorizedUntil, @profileScope,
          @providerAccountId, @runtime, @model, @reasoningEffort, @generation,
          @budgets, @updatedBy, @createdAt, @updatedAt
        )
        ON CONFLICT(singleton_id) DO UPDATE SET
          enabled = excluded.enabled,
          activation = excluded.activation,
          authorized_until = excluded.authorized_until,
          profile_scope = excluded.profile_scope,
          provider_account_id = excluded.provider_account_id,
          runtime = excluded.runtime,
          model = excluded.model,
          reasoning_effort = excluded.reasoning_effort,
          generation = excluded.generation,
          budgets = excluded.budgets,
          updated_by = excluded.updated_by,
          updated_at = excluded.updated_at`,
      ).run({
        enabled: normalized.enabled ? 1 : 0,
        activation: json(normalized.activation),
        authorizedUntil,
        profileScope: normalized.profileScope === null ? null : json(normalized.profileScope),
        providerAccountId: normalized.decisionTarget?.providerAccountId ?? null,
        runtime: normalized.decisionTarget?.runtime ?? null,
        model: normalized.decisionTarget?.model ?? null,
        reasoningEffort: normalized.decisionTarget?.reasoningEffort ?? null,
        generation,
        budgets: json(normalized.budgets),
        updatedBy: json(normalized.updatedBy),
        createdAt: current?.created_at ?? now,
        updatedAt: now,
      });
      const row = db
        .prepare('SELECT * FROM podsitter_config WHERE singleton_id = 1')
        .get() as Record<string, unknown>;
      return hydrateConfiguration(row);
    },
  );

  const recordAttention = db.transaction(
    (input: {
      id: string;
      podId: string;
      signature: string;
      failureSignature?: string | null;
      now: string;
    }): PodsitterAttention => {
      const existing = db
        .prepare('SELECT * FROM podsitter_attention WHERE pod_id = ? AND signature = ?')
        .get(input.podId, input.signature) as Record<string, unknown> | undefined;
      if (existing) {
        db.prepare(
          `UPDATE podsitter_attention
           SET last_seen_at = @now
           WHERE pod_id = @podId AND signature = @signature`,
        ).run(input);
        return getAttention(existing.id as string);
      }
      db.prepare(
        `UPDATE podsitter_attention
         SET state = 'superseded', superseded_at = @now,
             lease_owner = NULL, lease_expires_at = NULL, last_seen_at = @now
         WHERE pod_id = @podId
           AND signature <> @signature
           AND state IN ('pending', 'deferred', 'deciding')`,
      ).run(input);
      db.prepare(
        `INSERT INTO podsitter_attention (
          id, pod_id, signature, state, failure_signature, decision_id,
          lease_owner, lease_expires_at, first_seen_at, last_seen_at, superseded_at
        ) VALUES (
          @id, @podId, @signature, 'pending', @failureSignature, NULL,
          NULL, NULL, @now, @now, NULL
        )
        ON CONFLICT(pod_id, signature) DO NOTHING`,
      ).run({ ...input, failureSignature: input.failureSignature ?? null });
      const row = db
        .prepare('SELECT * FROM podsitter_attention WHERE pod_id = ? AND signature = ?')
        .get(input.podId, input.signature) as Record<string, unknown>;
      return hydrateAttention(row);
    },
  );

  return {
    getConfiguration() {
      const row = db.prepare('SELECT * FROM podsitter_config WHERE singleton_id = 1').get() as
        | Record<string, unknown>
        | undefined;
      return row ? hydrateConfiguration(row) : null;
    },
    replaceConfiguration(input, now = new Date().toISOString()) {
      const normalizedNow = normalizeIso(now, 'now');
      return replaceConfiguration(input, normalizedNow);
    },
    recordAttention(input) {
      const now = normalizeIso(input.now ?? new Date().toISOString(), 'now');
      return recordAttention({ ...input, now });
    },
    listPendingAttention() {
      return (
        db
          .prepare(
            "SELECT * FROM podsitter_attention WHERE state IN ('pending', 'deferred', 'deciding') ORDER BY first_seen_at",
          )
          .all() as Record<string, unknown>[]
      ).map(hydrateAttention);
    },
    acquireAttentionLease(id, owner, expiresAt, now = new Date().toISOString()) {
      const normalizedNow = normalizeIso(now, 'now');
      const normalizedExpiresAt = normalizeFutureLease(expiresAt, normalizedNow);
      const acquired = db.transaction(() =>
        db
          .prepare(
            `UPDATE podsitter_attention
             SET lease_owner = ?, lease_expires_at = ?, state = 'deciding'
             WHERE id = ?
               AND state IN ('pending', 'deferred', 'deciding')
               AND (lease_expires_at IS NULL OR lease_expires_at <= ? OR lease_owner = ?)`,
          )
          .run(owner, normalizedExpiresAt, id, normalizedNow, owner),
      )();
      return acquired.changes === 1 ? getAttention(id) : null;
    },
    releaseAttentionLease(
      id,
      owner,
      state = 'pending',
      decisionId = null,
      now = new Date().toISOString(),
    ) {
      const normalizedNow = normalizeIso(now, 'now');
      return (
        db.transaction(() =>
          db
            .prepare(
              `UPDATE podsitter_attention
               SET lease_owner = NULL, lease_expires_at = NULL, state = ?,
                   decision_id = COALESCE(?, decision_id), last_seen_at = ?
               WHERE id = ? AND lease_owner = ? AND lease_expires_at > ?`,
            )
            .run(state, decisionId, normalizedNow, id, owner, normalizedNow),
        )().changes === 1
      );
    },
    getProviderState(providerAccountId) {
      const row = db
        .prepare('SELECT * FROM podsitter_provider_state WHERE provider_account_id = ?')
        .get(providerAccountId) as Record<string, unknown> | undefined;
      return row ? hydrateProviderState(row) : null;
    },
    setProviderState(providerAccountId, update, now = new Date().toISOString()) {
      assertRedacted(update.sanitizedReason, 'sanitizedReason');
      const normalizedNow = normalizeIso(now, 'now');
      const retryAt =
        update.retryAt === undefined || update.retryAt === null
          ? null
          : normalizeIso(update.retryAt, 'retryAt');
      const resetAt =
        update.resetAt === undefined || update.resetAt === null
          ? null
          : normalizeIso(update.resetAt, 'resetAt');
      const recoveredAt =
        update.recoveredAt === undefined || update.recoveredAt === null
          ? null
          : normalizeIso(update.recoveredAt, 'recoveredAt');
      db.transaction(() =>
        db
          .prepare(
            `INSERT INTO podsitter_provider_state (
              provider_account_id, status, consecutive_failures, retry_at, reset_at,
              sanitized_reason, probe_lease_owner, probe_lease_expires_at, recovered_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
            ON CONFLICT(provider_account_id) DO UPDATE SET
              status = excluded.status,
              consecutive_failures = excluded.consecutive_failures,
              retry_at = excluded.retry_at,
              reset_at = excluded.reset_at,
              sanitized_reason = excluded.sanitized_reason,
              recovered_at = excluded.recovered_at,
              updated_at = excluded.updated_at`,
          )
          .run(
            providerAccountId,
            update.status,
            update.consecutiveFailures,
            retryAt,
            resetAt,
            update.sanitizedReason ?? null,
            recoveredAt,
            normalizedNow,
          ),
      )();
      const state = this.getProviderState(providerAccountId);
      if (!state) throw new Error('Failed to persist Podsitter provider state');
      return state;
    },
    acquireProviderProbeLease(providerAccountId, owner, expiresAt, now = new Date().toISOString()) {
      const normalizedNow = normalizeIso(now, 'now');
      const normalizedExpiresAt = normalizeFutureLease(expiresAt, normalizedNow);
      return (
        db.transaction(() =>
          db
            .prepare(
              `UPDATE podsitter_provider_state
               SET probe_lease_owner = ?, probe_lease_expires_at = ?, updated_at = ?
               WHERE provider_account_id = ?
                 AND (probe_lease_expires_at IS NULL OR probe_lease_expires_at <= ? OR probe_lease_owner = ?)`,
            )
            .run(
              owner,
              normalizedExpiresAt,
              normalizedNow,
              providerAccountId,
              normalizedNow,
              owner,
            ),
        )().changes === 1
      );
    },
    releaseProviderProbeLease(providerAccountId, owner, now = new Date().toISOString()) {
      const normalizedNow = normalizeIso(now, 'now');
      return (
        db.transaction(() =>
          db
            .prepare(
              `UPDATE podsitter_provider_state
               SET probe_lease_owner = NULL, probe_lease_expires_at = NULL, updated_at = ?
               WHERE provider_account_id = ? AND probe_lease_owner = ?`,
            )
            .run(normalizedNow, providerAccountId, owner),
        )().changes === 1
      );
    },
    reserveAction(input) {
      const actor = operatorActorSchema.parse(input.actor);
      const actionArguments = podsitterActionArgumentsSchemas[input.action].parse(input.arguments);
      assertBoundedRedactedPayload(actionArguments, 'arguments');
      assertRedacted(input.policyResult, 'policyResult');
      const now = normalizeIso(input.now ?? new Date().toISOString(), 'now');
      try {
        db.transaction(() =>
          db
            .prepare(
              `INSERT INTO podsitter_action_audit (
                id, idempotency_key, pod_id, decision_id, failure_signature,
                actor, action, arguments, policy_result, daemon_result, reserved_at, completed_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)`,
            )
            .run(
              input.id,
              input.idempotencyKey,
              input.podId,
              input.decisionId,
              input.failureSignature ?? null,
              json(actor),
              input.action,
              json(actionArguments),
              input.policyResult,
              now,
            ),
        )();
        return true;
      } catch (error) {
        if (
          error instanceof Error &&
          /UNIQUE constraint failed.*idempotency_key/i.test(error.message)
        ) {
          return false;
        }
        throw error;
      }
    },
    completeAction(idempotencyKey, daemonResult, now = new Date().toISOString()) {
      assertRedacted(daemonResult, 'daemonResult');
      const normalizedNow = normalizeIso(now, 'now');
      return (
        db.transaction(() =>
          db
            .prepare(
              `UPDATE podsitter_action_audit
               SET daemon_result = ?, completed_at = ?
               WHERE idempotency_key = ? AND completed_at IS NULL`,
            )
            .run(daemonResult, normalizedNow, idempotencyKey),
        )().changes === 1
      );
    },
    getDecisionForAttention(attentionId) {
      const row = db
        .prepare('SELECT * FROM podsitter_decisions WHERE attention_id = ?')
        .get(attentionId) as Record<string, unknown> | undefined;
      return row ? hydrateDecision(row) : null;
    },
    createDecision(input) {
      const now = normalizeIso(input.now ?? new Date().toISOString(), 'now');
      const createOrRecover = db.transaction((): PodsitterDecisionRecord => {
        const attention = db
          .prepare(
            `SELECT pod_id, signature, lease_owner, lease_expires_at, state, decision_id
             FROM podsitter_attention
             WHERE id = ?`,
          )
          .get(input.attentionId) as
          | {
              pod_id: string;
              signature: string;
              lease_owner: string | null;
              lease_expires_at: string | null;
              state: PodsitterAttentionState;
              decision_id: string | null;
            }
          | undefined;
        if (
          !attention ||
          attention.pod_id !== input.podId ||
          attention.signature !== input.attentionSignature ||
          attention.lease_owner !== input.leaseOwner ||
          attention.lease_expires_at === null ||
          attention.lease_expires_at <= now ||
          attention.state !== 'deciding'
        ) {
          throw new Error(
            'Podsitter decision requires the matching current unexpired attention lease',
          );
        }

        if (attention.decision_id !== null) {
          return getDecision(attention.decision_id);
        }

        const result = db
          .prepare(
            `INSERT INTO podsitter_decisions (
              id, attention_id, pod_id, attention_signature, configuration_generation,
              evidence_hash, evidence_version, provider_account_id, runtime, model,
              reasoning_effort, decision, outcome, failure_code, input_tokens, output_tokens,
              cost_usd, created_at, completed_at, executed_at
            )
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'pending', NULL, NULL, NULL, NULL, ?, NULL, NULL
            WHERE EXISTS (
              SELECT 1 FROM podsitter_attention
              WHERE id = ?
                AND pod_id = ?
                AND signature = ?
                AND lease_owner = ?
                AND lease_expires_at > ?
                AND state = 'deciding'
                AND decision_id IS NULL
            )`,
          )
          .run(
            input.id,
            input.attentionId,
            input.podId,
            input.attentionSignature,
            input.configurationGeneration,
            input.evidenceHash,
            input.evidenceVersion,
            input.target.providerAccountId,
            input.target.runtime,
            input.target.model,
            input.target.reasoningEffort ?? null,
            now,
            input.attentionId,
            input.podId,
            input.attentionSignature,
            input.leaseOwner,
            now,
          );
        if (result.changes !== 1) {
          throw new Error('Podsitter decision requires the current unexpired attention lease');
        }
        const linked = db
          .prepare(
            `UPDATE podsitter_attention
             SET decision_id = ?, last_seen_at = ?
             WHERE id = ? AND decision_id IS NULL`,
          )
          .run(input.id, now, input.attentionId);
        if (linked.changes !== 1) {
          throw new Error('Podsitter decision could not be linked to its attention');
        }
        return getDecision(input.id);
      });
      return createOrRecover();
    },
    completeDecision(id, update, now = new Date().toISOString()) {
      const decision =
        update.decision === undefined || update.decision === null
          ? (update.decision ?? null)
          : podsitterDecisionSchema.parse(update.decision);
      if (decision !== null) {
        assertBoundedRedactedPayload(decision.arguments, 'decision arguments');
      }
      const normalizedNow = normalizeIso(now, 'now');
      const executedAt =
        update.executedAt === undefined || update.executedAt === null
          ? null
          : normalizeIso(update.executedAt, 'executedAt');
      db.transaction(() =>
        db
          .prepare(
            `UPDATE podsitter_decisions SET
              decision = ?, outcome = ?, failure_code = ?, input_tokens = ?,
              output_tokens = ?, cost_usd = ?, completed_at = ?, executed_at = ?
             WHERE id = ? AND completed_at IS NULL`,
          )
          .run(
            decision === null ? null : json(decision),
            update.outcome,
            update.failureCode ?? null,
            update.inputTokens ?? null,
            update.outputTokens ?? null,
            update.costUsd ?? null,
            normalizedNow,
            executedAt,
            id,
          ),
      )();
      return getDecision(id);
    },
    createSandboxRun(input) {
      const now = normalizeIso(input.now ?? new Date().toISOString(), 'now');
      db.transaction(() =>
        db
          .prepare(
            `INSERT INTO system_sandbox_runs (
              id, decision_id, backend, container_id, outcome, cleanup_state,
              failure_code, created_at, started_at, completed_at, updated_at
            ) VALUES (?, ?, ?, ?, 'running', 'pending', NULL, ?, ?, NULL, ?)`,
          )
          .run(
            input.id,
            input.decisionId ?? null,
            input.backend,
            input.containerId ?? null,
            now,
            now,
            now,
          ),
      )();
    },
    closeSandboxRun(id, update, now = new Date().toISOString()) {
      const normalizedNow = normalizeIso(now, 'now');
      return (
        db.transaction(() =>
          db
            .prepare(
              `UPDATE system_sandbox_runs SET
               outcome = ?, cleanup_state = ?, failure_code = ?,
                completed_at = ?, updated_at = ?
               WHERE id = ? AND completed_at IS NULL`,
            )
            .run(
              update.outcome,
              update.cleanupState,
              update.failureCode ?? null,
              normalizedNow,
              normalizedNow,
              id,
            ),
        )().changes === 1
      );
    },
  };
}
