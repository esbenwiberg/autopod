import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { digest } from '../managed/canonical.js';
import { assertParentIntegrationBinding } from './parent-candidate-integration.js';
import { readQualifiedParentIntegration } from './parent-integration-qualified.js';

const sha = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const decision = z.object({ evidenceDigest: sha, expectedReviewDigest: sha }).strict();
const params = z.object({ podId: z.string().min(1).max(160), evidence: sha });

export interface ParentReviewOwner {
  run: string;
  podId: string;
  /** Digest of the full enrolled principal, never a body/header selector. */
  actorDigest: string;
}

export class ParentReviewHandoff {
  constructor(private readonly db: Database.Database) {}

  private current(owner: ParentReviewOwner, evidence: string) {
    if (
      !this.db
        .prepare('SELECT 1 FROM parent_managed_runs WHERE run_id=? AND pod_id=?')
        .get(owner.run, owner.podId)
    )
      throw new Error('parent-review-owner-mismatch');
    const qualified = readQualifiedParentIntegration(this.db, owner.run, evidence);
    const { checkpoint, gateRequest, checks, independentReview, bundle } = qualified;
    assertParentIntegrationBinding(
      this.db,
      owner.run,
      gateRequest.inputs,
      gateRequest.bindingDigest,
    );
    const core = {
      run: owner.run,
      parentId: owner.podId,
      evidenceDigest: evidence,
      commit: checkpoint.commit,
      tree: checkpoint.tree,
      bundleDigest: gateRequest.bundleDigest,
      ...(gateRequest.resultTransport === 'anchored/v1'
        ? { bundleBaseCommit: checkpoint.predecessor }
        : {}),
      paths: gateRequest.paths,
      checks: checks.receiptDigest,
      independentReview: independentReview.receiptDigest,
    };
    const review = { ...core, reviewDigest: digest(['parent-private-review/v1', core]) };
    return { review, bundle };
  }

  qualification(owner: ParentReviewOwner) {
    const row = this.db
      .prepare(`SELECT j.status,j.evidence_digest FROM parent_managed_runs p
      LEFT JOIN parent_qualification_jobs j ON j.run_id=p.run_id
      WHERE p.run_id=? AND p.pod_id=?`)
      .get(owner.run, owner.podId) as
      | { status: string | null; evidence_digest: string | null }
      | undefined;
    if (!row) throw new Error('parent-review-owner-mismatch');
    return { status: row.status ?? 'waiting', evidenceDigest: row.evidence_digest };
  }

  /** Read-only owner projection for the family card. Never returns bundle bytes. */
  familyReview(owner: ParentReviewOwner, automatic: boolean) {
    return this.db.transaction(() => {
      const canceled = this.db
        .prepare('SELECT canceled FROM orchestration_runs WHERE id=?')
        .pluck()
        .get(owner.run);
      if (canceled !== 0) return { status: 'unavailable' };
      const { status, evidenceDigest } = this.qualification(owner);
      if (status === 'ready' && evidenceDigest) {
        try {
          const { review } = this.current(owner, evidenceDigest);
          return { status, evidenceDigest, commit: review.commit };
        } catch {
          return { status: 'unavailable' };
        }
      }
      if (status === 'waiting' && !automatic) return { status: 'not-configured' };
      if (
        status === 'waiting' &&
        this.db
          .prepare(`
        SELECT 1 FROM parent_managed_requests q
        JOIN orchestration_continuations c ON c.run_id=q.run_id AND c.start_key=q.start_key
        JOIN managed_pods p ON p.pod_id=c.pod_id AND p.dispatcher_installation_id=('native.'||q.run_id)
          AND p.managed_start_key=q.start_key AND p.dispatcher_attempt_id=c.attempt_id
          AND p.execution_spec_digest=json_extract(c.request_json,'$.executionSpecDigest')
        WHERE q.run_id=? AND q.private_scope_json IS NOT NULL AND p.observed_exit=1
          AND (p.revoked=1 OR p.stop_requested=1 OR p.exit_code IS NOT 0
            OR p.state IN ('failed','killed','review_required')) LIMIT 1`)
          .get(owner.run)
      )
        return { status: 'candidate-unavailable' };
      if (status === 'ready') return { status: 'unavailable' };
      return { status };
    })();
  }

  preview(owner: ParentReviewOwner, evidence: string) {
    return this.db.transaction(() => this.current(owner, evidence).review)();
  }

  approve(owner: ParentReviewOwner, raw: unknown) {
    const { evidenceDigest, expectedReviewDigest } = decision.parse(raw);
    return this.db
      .transaction(() => {
        const { review } = this.current(owner, evidenceDigest);
        if (review.reviewDigest !== expectedReviewDigest)
          throw new Error('parent-review-digest-mismatch');
        const approvalDigest = digest([
          'parent-private-approval/v1',
          owner.actorDigest,
          review.reviewDigest,
        ]);
        this.db
          .prepare(`INSERT OR IGNORE INTO parent_review_approvals
        (run_id,evidence_digest,approval_digest,actor_digest,approved_at) VALUES (?,?,?,?,?)`)
          .run(
            owner.run,
            evidenceDigest,
            approvalDigest,
            owner.actorDigest,
            Math.floor(Date.now() / 1000),
          );
        const row = this.assertApproved(owner, review);
        return { review, approvalDigest, approvedAt: row.approved_at };
      })
      .immediate();
  }

  private assertApproved(
    owner: ParentReviewOwner,
    review: { evidenceDigest: string; reviewDigest: string },
  ) {
    const row = this.db
      .prepare(`SELECT evidence_digest,approval_digest,actor_digest,approved_at
      FROM parent_review_approvals WHERE run_id=? AND evidence_digest=?`)
      .get(owner.run, review.evidenceDigest) as
      | {
          evidence_digest: string;
          approval_digest: string;
          actor_digest: string;
          approved_at: number;
        }
      | undefined;
    if (
      !row ||
      row.evidence_digest !== review.evidenceDigest ||
      row.actor_digest !== owner.actorDigest ||
      row.approval_digest !==
        digest(['parent-private-approval/v1', owner.actorDigest, review.reviewDigest])
    )
      throw new Error('parent-review-approval-required');
    return row;
  }

  download(owner: ParentReviewOwner, evidence: string) {
    return this.db.transaction(() => {
      const { review, bundle } = this.current(owner, evidence);
      this.assertApproved(owner, review);
      return { review, bundle };
    })();
  }
}

export function registerParentReviewRoutes(
  app: FastifyInstance,
  handoff: ParentReviewHandoff,
  authorize: (request: FastifyRequest, podId: string) => Promise<ParentReviewOwner | null>,
) {
  app.get('/orchestration/parents/:podId/review/status', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const { podId } = request.params as { podId: string };
    const owner = await authorize(request, podId);
    if (!owner) return reply.code(404).send({ code: 'parent-review-not-found' });
    return handoff.qualification(owner);
  });
  for (const op of ['preview', 'approve', 'bundle'] as const) {
    app.route({
      method: op === 'approve' ? 'POST' : 'GET',
      url: `/orchestration/parents/:podId/review/:evidence/${op}`,
      bodyLimit: 2048,
      handler: async (request, reply) => {
        reply.header('cache-control', 'no-store');
        const parsed = params.safeParse(request.params);
        if (!parsed.success)
          return reply.code(400).send({ code: 'parent-review-selector-invalid' });
        const { podId, evidence } = parsed.data;
        const owner = await authorize(request, podId);
        if (!owner) return reply.code(404).send({ code: 'parent-review-not-found' });
        try {
          if (op === 'preview') return handoff.preview(owner, evidence);
          if (op === 'approve') {
            const input = decision.safeParse(request.body);
            if (!input.success || input.data.evidenceDigest !== evidence)
              return reply.code(400).send({ code: 'parent-review-decision-invalid' });
            return handoff.approve(owner, input.data);
          }
          const { bundle, review } = handoff.download(owner, evidence);
          return reply
            .type('application/octet-stream')
            .header('x-content-type-options', 'nosniff')
            .header('content-disposition', `attachment; filename="parent-${review.commit}.bundle"`)
            .header('x-autopod-bundle-digest', review.bundleDigest)
            .send(bundle);
        } catch {
          return reply.code(409).send({ code: 'parent-review-unavailable' });
        }
      },
    });
  }
}
