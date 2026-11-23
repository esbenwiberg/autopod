import type { ManagedPodRequest } from '@autopod/shared';
import { canonical, digest } from '../managed/canonical.js';
import type { ManagedContainerRuntime } from '../managed/container-runtime.js';
import { signalLocalRun } from '../managed/local-run-signals.js';
import type { ManagedPodService } from '../managed/managed-service.js';
import {
  assertPrivateParentCommit,
  isPrivateSubmission,
} from '../managed/private-commit-policy.js';
import type { ParentDeltaSource } from './anchored-delegation-source.js';
import type { ContinuationCheckpoint } from './continuations.js';
import {
  assertClosedParentCandidate,
  retainParentWorkerCandidate,
} from './parent-candidate-custody.js';
import { buildParentSubmissionHead } from './parent-private-submission.js';

export function parentPrivateCompletion(
  service: ManagedPodService,
  runtime: Pick<ManagedContainerRuntime, 'exportPrivateHead'> &
    Partial<Pick<ManagedContainerRuntime, 'readPrivateSubmission'>>,
  scratch: string,
  checkpoint: Readonly<ContinuationCheckpoint>,
  paths: readonly string[],
  onComplete?: () => void,
  secondPaths?: readonly string[],
  delta?: ParentDeltaSource,
): NonNullable<ManagedPodService['privateCommit']> {
  const { run, repository, commit, evidenceDigest, policyDigest } = checkpoint;
  const owner = `native.${run}`;
  const scopes = [paths, ...(secondPaths ? [secondPaths] : [])].map((names) =>
    names.map((path) => ({ kind: 'file' as const, path })),
  );
  const target = secondPaths ? 'sandbox' : 'local';
  const db = service.db;
  const plan = db.prepare(`
    SELECT q.request_key, c.request_json, c.pod_id, q.private_scope_json
    FROM parent_managed_requests q
    -- Custody of already-commissioned work depends on the durable run, not
    -- a live parent token. The parent may exit or reconnect before its child.
    JOIN parent_managed_sessions origin ON origin.attempt=q.parent_attempt AND origin.run_id=q.run_id
    JOIN orchestration_runs r ON r.id=q.run_id
    JOIN orchestration_continuations c ON c.run_id=q.run_id AND c.start_key=q.start_key
    WHERE q.run_id=? AND q.start_key=?
      AND r.canceled=0 AND r.repository=? AND r.accepted_commit=?
      AND r.accepted_evidence=? AND r.policy_digest=?`);
  function authorize(installation: string | undefined, request: ManagedPodRequest) {
    if (installation !== owner) throw new Error('parent-private-commit-owner-required');
    assertPrivateParentCommit(request, repository, commit, target);
    const row = plan.get(run, request.startKey, repository, commit, evidenceDigest, policyDigest) as
      | {
          request_key: string;
          request_json: string;
          pod_id: string | null;
          private_scope_json: string | null;
        }
      | undefined;
    const allowlist = scopes.find((scope) => canonical(scope) === row?.private_scope_json);
    if (!row || !allowlist || canonical(JSON.parse(row.request_json)) !== canonical(request))
      throw new Error('parent-private-commit-not-reserved');
    return { ...row, allowlist };
  }
  return {
    authorize(installation, request, proposal) {
      // This flag is never supplied by ingress or start(). Actual allocation
      // still requires the frozen parent request and continuation to exist.
      if (proposal) {
        if (installation !== owner) throw new Error('parent-private-commit-owner-required');
        assertPrivateParentCommit(request, repository, commit, target);
        return;
      }
      authorize(installation, request);
    },
    assertSubmittedCleanup(installation, podId) {
      if (installation !== owner) throw new Error('parent-private-commit-owner-required');
      const worker = service.row(installation, podId);
      const request = JSON.parse(worker.request_json) as ManagedPodRequest;
      if (!isPrivateSubmission(request) || worker.state !== 'complete')
        throw new Error('parent-private-cleanup-custody-required');
      assertPrivateParentCommit(request, repository, commit, 'sandbox');
      const row = db
        .prepare(`SELECT q.request_key, q.private_scope_json,
        json_extract(c.candidate_json,'$.candidateDigest') AS candidate_digest
        FROM parent_managed_requests q
        JOIN orchestration_continuations x ON x.run_id=q.run_id AND x.start_key=q.start_key
        JOIN parent_private_candidates c ON c.pod_id=x.pod_id
        WHERE q.run_id=? AND q.start_key=? AND x.pod_id=?`)
        .get(run, worker.managed_start_key, podId) as
        | {
            request_key: string;
            private_scope_json: string;
            candidate_digest: string;
          }
        | undefined;
      const scope = scopes.find((entry) => canonical(entry) === row?.private_scope_json);
      if (!row || !scope) throw new Error('parent-private-cleanup-custody-required');
      assertClosedParentCandidate(
        db,
        run,
        {
          requestKey: row.request_key,
          candidateDigest: row.candidate_digest,
        },
        podId,
        digest(scope),
      );
    },
    async finish(installation, podId) {
      const row = service.row(installation, podId);
      const request = JSON.parse(row.request_json) as ManagedPodRequest;
      const current = () => {
        const admitted = authorize(installation, request);
        const worker = service.row(installation, podId);
        if (
          admitted.pod_id !== podId ||
          worker.runtime_ref !== row.runtime_ref ||
          worker.request_json !== row.request_json ||
          worker.revoked ||
          worker.stop_requested ||
          worker.cleanup !== 'not-requested' ||
          !worker.observed_exit ||
          worker.exit_code !== 0 ||
          worker.state !== 'validating'
        )
          throw new Error('parent-private-commit-worker-stale');
        return admitted;
      };
      const { request_key: requestKey, allowlist } = db
        .transaction(() => {
          const admitted = current();
          const retained = db
            .prepare('SELECT 1 FROM parent_private_candidates WHERE pod_id=?')
            .get(podId);
          if (
            !retained &&
            !db
              .prepare('INSERT OR IGNORE INTO parent_private_collection_claims VALUES (?)')
              .run(podId).changes
          )
            throw new Error('parent-private-collection-uncertain');
          return admitted;
        })
        .immediate();
      const collector: Pick<ManagedContainerRuntime, 'exportPrivateHead'> = isPrivateSubmission(
        request,
      )
        ? {
            async exportPrivateHead(ref, binding, assertCurrent) {
              if (!runtime.readPrivateSubmission)
                throw new Error('parent-private-submission-unavailable');
              const bytes = await runtime.readPrivateSubmission(
                ref,
                binding.podId,
                binding.specDigest,
                assertCurrent,
              );
              return buildParentSubmissionHead(
                db,
                scratch,
                checkpoint,
                allowlist,
                bytes,
                binding.maxBytes,
                assertCurrent,
                delta,
              );
            },
          }
        : runtime;
      await retainParentWorkerCandidate(
        db,
        scratch,
        collector,
        run,
        requestKey,
        allowlist,
        undefined,
        current,
        delta,
      );
      db.transaction(() => {
        current();
        db.prepare("UPDATE managed_pods SET state='complete' WHERE pod_id=?").run(podId);
        onComplete?.();
      }).immediate();
      signalLocalRun(db, owner);
    },
  };
}
