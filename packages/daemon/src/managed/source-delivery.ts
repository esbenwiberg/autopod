import {
  type FinalizeSourceDeliveryRequest,
  type FinalizeSourceDeliveryResponse,
  type ManagedPodRequest,
  type SourceCandidateReceipt,
  type SourceDeliveryReceipt,
  parseManagedRecord,
} from '@autopod/shared';
import { canonical, digest, sha256 } from './canonical.js';
import { ManagedControls } from './managed-controls.js';
import type { ManagedPodService } from './managed-service.js';
import type { DraftBroker, DraftRecord, ManagedGitBroker } from './source-git.js';

const without = (value: object, key: string) =>
  Object.fromEntries(Object.entries(value).filter(([field]) => field !== key));
interface Operation {
  request_digest: string;
  phase: string;
  receipt_json: string | null;
}

/** Only this v2 broker may turn verified candidates into source effects. */
export class ManagedSourceDelivery {
  private readonly running = new Map<string, Promise<FinalizeSourceDeliveryResponse>>();
  constructor(
    readonly service: ManagedPodService,
    readonly git: ManagedGitBroker,
    readonly verifierIdentities: ReadonlyMap<string, string>,
    readonly drafts?: DraftBroker,
  ) {}
  candidate(
    installation: string,
    podId: string,
  ): { receipt: SourceCandidateReceipt; bundle: Buffer } {
    this.service.row(installation, podId);
    const row = this.service.db
      .prepare('SELECT candidate_json,bundle FROM managed_source_candidates WHERE pod_id=?')
      .get(podId) as { candidate_json: string; bundle: Buffer } | undefined;
    if (!row) throw new Error('source-candidate-unavailable');
    const receipt = parseManagedRecord(
      'SourceCandidateReceiptSchema',
      JSON.parse(row.candidate_json),
    );
    if (
      digest(without(receipt, 'candidateDigest')) !== receipt.candidateDigest ||
      sha256(row.bundle) !== receipt.evidenceDigest
    )
      throw new Error('source-candidate-integrity');
    return { receipt, bundle: row.bundle };
  }
  async unchanged(installation: string, podId: string): Promise<boolean> {
    const row = this.service.row(installation, podId);
    const spec = JSON.parse(row.request_json) as ManagedPodRequest;
    if (!row.observed_exit || spec.outputs.source.mode === 'none') return false;
    return this.git.unchanged(podId, spec.outputs.source);
  }
  async freeze(installation: string, podId: string): Promise<SourceCandidateReceipt> {
    const row = this.service.row(installation, podId);
    const spec = JSON.parse(row.request_json) as ManagedPodRequest;
    if (
      !row.observed_exit ||
      !['validated', 'validating'].includes(row.state) ||
      spec.outputs.source.mode === 'none'
    )
      throw new Error('source-freeze-before-validation');
    if (
      this.service.db.prepare('SELECT 1 FROM managed_source_candidates WHERE pod_id=?').get(podId)
    )
      return this.candidate(installation, podId).receipt;
    const frozen = await this.git.freeze(podId, spec.outputs.source);
    const value = {
      schemaVersion: 1 as const,
      candidateId: `candidate-${podId}`,
      podId,
      dispatcherAttemptId: row.dispatcher_attempt_id,
      executionSpecDigest: row.execution_spec_digest,
      repository: spec.outputs.source.repository,
      remote: spec.outputs.source.remote,
      head: spec.outputs.source.head,
      base: spec.outputs.source.base,
      expectedOldCommit: frozen.expectedOldCommit,
      newCommit: frozen.newCommit,
      evidenceDigest: sha256(frozen.bundle),
    };
    const receipt = parseManagedRecord('SourceCandidateReceiptSchema', {
      ...value,
      candidateDigest: digest(value),
    });
    this.service.db
      .transaction(() => {
        this.service.db
          .prepare('INSERT OR IGNORE INTO managed_source_candidates VALUES (?,?,?)')
          .run(podId, canonical(receipt), frozen.bundle);
        if (canonical(this.candidate(installation, podId).receipt) !== canonical(receipt))
          throw new Error('source-candidate-conflict');
        this.service.db
          .prepare(
            'INSERT INTO managed_results(pod_id,candidates_json) VALUES (?,?) ON CONFLICT(pod_id) DO UPDATE SET candidates_json=excluded.candidates_json',
          )
          .run(podId, canonical([receipt]));
        this.service.db
          .prepare("UPDATE managed_pods SET state='validated' WHERE pod_id=?")
          .run(podId);
        new ManagedControls(this.service).event(row, 'candidate-frozen', 'validated');
      })
      .immediate();
    return receipt;
  }
  private authorize(
    installation: string,
    podId: string,
    request: FinalizeSourceDeliveryRequest,
  ): void {
    const row = this.service.row(installation, podId);
    if (
      row.revoked ||
      row.stop_requested ||
      this.service.expired(row) ||
      row.grant_id !== request.grantId ||
      row.grant_revision !== request.grantRevision
    )
      throw new Error('source-grant-inactive');
  }
  private validate(
    installation: string,
    podId: string,
    request: FinalizeSourceDeliveryRequest,
  ): SourceCandidateReceipt {
    const row = this.service.row(installation, podId);
    const spec = JSON.parse(row.request_json) as ManagedPodRequest;
    const candidate = this.candidate(installation, podId).receipt;
    const verification = request.verificationReceipt;
    if (
      installation !== request.dispatcherInstallationId ||
      request.operation !== spec.outputs.source.mode ||
      !row.observed_exit ||
      request.dispatcherAttemptId !== row.dispatcher_attempt_id ||
      request.executionSpecDigest !== row.execution_spec_digest ||
      [
        'repository',
        'remote',
        'head',
        'base',
        'expectedOldCommit',
        'newCommit',
        'candidateDigest',
      ].some(
        (key) => request[key as keyof typeof request] !== candidate[key as keyof typeof candidate],
      )
    )
      throw new Error('source-finalize-binding-mismatch');
    if (
      verification.receiptDigest !== digest(without(verification, 'receiptDigest')) ||
      verification.status !== 'passed' ||
      verification.dispatcherAttemptId !== row.dispatcher_attempt_id ||
      verification.executionSpecDigest !== row.execution_spec_digest ||
      verification.candidateDigest !== candidate.candidateDigest ||
      verification.newCommit !== candidate.newCommit ||
      verification.evidenceDigest !== candidate.evidenceDigest ||
      verification.verifierPolicy !== spec.validation.verifierPolicy ||
      this.verifierIdentities.get(verification.verifierPolicy) !== verification.verifierIdentity ||
      verification.verifiedAt > this.service.now()
    )
      throw new Error('source-independent-verification-required');
    this.git.binding(candidate);
    if (request.operation === 'draft-pr' && !this.drafts)
      throw new Error('source-draft-unavailable');
    return candidate;
  }
  async finalize(
    installation: string,
    podId: string,
    raw: unknown,
    fault?: string,
  ): Promise<FinalizeSourceDeliveryResponse> {
    const request = parseManagedRecord('FinalizeSourceDeliveryRequestSchema', raw);
    this.service.row(installation, podId);
    const hash = digest(request);
    const prior = this.service.db
      .prepare('SELECT * FROM managed_source_operations WHERE pod_id=?')
      .get(podId) as Operation | undefined;
    if (prior && prior.request_digest !== hash) throw new Error('source-operation-conflict');
    // Receipt reads are passive, including after expiry/revocation.
    if (prior?.receipt_json)
      return {
        schemaVersion: 1,
        status: 'delivered',
        receipts: [JSON.parse(prior.receipt_json)],
        reason: 'recorded',
      };
    const candidate = this.validate(installation, podId, request);
    const running = this.running.get(podId);
    if (running) return running;
    const run = async (): Promise<FinalizeSourceDeliveryResponse> => {
      this.service.db
        .transaction(() => {
          const current = this.service.db
            .prepare('SELECT * FROM managed_source_operations WHERE pod_id=?')
            .get(podId) as Operation | undefined;
          if (current && current.request_digest !== hash)
            throw new Error('source-operation-conflict');
          if (!current) this.authorize(installation, podId, request);
          this.service.db
            .prepare(
              'INSERT OR IGNORE INTO managed_source_operations(pod_id,operation_key,request_digest,request_json) VALUES (?,?,?,?)',
            )
            .run(podId, request.operationKey, hash, canonical(request));
        })
        .immediate();
      const claim = (from: string, to: string) =>
        this.service.db
          .prepare('UPDATE managed_source_operations SET phase=? WHERE pod_id=? AND phase=?')
          .run(to, podId, from).changes === 1;
      const authorize = () => this.authorize(installation, podId, request);
      if (request.operation !== 'commit') {
        const matches = await this.git.branchMatches(candidate);
        if (!matches) {
          authorize();
          // A different process may own a push; only its CAS claimant can issue it.
          if (fault === 'before-push') throw new Error('injected-before-push');
          const claimed = claim('reserved', 'pushing');
          const current = this.service.db
            .prepare('SELECT phase FROM managed_source_operations WHERE pod_id=?')
            .get(podId) as { phase: string };
          if (!claimed && current.phase !== 'pushing') throw new Error('source-push-uncertain');
          await this.git.push(candidate, authorize, this.candidate(installation, podId).bundle);
          if (fault === 'after-push') throw new Error('injected-after-push');
          if (!(await this.git.branchMatches(candidate))) throw new Error('source-push-unverified');
        }
        this.service.db
          .prepare(
            "UPDATE managed_source_operations SET phase='pushed' WHERE pod_id=? AND phase IN ('reserved','pushing')",
          )
          .run(podId);
      }
      let prId = 0;
      if (request.operation === 'draft-pr') {
        let pr = await this.drafts?.inspect(request);
        const exact = (value: DraftRecord) =>
          value.repository === request.repository &&
          value.head === request.head &&
          value.base === request.base &&
          value.commit === request.newCommit &&
          value.draft &&
          value.bodyDigest === request.bodyDigest;
        if (pr && !exact(pr)) {
          // Never mark ready, change base, or overwrite an independently changed draft.
          if (
            !pr.draft ||
            pr.repository !== request.repository ||
            pr.head !== request.head ||
            pr.base !== request.base ||
            pr.commit !== request.newCommit
          )
            throw new Error('source-draft-changed');
          const spec = JSON.parse(
            this.service.row(installation, podId).request_json,
          ) as ManagedPodRequest;
          if (!spec.effectiveGrant.scope.allowedEffects.includes('pull-request.update-draft'))
            throw new Error('source-draft-update-not-granted');
          authorize();
          if (!claim('pushed', 'updating')) throw new Error('source-draft-uncertain');
          pr = await this.drafts?.update(request, pr);
        } else if (!pr) {
          authorize();
          if (fault === 'before-pr') throw new Error('injected-before-pr');
          if (!claim('pushed', 'creating')) throw new Error('source-draft-uncertain');
          pr = await this.drafts?.create(request);
          if (fault === 'after-pr') throw new Error('injected-after-pr');
        }
        if (!pr || !exact(pr)) throw new Error('source-draft-unverified');
        prId = pr.id;
      }
      const receipt: SourceDeliveryReceipt = {
        schemaVersion: 1,
        dispatcherAttemptId: request.dispatcherAttemptId,
        executionSpecDigest: request.executionSpecDigest,
        candidateDigest: request.candidateDigest,
        verificationReceiptDigest: request.verificationReceipt.receiptDigest,
        operationKey: request.operationKey,
        requestDigest: hash,
        operation: request.operation,
        repository: request.repository,
        remote: request.remote,
        head: request.head,
        base: request.base,
        oldCommit: request.expectedOldCommit,
        newCommit: request.newCommit,
        draft: true,
        bodyDigest: request.bodyDigest,
        pullRequestId: prId,
        status: 'delivered',
      };
      parseManagedRecord('SourceDeliveryReceiptSchema', receipt);
      if (fault === 'before-receipt') throw new Error('injected-before-receipt');
      this.service.db
        .transaction(() => {
          this.service.db
            .prepare(
              "UPDATE managed_source_operations SET receipt_json=?,phase='delivered' WHERE pod_id=?",
            )
            .run(canonical(receipt), podId);
          this.service.db
            .prepare('UPDATE managed_results SET source_json=? WHERE pod_id=?')
            .run(canonical([receipt]), podId);
          this.service.db
            .prepare("UPDATE managed_pods SET state='complete' WHERE pod_id=?")
            .run(podId);
          new ManagedControls(this.service).event(
            this.service.row(installation, podId),
            'source-delivered',
            'complete',
          );
        })
        .immediate();
      if (fault === 'after-receipt') throw new Error('injected-after-receipt');
      return {
        schemaVersion: 1,
        status: 'delivered',
        receipts: [receipt],
        reason: 'verified-source-delivered',
      };
    };
    const promise = run();
    this.running.set(podId, promise);
    try {
      return await promise;
    } finally {
      this.running.delete(podId);
    }
  }
}
