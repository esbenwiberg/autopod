import { parseManagedRecord } from '@autopod/shared';
import type Database from 'better-sqlite3';
import { digest, sha256 } from '../managed/canonical.js';
import { MAX_CANDIDATE_BYTES } from '../managed/source-git.js';
import { type CandidatePathAllowance, validateCandidatePathScope } from './candidate-path-scope.js';
import { withVerifiedCheckpointMirror } from './local-checkpoints.js';

export interface ParentCandidateSelection {
  requestKey: string;
  candidateDigest: string;
}

interface CandidateRow {
  pod_id: string;
  dispatcher_attempt_id: string;
  execution_spec_digest: string;
  repository: string;
  base_commit: string;
  candidate_json: string | null;
  bundle: Buffer | null;
  source_json: string;
  authority_json: string;
}

/** Host-only lookup. Does not accept source bytes or authorize import, integration, or publication. */
export function readParentCandidate(
  db: Database.Database,
  run: string,
  selection: Readonly<ParentCandidateSelection>,
) {
  const row = db
    .prepare(`
    SELECT p.pod_id, p.dispatcher_attempt_id, p.execution_spec_digest,
      r.repository, r.accepted_commit AS base_commit,
      CASE WHEN length(CAST(s.candidate_json AS BLOB))<=16384 THEN s.candidate_json END AS candidate_json,
      CASE WHEN length(s.bundle) BETWEEN 1 AND ? THEN s.bundle END AS bundle,
      json_extract(c.request_json,'$.outputs.source') AS source_json,
      json_array(
        r.id, r.repository, r.policy_digest, r.accepted_commit, r.accepted_evidence,
        b.pod_id, b.launch_digest, b.policy_digest, b.policy_json, b.current_attempt,
        origin.attempt, origin.generation, origin.container_id,
        active.attempt, active.generation, active.container_id,
        q.request_key, q.start_key, q.input_digest,
        c.operation_digest, c.checkpoint_json, c.request_json, c.reserved_requests,
        p.pod_id, p.dispatcher_attempt_id, p.execution_spec_digest, p.profile_snapshot_digest,
        p.grant_id, p.grant_revision, p.effective_grant_digest, p.request_json, p.runtime_ref
      ) AS authority_json
    FROM parent_managed_requests q
    JOIN parent_managed_runs b ON b.run_id=q.run_id
    -- Historical work survives reconnect; origin must still belong to this run.
    JOIN parent_managed_sessions origin ON origin.attempt=q.parent_attempt AND origin.run_id=b.run_id
    LEFT JOIN parent_managed_sessions active ON active.attempt=b.current_attempt AND active.run_id=b.run_id
    JOIN orchestration_runs r ON r.id=b.run_id
    JOIN orchestration_continuations c ON c.run_id=q.run_id AND c.start_key=q.start_key
    JOIN managed_pods p ON p.pod_id=c.pod_id AND p.dispatcher_installation_id=('native.'||r.id)
      AND p.dispatcher_attempt_id=c.attempt_id AND p.managed_start_key=c.start_key
      AND p.execution_spec_digest=json_extract(c.request_json,'$.executionSpecDigest')
    JOIN managed_source_candidates s ON s.pod_id=p.pod_id
    WHERE q.run_id=? AND q.request_key=? AND r.canceled=0
      AND (b.current_attempt IS NULL OR active.attempt IS NOT NULL)
      AND json_extract(c.checkpoint_json,'$.repository')=r.repository
      AND json_extract(c.checkpoint_json,'$.policyDigest')=r.policy_digest
      AND json_extract(c.checkpoint_json,'$.commit')=r.accepted_commit
      AND json_extract(c.checkpoint_json,'$.evidenceDigest')=r.accepted_evidence
      AND json_extract(c.request_json,'$.outputs.source.mode')='commit'
      AND p.observed_exit=1 AND p.exit_code=0 AND p.state='validated'
      AND p.revoked=0 AND p.stop_requested=0
  `)
    .get(MAX_CANDIDATE_BYTES, run, selection.requestKey) as CandidateRow | undefined;
  if (!row?.candidate_json || !row.bundle) throw new Error('parent-candidate-unavailable');
  const receipt = parseManagedRecord(
    'SourceCandidateReceiptSchema',
    JSON.parse(row.candidate_json),
  );
  const { candidateDigest, ...body } = receipt;
  const source = JSON.parse(row.source_json);
  if (
    candidateDigest !== selection.candidateDigest ||
    candidateDigest !== digest(body) ||
    sha256(row.bundle) !== receipt.evidenceDigest ||
    receipt.podId !== row.pod_id ||
    receipt.dispatcherAttemptId !== row.dispatcher_attempt_id ||
    receipt.executionSpecDigest !== row.execution_spec_digest ||
    receipt.repository !== row.repository ||
    receipt.repository !== source.repository ||
    receipt.remote !== source.remote ||
    receipt.base !== source.base ||
    receipt.head !== source.head ||
    receipt.newCommit === row.base_commit
  )
    throw new Error('parent-candidate-binding');
  return {
    receipt,
    bundle: row.bundle,
    base: row.base_commit,
    authorityDigest: sha256(row.authority_json),
  };
}

/** Bounded private verification only. Caller must supply the host-selected scope and tree. */
export async function inspectParentCandidate(
  db: Database.Database,
  scratch: string,
  run: string,
  input: Readonly<
    ParentCandidateSelection & {
      expectedTree: string;
      allowlist: readonly CandidatePathAllowance[];
    }
  >,
) {
  const selection = structuredClone(input);
  const { receipt, bundle, base, authorityDigest } = readParentCandidate(db, run, selection);
  const scoped = await withVerifiedCheckpointMirror(
    scratch,
    { predecessor: base, commit: receipt.newCommit, tree: selection.expectedTree },
    bundle,
    (mirror) =>
      validateCandidatePathScope({
        repository: mirror,
        base,
        candidate: receipt.newCommit,
        expectedTree: selection.expectedTree,
        allowlist: selection.allowlist,
      }),
  );

  // Inspection returns a snapshot, not an admission or reusable capability.
  // A stopped child or changed accepted checkpoint may have invalidated the read.
  if (readParentCandidate(db, run, selection).authorityDigest !== authorityDigest)
    throw new Error('parent-candidate-stale');
  return { ...scoped, receipt, scopeDigest: digest(selection.allowlist) };
}
