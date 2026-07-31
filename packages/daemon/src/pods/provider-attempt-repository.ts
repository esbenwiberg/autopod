import type {
  ProviderAccountProvider,
  ProviderAttempt,
  ProviderAttemptOutcome,
  ProviderFailureClassification,
  RuntimeType,
} from '@autopod/shared';
import type Database from 'better-sqlite3';

export interface OpenProviderAttempt {
  podId: string;
  provider: ProviderAccountProvider;
  providerAccountId: string | null;
  runtime: RuntimeType;
  model: string;
  profileReference: string;
  /** Complete credential-redacted resolved profile snapshot; never returned by the pod API. */
  profileSnapshot: Record<string, unknown>;
  startedAt?: string;
}

export interface CloseProviderAttempt {
  nativeSessionId: string | null;
  endedAt?: string;
  outcome: ProviderAttemptOutcome;
  classification?: ProviderFailureClassification | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  handoffReference?: string | null;
}

export interface ProviderAttemptTotals {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface UpdateActiveProviderAttempt {
  nativeSessionId?: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface ProviderAttemptTelemetryCorrection {
  podId: string;
  ordinal: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  source: 'codex_rollout';
  reason: string;
  correctedAt?: string;
}

export interface ProviderAttemptRepository {
  open(input: OpenProviderAttempt): ProviderAttempt;
  updateActive(podId: string, input: UpdateActiveProviderAttempt): ProviderAttempt;
  close(podId: string, input: CloseProviderAttempt): ProviderAttempt;
  /** Effective attempts with audited telemetry corrections projected when present. */
  list(podId: string): ProviderAttempt[];
  /** Original append-only attempt evidence without correction projection. */
  listRaw(podId: string): ProviderAttempt[];
  upsertTelemetryCorrection(input: ProviderAttemptTelemetryCorrection): void;
  getActive(podId: string): ProviderAttempt | null;
  getActiveProfileSnapshot(podId: string): Record<string, unknown> | null;
  totals(podId: string): ProviderAttemptTotals;
  reservePreSubmitReview(podId: string): boolean;
}

export const MAX_PRE_SUBMIT_REVIEWS_PER_ATTEMPT = 2;

interface AttemptRow {
  pod_id: string;
  ordinal: number;
  provider: ProviderAccountProvider;
  provider_account_id: string | null;
  runtime: RuntimeType;
  model: string;
  profile_reference: string;
  profile_snapshot: string;
  native_session_id: string | null;
  started_at: string;
  ended_at: string | null;
  outcome: ProviderAttemptOutcome | null;
  classification_category: ProviderFailureClassification['category'] | null;
  classification_definitive: number | null;
  classification_message: string | null;
  classification_retry_after: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  pre_submit_review_runs: number;
  handoff_reference: string | null;
}

const PROFILE_REFERENCE_PATTERN = /^pod:[a-z0-9-]+@profile-snapshot#[a-f0-9]{7,64}$/;

function assertProfileReference(reference: string): void {
  if (!PROFILE_REFERENCE_PATTERN.test(reference)) {
    throw new Error('profileReference must identify a persisted pod profile snapshot by hash');
  }
}

function assertCredentialFreeSnapshot(value: unknown, key = ''): void {
  const normalizedKey = key.toLowerCase();
  const sensitiveKey =
    normalizedKey.includes('credential') ||
    normalizedKey.includes('password') ||
    normalizedKey.includes('secret') ||
    normalizedKey.includes('token') ||
    normalizedKey.includes('apikey') ||
    normalizedKey.includes('api_key') ||
    normalizedKey.includes('authorization') ||
    normalizedKey.includes('header') ||
    normalizedKey === 'env' ||
    normalizedKey.endsWith('pat') ||
    normalizedKey === 'auth';
  if (sensitiveKey && value !== null && value !== undefined) {
    throw new Error(`profileSnapshot contains non-redacted sensitive field ${key}`);
  }
  if (Array.isArray(value)) {
    for (const item of value) assertCredentialFreeSnapshot(item);
  } else if (value && typeof value === 'object') {
    for (const [childKey, childValue] of Object.entries(value)) {
      assertCredentialFreeSnapshot(childValue, childKey);
    }
  } else if (typeof value === 'string' && /:\/\/[^/@\s]+:[^/@\s]+@/.test(value)) {
    throw new Error('profileSnapshot contains URL userinfo');
  }
}

function hydrate(row: AttemptRow): ProviderAttempt {
  const classification =
    row.classification_category && row.classification_message !== null
      ? {
          category: row.classification_category,
          definitive: row.classification_definitive === 1,
          sanitizedMessage: row.classification_message,
          retryAfter: row.classification_retry_after,
        }
      : null;
  return {
    podId: row.pod_id,
    ordinal: row.ordinal,
    provider: row.provider,
    providerAccountId: row.provider_account_id,
    runtime: row.runtime,
    model: row.model,
    profileReference: row.profile_reference,
    nativeSessionId: row.native_session_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    outcome: row.outcome,
    classification,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costUsd: row.cost_usd,
    preSubmitReviewRuns: row.pre_submit_review_runs,
    handoffReference: row.handoff_reference,
  };
}

export function createProviderAttemptRepository(db: Database.Database): ProviderAttemptRepository {
  const selectList = db.prepare(`
    SELECT a.*,
      COALESCE(c.input_tokens, a.input_tokens) AS input_tokens,
      COALESCE(c.output_tokens, a.output_tokens) AS output_tokens,
      COALESCE(c.cost_usd, a.cost_usd) AS cost_usd
    FROM provider_attempts a
    LEFT JOIN provider_attempt_telemetry_corrections c
      ON c.pod_id = a.pod_id AND c.ordinal = a.ordinal
    WHERE a.pod_id = ? ORDER BY a.ordinal ASC
  `);
  const selectRawList = db.prepare(
    'SELECT * FROM provider_attempts WHERE pod_id = ? ORDER BY ordinal ASC',
  );
  const selectActive = db.prepare(
    'SELECT * FROM provider_attempts WHERE pod_id = ? AND ended_at IS NULL',
  );
  const selectOrdinal = db.prepare(
    'SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal FROM provider_attempts WHERE pod_id = ?',
  );
  const insert = db.prepare(`
    INSERT INTO provider_attempts (
      pod_id, ordinal, provider, provider_account_id, runtime, model,
      profile_reference, profile_snapshot, started_at
    ) VALUES (
      @podId, @ordinal, @provider, @providerAccountId, @runtime, @model,
      @profileReference, @profileSnapshot, @startedAt
    )
  `);
  const closeActive = db.prepare(`
    UPDATE provider_attempts SET
      native_session_id = COALESCE(@nativeSessionId, native_session_id),
      ended_at = @endedAt,
      outcome = @outcome,
      classification_category = @classificationCategory,
      classification_definitive = @classificationDefinitive,
      classification_message = @classificationMessage,
      classification_retry_after = @classificationRetryAfter,
      handoff_reference = @handoffReference
    WHERE pod_id = @podId AND ended_at IS NULL
  `);
  const updateActive = db.prepare(`
    UPDATE provider_attempts SET
      native_session_id = COALESCE(@nativeSessionId, native_session_id),
      input_tokens = @inputTokens,
      output_tokens = @outputTokens,
      cost_usd = @costUsd
    WHERE pod_id = @podId AND ended_at IS NULL
  `);
  const upsertTelemetryCorrection = db.prepare(`
    INSERT INTO provider_attempt_telemetry_corrections (
      pod_id, ordinal, input_tokens, output_tokens, cost_usd, source, reason, corrected_at
    ) VALUES (
      @podId, @ordinal, @inputTokens, @outputTokens, @costUsd, @source, @reason, @correctedAt
    )
    ON CONFLICT(pod_id, ordinal) DO NOTHING
  `);
  const selectTelemetryCorrection = db.prepare(`
    SELECT input_tokens AS inputTokens, output_tokens AS outputTokens, cost_usd AS costUsd,
           source, reason
    FROM provider_attempt_telemetry_corrections
    WHERE pod_id = ? AND ordinal = ?
  `);
  const reservePreSubmitReview = db.prepare(`
    UPDATE provider_attempts
    SET pre_submit_review_runs = pre_submit_review_runs + 1
    WHERE pod_id = ? AND ended_at IS NULL
      AND pre_submit_review_runs < ${MAX_PRE_SUBMIT_REVIEWS_PER_ATTEMPT}
  `);

  const repository: ProviderAttemptRepository = {
    open(input) {
      return db.transaction(() => {
        assertProfileReference(input.profileReference);
        assertCredentialFreeSnapshot(input.profileSnapshot);
        const ordinal = (selectOrdinal.get(input.podId) as { ordinal: number }).ordinal;
        insert.run({
          ...input,
          profileSnapshot: JSON.stringify(input.profileSnapshot),
          ordinal,
          startedAt: input.startedAt ?? new Date().toISOString(),
        });
        const row = selectActive.get(input.podId) as AttemptRow;
        return hydrate(row);
      })();
    },

    updateActive(podId, input) {
      const result = updateActive.run({
        podId,
        nativeSessionId: input.nativeSessionId ?? null,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        costUsd: input.costUsd,
      });
      if (result.changes !== 1) {
        throw new Error(`No active provider attempt exists for pod ${podId}`);
      }
      const active = repository.getActive(podId);
      if (!active) throw new Error(`Provider attempt disappeared for pod ${podId}`);
      return active;
    },

    close(podId, input) {
      return db.transaction(() => {
        repository.updateActive(podId, {
          nativeSessionId: input.nativeSessionId,
          inputTokens: input.inputTokens,
          outputTokens: input.outputTokens,
          costUsd: input.costUsd,
        });
        const classification =
          input.classification ??
          (input.outcome === 'failed' || input.outcome === 'quota_exhausted'
            ? {
                category: 'unknown' as const,
                definitive: false,
                sanitizedMessage: 'Provider attempt ended without classified evidence',
                retryAfter: null,
              }
            : null);
        const result = closeActive.run({
          podId,
          nativeSessionId: input.nativeSessionId,
          endedAt: input.endedAt ?? new Date().toISOString(),
          outcome: input.outcome,
          classificationCategory: classification?.category ?? null,
          classificationDefinitive: classification ? Number(classification.definitive) : null,
          classificationMessage: classification?.sanitizedMessage ?? null,
          classificationRetryAfter: classification?.retryAfter ?? null,
          handoffReference: input.handoffReference ?? null,
        });
        if (result.changes !== 1) {
          throw new Error(`No active provider attempt exists for pod ${podId}`);
        }
        const attempts = repository.list(podId);
        const closed = attempts.at(-1);
        if (!closed) throw new Error(`Provider attempt disappeared for pod ${podId}`);
        return closed;
      })();
    },

    list(podId) {
      return (selectList.all(podId) as AttemptRow[]).map(hydrate);
    },

    listRaw(podId) {
      return (selectRawList.all(podId) as AttemptRow[]).map(hydrate);
    },

    upsertTelemetryCorrection(input) {
      if (!Number.isInteger(input.inputTokens) || input.inputTokens < 0) {
        throw new Error('Corrected inputTokens must be a non-negative integer');
      }
      if (!Number.isInteger(input.outputTokens) || input.outputTokens < 0) {
        throw new Error('Corrected outputTokens must be a non-negative integer');
      }
      if (!Number.isFinite(input.costUsd) || input.costUsd < 0) {
        throw new Error('Corrected costUsd must be a non-negative finite number');
      }
      const result = upsertTelemetryCorrection.run({
        ...input,
        correctedAt: input.correctedAt ?? new Date().toISOString(),
      });
      if (result.changes === 0) {
        const existing = selectTelemetryCorrection.get(input.podId, input.ordinal) as
          | {
              inputTokens: number;
              outputTokens: number;
              costUsd: number;
              source: string;
              reason: string;
            }
          | undefined;
        if (
          !existing ||
          existing.inputTokens !== input.inputTokens ||
          existing.outputTokens !== input.outputTokens ||
          existing.costUsd !== input.costUsd ||
          existing.source !== input.source ||
          existing.reason !== input.reason
        ) {
          throw new Error(
            `Conflicting telemetry correction already exists for ${input.podId}#${input.ordinal}`,
          );
        }
      }
    },

    getActive(podId) {
      const row = selectActive.get(podId) as AttemptRow | undefined;
      return row ? hydrate(row) : null;
    },

    getActiveProfileSnapshot(podId) {
      const row = selectActive.get(podId) as AttemptRow | undefined;
      return row ? (JSON.parse(row.profile_snapshot) as Record<string, unknown>) : null;
    },

    totals(podId) {
      const row = db
        .prepare(`
          SELECT
            COALESCE(SUM(COALESCE(c.input_tokens, a.input_tokens)), 0) AS inputTokens,
            COALESCE(SUM(COALESCE(c.output_tokens, a.output_tokens)), 0) AS outputTokens,
            COALESCE(SUM(COALESCE(c.cost_usd, a.cost_usd)), 0) AS costUsd
          FROM provider_attempts a
          LEFT JOIN provider_attempt_telemetry_corrections c
            ON c.pod_id = a.pod_id AND c.ordinal = a.ordinal
          WHERE a.pod_id = ?
        `)
        .get(podId) as ProviderAttemptTotals;
      return row;
    },

    reservePreSubmitReview(podId) {
      return reservePreSubmitReview.run(podId).changes === 1;
    },
  };

  return repository;
}
