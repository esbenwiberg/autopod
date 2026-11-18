import { parseManagedRecord } from '@autopod/shared';
import type Database from 'better-sqlite3';
import { digest } from '../managed/canonical.js';
import { managedGit } from '../managed/source-git.js';
import {
  type CombinedPolicy,
  combinedPolicyDigest,
  type Role,
  type SignedGateReceipt,
  verifyGateReceipt,
} from './combined-attestation.js';
import type { ContinuationCheckpoint } from './continuations.js';

type Subject = Omit<ContinuationCheckpoint, 'evidenceDigest'>;
export type CandidateRef = Readonly<{ startKey: string; candidateDigest: string }>;
type Gate = (
  subject: Readonly<Subject>,
  mirror: string,
  inputDigest: string,
) => Promise<SignedGateReceipt>;
/** Host-selected trusted backends, not controller operations. Each must return the binding
 * from its actual evaluation, not relabel a previous receipt with the supplied digest. */
export interface CombinedGates {
  policy: CombinedPolicy;
  checks: Gate;
  independentReview: Gate;
}

export function combinedVerifier(
  db: Database.Database,
  inputs: readonly [CandidateRef, CandidateRef],
  gates: CombinedGates,
) {
  const refs = structuredClone(inputs);
  const policy = structuredClone(gates.policy);
  const selected = { checks: gates.checks, independentReview: gates.independentReview };
  return async (subject: Readonly<Subject>, mirror: string) => {
    if (combinedPolicyDigest(policy) !== subject.policyDigest)
      throw new Error('combined-policy-mismatch');
    if (refs.length !== 2 || refs[0].startKey === refs[1].startKey)
      throw new Error('combined-inputs-required');
    const lookup =
      db.prepare(`SELECT p.pod_id,p.dispatcher_attempt_id,p.execution_spec_digest,s.candidate_json
      FROM orchestration_continuations c JOIN managed_pods p ON p.pod_id=c.pod_id AND p.managed_start_key=c.start_key
      AND p.dispatcher_installation_id=('native.'||c.run_id) AND p.execution_spec_digest=json_extract(c.request_json,'$.executionSpecDigest')
      JOIN managed_source_candidates s ON s.pod_id=p.pod_id WHERE c.run_id=? AND c.start_key=?
      AND json_extract(c.checkpoint_json,'$.commit')=? AND p.observed_exit=1 AND p.revoked=0 AND p.stop_requested=0 AND p.state='validated'`);
    const parents = refs.map((ref) => {
      const row = lookup.get(subject.run, ref.startKey, subject.predecessor) as
        | {
            pod_id: string;
            dispatcher_attempt_id: string;
            execution_spec_digest: string;
            candidate_json: string;
          }
        | undefined;
      if (!row) throw new Error('combined-input-unavailable');
      const { candidateDigest, ...body } = parseManagedRecord(
        'SourceCandidateReceiptSchema',
        JSON.parse(row.candidate_json),
      );
      if (
        digest(body) !== candidateDigest ||
        candidateDigest !== ref.candidateDigest ||
        body.repository !== subject.repository ||
        body.podId !== row.pod_id ||
        body.dispatcherAttemptId !== row.dispatcher_attempt_id ||
        body.executionSpecDigest !== row.execution_spec_digest
      )
        throw new Error('combined-input-binding');
      return body.newCommit;
    });
    // Bind the exact two-parent clean merge, not just any descendant containing both tips.
    if (
      (await managedGit(mirror, ['show', '-s', '--format=%P', subject.commit])) !==
        parents.join(' ') ||
      (await managedGit(mirror, ['merge-base', '--all', ...parents])) !== subject.predecessor ||
      (await managedGit(mirror, ['merge-tree', '--write-tree', ...parents])) !== subject.tree
    )
      throw new Error('combined-source-mismatch');
    const inputDigest = digest({ subject, inputs: refs });
    const check = async (role: Role) =>
      verifyGateReceipt(
        policy,
        role,
        inputDigest,
        await selected[role](subject, mirror, inputDigest),
      );
    const checks = await check('checks');
    const independentReview = await check('independentReview');
    return {
      subjectDigest: digest(subject),
      inputs: refs,
      inputDigest,
      gatePolicy: policy,
      checks,
      independentReview,
    };
  };
}
