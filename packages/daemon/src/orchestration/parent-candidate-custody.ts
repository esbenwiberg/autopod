import { parseManagedRecord } from '@autopod/shared';
import type Database from 'better-sqlite3';
import { digest, sha256 } from '../managed/canonical.js';
import type { ManagedContainerRuntime } from '../managed/container-runtime.js';
import { MAX_PRIVATE_HEAD_BYTES } from '../managed/private-head-export.js';
import { MAX_CANDIDATE_BYTES } from '../managed/source-git.js';
import { type ParentDeltaSource, restoreParentSource } from './anchored-delegation-source.js';
import { type CandidatePathAllowance, validateCandidatePathScope } from './candidate-path-scope.js';
import { withVerifiedCheckpointMirror } from './local-checkpoints.js';
import { verifyParentPrivateSource } from './parent-private-source.js';

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
  runtime_ref: string | null;
  scope_digest: string | null;
  tree: string | null;
  binding_digest: string | null;
  authority_json: string;
}

function readWorker(db: Database.Database, run: string, requestKey: string, canceled = false) {
  return db
    .prepare(`
    SELECT p.pod_id, p.dispatcher_attempt_id, p.execution_spec_digest,
      r.repository, r.accepted_commit AS base_commit,
      CASE WHEN length(CAST(s.candidate_json AS BLOB))<=16384 THEN s.candidate_json END AS candidate_json,
      CASE WHEN length(s.bundle) BETWEEN 1 AND ? THEN s.bundle END AS bundle,
      json_extract(c.request_json,'$.outputs.source') AS source_json,
      p.runtime_ref, s.scope_digest, s.tree, s.binding_digest,
      json_array(
        r.id, r.repository, r.policy_digest, r.accepted_commit, r.accepted_evidence,
        b.pod_id, b.launch_digest, b.policy_digest, b.policy_json,
        origin.attempt, origin.generation, origin.container_id,
        q.request_key, q.start_key, q.input_digest, q.private_scope_json,
        c.operation_digest, c.checkpoint_json, c.request_json, c.reserved_requests,
        p.pod_id, p.dispatcher_attempt_id, p.execution_spec_digest, p.profile_snapshot_digest,
        p.grant_id, p.grant_revision, p.effective_grant_digest, p.request_json, p.runtime_ref
      ) AS authority_json
    FROM parent_managed_requests q
    JOIN parent_managed_runs b ON b.run_id=q.run_id
    -- Historical work survives reconnect; origin must still belong to this run.
    JOIN parent_managed_sessions origin ON origin.attempt=q.parent_attempt AND origin.run_id=b.run_id
    JOIN orchestration_runs r ON r.id=b.run_id
    JOIN orchestration_continuations c ON c.run_id=q.run_id AND c.start_key=q.start_key
    JOIN managed_pods p ON p.pod_id=c.pod_id AND p.dispatcher_installation_id=('native.'||r.id)
      AND p.dispatcher_attempt_id=c.attempt_id AND p.managed_start_key=c.start_key
      AND p.execution_spec_digest=json_extract(c.request_json,'$.executionSpecDigest')
    LEFT JOIN parent_private_candidates s ON s.pod_id=p.pod_id
    WHERE q.run_id=? AND q.request_key=? AND r.canceled=?
      AND json_extract(c.checkpoint_json,'$.repository')=r.repository
      AND json_extract(c.checkpoint_json,'$.policyDigest')=r.policy_digest
      AND json_extract(c.checkpoint_json,'$.commit')=r.accepted_commit
      AND json_extract(c.checkpoint_json,'$.evidenceDigest')=r.accepted_evidence
      AND json_extract(c.request_json,'$.outputs.source.mode')='commit'
      AND json_extract(c.request_json,'$.outputs.source.remote')='private'
      AND p.observed_exit=1 AND p.exit_code=0 AND (p.state IN ('validating','validated') OR (p.state='complete' AND s.pod_id IS NOT NULL))
      AND p.revoked=0 AND p.stop_requested=0
  `)
    .get(MAX_CANDIDATE_BYTES, run, requestKey, canceled ? 1 : 0) as CandidateRow | undefined;
}

/** Host-only lookup. Does not accept source bytes or authorize publication. */
export function readParentCandidate(
  db: Database.Database,
  run: string,
  selection: Readonly<ParentCandidateSelection>,
) {
  return verifyRetainedRow(readWorker(db, run, selection.requestKey), selection);
}

/** Cleanup proof only. Canceled custody is not readable through delivery or qualification. */
export function assertClosedParentCandidate(
  db: Database.Database,
  run: string,
  selection: Readonly<ParentCandidateSelection>,
  podId: string,
  scopeDigest: string,
) {
  const row = readWorker(db, run, selection.requestKey, true);
  if (row?.pod_id !== podId || row.scope_digest !== scopeDigest)
    throw new Error('parent-private-cleanup-custody-required');
  verifyRetainedRow(row, selection);
}

function verifyRetainedRow(
  row: CandidateRow | undefined,
  selection: Readonly<ParentCandidateSelection>,
) {
  if (!row?.candidate_json || !row.bundle || !row.scope_digest || !row.tree)
    throw new Error('parent-candidate-unavailable');
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
    receipt.newCommit === row.base_commit ||
    row.binding_digest !== digest([row.authority_json, candidateDigest, row.scope_digest, row.tree])
  )
    throw new Error('parent-candidate-binding');
  return {
    receipt,
    bundle: row.bundle,
    base: row.base_commit,
    scopeDigest: row.scope_digest,
    tree: row.tree,
    authorityDigest: digest([
      row.authority_json,
      candidateDigest,
      receipt.evidenceDigest,
      row.scope_digest,
      row.tree,
    ]),
  };
}

/** Capture the host-enrolled scope before collection. Never accepts a worker-selected path. */
export async function retainParentWorkerCandidate(
  db: Database.Database,
  scratch: string,
  runtime: Pick<ManagedContainerRuntime, 'exportPrivateHead'>,
  run: string,
  requestKey: string,
  hostScope: readonly CandidatePathAllowance[],
  maxBytes = MAX_PRIVATE_HEAD_BYTES,
  assertCollectionAuthority: () => void = () => {},
  delta?: ParentDeltaSource,
) {
  const allowlist = structuredClone(hostScope);
  const scopeDigest = digest(allowlist);
  const row = readWorker(db, run, requestKey);
  if (!row?.runtime_ref) throw new Error('parent-candidate-unavailable');
  const source = JSON.parse(row.source_json);
  if (source.remote !== 'private' || source.repository !== row.repository)
    throw new Error('parent-candidate-binding');
  const assertCurrent = () => {
    assertCollectionAuthority();
    const current = readWorker(db, run, requestKey);
    if (
      !current ||
      current.runtime_ref !== row.runtime_ref ||
      current.pod_id !== row.pod_id ||
      current.execution_spec_digest !== row.execution_spec_digest ||
      current.authority_json !== row.authority_json
    )
      throw new Error('parent-candidate-stale');
    return current;
  };
  const replay = (existing: CandidateRow) => {
    if (!existing.candidate_json) return undefined;
    const { candidateDigest } = JSON.parse(existing.candidate_json);
    const candidate = readParentCandidate(db, run, { requestKey, candidateDigest });
    if (candidate.scopeDigest !== scopeDigest) throw new Error('parent-candidate-scope-mismatch');
    return candidate;
  };
  assertCollectionAuthority();
  const existing = replay(row);
  if (existing) return existing;

  const exported = await runtime.exportPrivateHead(
    row.runtime_ref,
    {
      podId: row.pod_id,
      specDigest: row.execution_spec_digest,
      repository: row.repository,
      base: row.base_commit,
      maxBytes,
    },
    assertCurrent,
  );
  const verified = await verifyParentPrivateSource(
    scratch,
    exported.bundle,
    {
      base: row.base_commit,
      commit: exported.commit,
      tree: exported.tree,
      allowlist,
      maxBundleBytes: maxBytes,
    },
    delta,
  );
  const body = {
    schemaVersion: 1,
    candidateId: `parent-private-${row.pod_id}`,
    podId: row.pod_id,
    dispatcherAttemptId: row.dispatcher_attempt_id,
    executionSpecDigest: row.execution_spec_digest,
    repository: row.repository,
    remote: source.remote,
    head: source.head,
    base: source.base,
    // The private transport has no remote predecessor or publishing lease.
    expectedOldCommit: '0'.repeat(40),
    newCommit: verified.commit,
    evidenceDigest: verified.bundleDigest,
  };
  const candidateDigest = digest(body);
  const receipt = parseManagedRecord('SourceCandidateReceiptSchema', { ...body, candidateDigest });
  return db
    .transaction(() => {
      const prior = replay(assertCurrent());
      if (prior) {
        if (prior.receipt.candidateDigest !== candidateDigest || prior.tree !== verified.tree)
          throw new Error('parent-candidate-conflict');
        return prior;
      }
      db.prepare(`INSERT INTO parent_private_candidates
      (pod_id,candidate_json,bundle,scope_digest,tree,binding_digest) VALUES (?,?,?,?,?,?)`).run(
        row.pod_id,
        JSON.stringify(receipt),
        verified.bundle,
        scopeDigest,
        verified.tree,
        digest([row.authority_json, candidateDigest, scopeDigest, verified.tree]),
      );
      return readParentCandidate(db, run, { requestKey, candidateDigest });
    })
    .immediate();
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
  delta?: ParentDeltaSource,
) {
  const selection = structuredClone(input);
  const { receipt, bundle, base, authorityDigest, scopeDigest, tree } = readParentCandidate(
    db,
    run,
    selection,
  );
  if (scopeDigest !== digest(selection.allowlist) || tree !== selection.expectedTree)
    throw new Error('parent-candidate-scope-mismatch');
  const scoped = await restoreParentSource(
    withVerifiedCheckpointMirror,
    delta,
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
        allowInheritedPublishedEntries: Boolean(delta),
      }),
  );

  // Inspection returns a snapshot, not an admission or reusable capability.
  // A stopped child or changed accepted checkpoint may have invalidated the read.
  if (readParentCandidate(db, run, selection).authorityDigest !== authorityDigest)
    throw new Error('parent-candidate-stale');
  return { ...scoped, receipt, scopeDigest: digest(selection.allowlist) };
}
