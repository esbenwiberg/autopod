import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { canonical, digest, sha256 } from '../managed/canonical.js';
import type { ManagedPodService } from '../managed/managed-service.js';
import { MAX_CANDIDATE_BYTES, managedGit } from '../managed/source-git.js';
import type { ProfileLlmClient } from '../providers/llm-client.js';
import { type CandidateRef, type CombinedGates, combinedVerifier } from './combined-checkpoint.js';
import { type ContinuationCheckpoint, OrchestrationContinuations } from './continuations.js';
import { type ControllerConfig, tickController } from './controller-turns.js';
import type { ResultWake } from './run-waves.js';

import { UnknownOutcomes } from './unknown-outcomes.js';

type Subject = Omit<ContinuationCheckpoint, 'evidenceDigest'>;
const oid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const hash = /^sha256:[a-f0-9]{64}$/;
interface Verification {
  subjectDigest: string;
  checks: { status: 'passed' | 'failed'; receiptDigest: string };
  independentReview: { status: 'passed' | 'failed'; receiptDigest: string };
}
// This callback is a trusted host dependency, never a request field. Digests bind the
// result to the source and policy; a digest by itself does not confer verification.
type Verify = (subject: Readonly<Subject>, privateMirror: string) => Promise<Verification>;
type ComposeLocal = (
  checkpoint: Readonly<ContinuationCheckpoint>,
  privateMirror: string,
) => ManagedPodService;
function requirePass(subject: Subject, v: Verification) {
  if (
    v.subjectDigest !== digest(subject) ||
    ![v.checks, v.independentReview].every(
      (r) => r.status === 'passed' && hash.test(r.receiptDigest),
    )
  )
    throw new Error('checkpoint-verification-required');
}

/** Offline composition only. Caller supplies a private host scratch directory and an executor
 * that makes independent worker copies before returning; never mount the scratch mirror. */
export class LocalCheckpointHost {
  readonly ledger: OrchestrationContinuations;
  readonly interventions: UnknownOutcomes;
  constructor(
    private readonly db: Database.Database,
    private readonly scratch: string,
    compose: ComposeLocal,
  ) {
    this.ledger = new OrchestrationContinuations(db, async (cp, use) => {
      const { evidenceDigest, ...subject } = cp;
      const row = db
        .prepare(
          'SELECT manifest,bundle FROM orchestration_checkpoint_custody WHERE run_id=? AND evidence_digest=?',
        )
        .get(cp.run, evidenceDigest) as { manifest: string; bundle: Buffer } | undefined;
      if (!row) throw new Error('checkpoint-custody-missing');
      // Bind the exact retained record before interpreting its contents.
      if (sha256(row.manifest) !== evidenceDigest) throw new Error('checkpoint-custody-integrity');
      const manifest = JSON.parse(row.manifest) as {
        version: number;
        subject: Subject;
        bundleDigest: string;
        verification: Verification;
      };
      if (
        manifest.version !== 1 ||
        canonical(manifest.subject) !== canonical(subject) ||
        manifest.bundleDigest !== sha256(row.bundle)
      )
        throw new Error('checkpoint-custody-integrity');
      requirePass(subject, manifest.verification);
      return this.withMirror(subject, row.bundle, (mirror) => use(compose(cp, mirror)));
    });
    this.interventions = new UnknownOutcomes(db, this.ledger);
  }
  /** One host scheduler turn, after managed result collection or restart. No waiting worker. */
  async tick(run: string, controller: (wake: ResultWake) => Promise<void>) {
    await this.ledger.waves.dispatch(run, controller);
    return this.ledger.recover(run);
  }
  /** Opt-in model-backed turn. Caller selects an approved client; never discovers credentials. */
  tickController(run: string, config: ControllerConfig, client: ProfileLlmClient) {
    return tickController(this.db, this.ledger, run, config, client);
  }
  /** Host-only: qualify an unpublished two-worker integration, without advancing or charging. */
  retainCombined(
    input: Subject,
    bytes: Buffer,
    inputs: readonly [CandidateRef, CandidateRef],
    gates: CombinedGates,
  ) {
    return this.retain(input, bytes, combinedVerifier(this.db, inputs, gates));
  }
  async retain(input: Subject, bytes: Buffer, verify: Verify): Promise<ContinuationCheckpoint> {
    const subject = Object.freeze({ ...input });
    if (!bytes.length || bytes.length > MAX_CANDIDATE_BYTES)
      throw new Error('checkpoint-bundle-size');
    const bundle = Buffer.from(bytes);
    const current = () =>
      this.db
        .prepare(
          `SELECT 1 FROM orchestration_runs WHERE id=? AND repository=? AND policy_digest=? AND accepted_commit=? AND canceled=0`,
        )
        .get(subject.run, subject.repository, subject.policyDigest, subject.predecessor);
    if (!current()) throw new Error('checkpoint-run-mismatch');
    const verification = await this.withMirror(subject, bundle, (mirror) =>
      verify(subject, mirror),
    );
    requirePass(subject, verification);
    const manifest = canonical({ version: 1, subject, bundleDigest: sha256(bundle), verification });
    const evidenceDigest = sha256(manifest);
    this.db
      .transaction(() => {
        if (!current()) throw new Error('checkpoint-run-mismatch');
        this.db
          .prepare(
            `INSERT INTO orchestration_checkpoint_custody(run_id,evidence_digest,manifest,bundle) VALUES(?,?,?,?) ON CONFLICT(run_id,evidence_digest) DO NOTHING`,
          )
          .run(subject.run, evidenceDigest, manifest, bundle);
      })
      .immediate();
    return { ...subject, evidenceDigest };
  }
  private async withMirror<T>(
    subject: Readonly<Subject>,
    bundle: Buffer,
    use: (mirror: string) => Promise<T>,
  ): Promise<T> {
    const { commit, tree, predecessor } = subject;
    if (
      ![commit, tree, predecessor].every((id) => oid.test(id) && id.length === commit.length) ||
      predecessor === commit
    )
      throw new Error('checkpoint-oid-binding');
    await mkdir(this.scratch, { recursive: true, mode: 0o700 });
    const dir = await mkdtemp(path.join(this.scratch, 'restore-'));
    try {
      const file = path.join(dir, 'source.bundle');
      const mirror = path.join(dir, 'mirror.git');
      await writeFile(file, bundle, { flag: 'wx', mode: 0o600 });
      await managedGit(dir, [
        'init',
        '--bare',
        '-b',
        'main',
        `--object-format=${commit.length === 40 ? 'sha1' : 'sha256'}`,
        mirror,
      ]);
      // Import objects only. Never install bundle-supplied refs, remotes, or Git config.
      const heads = await managedGit(mirror, ['bundle', 'unbundle', file]);
      if (
        !heads.split('\n').includes(`${commit} HEAD`) ||
        (await managedGit(mirror, ['rev-parse', `${commit}^{commit}`])) !== commit ||
        (await managedGit(mirror, ['rev-parse', `${commit}^{tree}`])) !== tree
      )
        throw new Error('checkpoint-source-mismatch');
      await managedGit(mirror, ['merge-base', '--is-ancestor', predecessor, commit]);
      await managedGit(mirror, ['fsck', '--strict', '--no-reflogs', commit]);
      await managedGit(mirror, ['update-ref', 'refs/heads/main', commit]);
      return await use(mirror);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
