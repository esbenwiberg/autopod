import type {
  AgentRoute,
  EffectiveLaunchConfig,
  OperatorActor,
  Pod,
  ReviewerBudgetEvidence,
  ReviewerBudgetRevision,
  ReviewerBudgetRevisionRequest,
  ReviewerBudgetView,
} from '@autopod/shared';
import { reviewerBudgetRevisionRequestSchema } from '@autopod/shared';
import type Database from 'better-sqlite3';
import { configurationDigest } from '../configuration/configuration-digest.js';
import { configurationError } from '../configuration/configuration-store.js';
import { UNRECONCILED_REVIEWER_RUN } from './reviewer-run-policy.js';

const columns = `id,pod_id AS podId,request_id AS requestId,authority_hash AS authorityHash,
 generation,frozen_limit AS frozenLimit,previous_limit AS previousLimit,new_limit AS "limit",
 recorded_tokens AS recordedTokens,evidence_hash AS evidenceHash,evidence,
 actor_id AS actorId,reason,created_at AS createdAt`;

type RevisionSql = Omit<ReviewerBudgetRevision, 'evidence'> & { evidence: string };
function decodeRevision(row: RevisionSql): ReviewerBudgetRevision {
  const evidence = JSON.parse(row.evidence) as ReviewerBudgetEvidence;
  if (configurationDigest(evidence) !== row.evidenceHash)
    configurationError(
      'Retained reviewer budget evidence is corrupt',
      'REVIEWER_BUDGET_CORRUPT',
      500,
    );
  return { ...row, evidence };
}

function authority(
  db: Database.Database,
  pod: Pod,
  config: EffectiveLaunchConfig,
  reservationRoute?: AgentRoute,
) {
  const original = db
    .prepare('SELECT digest FROM retained_pod_launch_snapshots WHERE pod_id=?')
    .get(pod.id) as { digest: string } | undefined;
  if (!original)
    return { native: false, hash: configurationDigest({ podId: pod.id, native: false }) };
  return {
    native: true,
    hash: configurationDigest({
      podId: pod.id,
      originalDigest: original?.digest ?? null,
      intent: config.intent,
      agentMode: config.workflow.agentMode,
      reviewer: config.ai.reviewer,
      reservationRoute:
        reservationRoute ??
        (config.ai.reviewer.mode === 'independent' ? config.ai.reviewer.route : config.ai.main),
      frozenLimit: config.workflow.reviewerTokenBudget,
    }),
  };
}

/** Called inside the reviewer's existing atomic reservation; never changes its workflow. */
export function effectiveReviewerBudget(
  db: Database.Database,
  pod: Pod,
  config: EffectiveLaunchConfig,
  reservationRoute?: AgentRoute,
) {
  const identity = authority(db, pod, config, reservationRoute);
  const row = identity.native
    ? (db
        .prepare(`SELECT ${columns} FROM pod_reviewer_budget_revisions
    WHERE pod_id=? AND authority_hash=? ORDER BY id DESC LIMIT 1`)
        .get(pod.id, identity.hash) as RevisionSql | undefined)
    : undefined;
  const revision = row ? decodeRevision(row) : null;
  if (
    revision &&
    (config.workflow.reviewerTokenBudget === null ||
      revision.frozenLimit !== config.workflow.reviewerTokenBudget)
  )
    configurationError('Reviewer budget authority is inconsistent', 'REVIEWER_BUDGET_CORRUPT', 500);
  return {
    limit: revision?.limit ?? config.workflow.reviewerTokenBudget,
    revision: revision ?? null,
    authorityHash: identity.hash,
    native: identity.native,
  };
}

export class ReviewerBudgetRevisions {
  constructor(
    private readonly db: Database.Database,
    private readonly context: {
      readPod(id: string): Pod;
      /** Must use the verified frozen snapshot reader, not current mutable presets. */
      readConfig(id: string): EffectiveLaunchConfig | null;
      assertSettled(id: string): void;
    },
  ) {}

  private state(podId: string) {
    const pod = this.context.readPod(podId);
    const config = this.context.readConfig(podId);
    if (!config)
      configurationError('Frozen launch configuration unavailable', 'CONFIG_SOURCE_MISSING', 409);
    const budget = effectiveReviewerBudget(this.db, pod, config);
    const runs = this.db
      .prepare(`SELECT id,state,cleanup,input_tokens AS inputTokens,
      output_tokens AS outputTokens,reconciled_at AS reconciledAt,usage_basis AS usageBasis,
      reconciled_by AS reconciledBy,reconciliation_note AS reconciliationNote,failure_kind AS failureKind,
      runtime,model,created_at AS createdAt,updated_at AS updatedAt,
      reviewer_budget_revision_id AS budgetRevisionId,${UNRECONCILED_REVIEWER_RUN} AS pending
      FROM isolated_reviewer_runs WHERE pod_id=? ORDER BY id`)
      .all(podId) as ReviewerBudgetEvidence['runs'];
    let recordedTokens = 0;
    let unknownUsageRunCount = 0;
    for (const run of runs) {
      if (run.inputTokens === null || run.outputTokens === null) unknownUsageRunCount++;
      for (const value of [run.inputTokens, run.outputTokens]) {
        if (value === null) continue;
        if (!Number.isSafeInteger(value) || value < 0)
          configurationError('Reviewer usage is invalid', 'REVIEWER_USAGE_UNAVAILABLE', 409);
        recordedTokens += value;
      }
    }
    if (!Number.isSafeInteger(recordedTokens))
      configurationError('Reviewer usage overflow', 'REVIEWER_USAGE_UNAVAILABLE', 409);
    const evidence: ReviewerBudgetEvidence = {
      podId,
      generation: pod.lifecycleGeneration,
      authorityHash: budget.authorityHash,
      limit: budget.limit,
      revisionId: budget.revision?.id ?? null,
      runs,
    };
    const view: ReviewerBudgetView = {
      podId,
      generation: pod.lifecycleGeneration,
      frozenLimit: config.workflow.reviewerTokenBudget,
      effectiveLimit: budget.limit,
      recordedTokens,
      pendingRunCount: runs.filter((r) => r.pending).length,
      unknownUsageRunCount,
      operatorReportedUsageRunCount: runs.filter((run) => run.usageBasis === 'operator-reported')
        .length,
      revision: budget.revision,
      evidence,
      evidenceHash: configurationDigest(evidence),
    };
    return { pod, config, budget, view, evidence };
  }

  inspect(podId: string): ReviewerBudgetView {
    return this.state(podId).view;
  }

  revise(
    podId: string,
    input: ReviewerBudgetRevisionRequest,
    actor: OperatorActor,
  ): ReviewerBudgetRevision {
    if (actor.type !== 'human' || !actor.userId.trim())
      configurationError('Authenticated human required', 'UNAUTHORIZED', 401);
    const request = reviewerBudgetRevisionRequestSchema.parse(input);
    const requestHash = configurationDigest({ podId, actorId: actor.userId, request });
    return this.db.transaction(() => {
      const { pod, config, budget, view, evidence } = this.state(podId);
      const previous = this.db
        .prepare(`SELECT ${columns},request_hash AS requestHash FROM pod_reviewer_budget_revisions
        WHERE pod_id=? AND request_id=?`)
        .get(podId, request.requestId) as (RevisionSql & { requestHash: string }) | undefined;
      if (previous) {
        if (previous.requestHash !== requestHash || previous.authorityHash !== budget.authorityHash)
          configurationError(
            'Reviewer budget request ID was reused with different authority or content',
            'REQUEST_CONFLICT',
            409,
          );
        const { requestHash: _hash, ...receipt } = previous;
        return decodeRevision(receipt);
      }
      if (
        !budget.native ||
        config.intent !== 'task' ||
        pod.options.agentMode === 'interactive' ||
        pod.fleetArchivedAt ||
        !['failed', 'review_required', 'validated', 'paused'].includes(pod.status)
      )
        configurationError(
          'Reviewer allowance requires a settled ordinary native task',
          'REVIEWER_BUDGET_UNAVAILABLE',
          409,
        );
      this.context.assertSettled(podId);
      if (view.pendingRunCount || view.unknownUsageRunCount)
        configurationError(
          'Reviewer execution or measured usage is unsettled; retain its existing reconciliation hold',
          'REVIEWER_RECONCILIATION_REQUIRED',
          409,
        );
      if (view.operatorReportedUsageRunCount)
        configurationError(
          'Reviewer allowance requires native measured counters; retain operator-reported usage and provenance',
          'REVIEWER_USAGE_UNAVAILABLE',
          409,
        );
      if (
        pod.lifecycleGeneration !== request.expectedGeneration ||
        view.evidenceHash !== request.expectedEvidenceHash ||
        view.effectiveLimit !== request.expectedLimit
      )
        configurationError(
          'Refresh exact reviewer usage, generation and ceiling',
          'REVIEWER_BUDGET_STALE',
          409,
        );
      if (
        view.frozenLimit === null ||
        budget.limit === null ||
        request.limit <= budget.limit ||
        request.limit <= view.recordedTokens
      )
        configurationError(
          'Only a finite increase above the existing ceiling and recorded usage is allowed',
          'REVIEWER_BUDGET_INVALID_INCREASE',
          409,
        );
      const createdAt = new Date().toISOString();
      const row = this.db
        .prepare(`INSERT INTO pod_reviewer_budget_revisions
        (pod_id,request_id,authority_hash,request_hash,generation,frozen_limit,previous_limit,new_limit,recorded_tokens,evidence_hash,evidence,actor_id,reason,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(
          podId,
          request.requestId,
          budget.authorityHash,
          requestHash,
          pod.lifecycleGeneration,
          view.frozenLimit,
          budget.limit,
          request.limit,
          view.recordedTokens,
          view.evidenceHash,
          JSON.stringify(evidence),
          actor.userId,
          request.reason,
          createdAt,
        );
      return decodeRevision(
        this.db
          .prepare(`SELECT ${columns} FROM pod_reviewer_budget_revisions WHERE id=?`)
          .get(row.lastInsertRowid) as RevisionSql,
      );
    })();
  }
}
