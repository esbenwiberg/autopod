import type { RunGit } from './bare-push.js';

/** Upper bound on predecessor commits the proof will account for (fail closed beyond). */
export const REBASE_PROOF_MAX_COMMITS = 500;

export interface RebaseRewriteProofInput {
  /** Branch tip being replaced (the host bare's branch before the push). */
  predecessor: string;
  /** Proposed replacement tip (the container's rewritten HEAD). */
  candidate: string;
  /** Base ref in the same repository, e.g. `refs/remotes/origin/main`. */
  baseRef: string;
  /** Override for tests; defaults to {@link REBASE_PROOF_MAX_COMMITS}. */
  maxCommits?: number;
}

export interface RebaseRewriteEvidence {
  predecessor: string;
  candidate: string;
  baseRef: string;
  baseTip: string;
  /** merge-base(predecessor, baseTip). */
  predecessorFork: string;
  /** merge-base(candidate, baseTip). */
  candidateFork: string;
  /** Predecessor commits not in the candidate whose patch is in the candidate. */
  patchEquivalent: number;
  /** Predecessor commits matched by author identity, author date and subject. */
  fingerprintMatched: number;
}

export type RebaseRewriteProof =
  | ({ ok: true } & RebaseRewriteEvidence)
  | { ok: false; reason: string };

const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

/**
 * Decide, read-only, whether `candidate` is a rebase of `predecessor` that can
 * safely replace it as a branch tip.
 *
 * The proof accepts only a rewrite that
 *   1. never moves the branch backwards on its base:
 *      merge-base(predecessor, base) is an ancestor of (or equal to)
 *      merge-base(candidate, base); and
 *   2. accounts for every non-merge predecessor commit that the candidate does
 *      not contain — either a patch-equivalent commit exists on the candidate
 *      side (`git cherry` "-", which also covers commits that landed upstream),
 *      or a commit on the candidate side has the same author name, email, raw
 *      author date and subject (what `git rebase` preserves when a conflict is
 *      resolved). Each candidate commit is used at most once.
 *
 * The candidate does not have to contain the current base tip: the base ref may
 * have been refreshed by another pod since the rebase. Extra candidate commits
 * are permitted — they are new work that validation and review evaluate.
 *
 * Anything that cannot be proven (missing refs, unrelated history, squashed,
 * reworded or dropped commits, too many commits) is refused with a reason so
 * the caller keeps its existing fail-closed behaviour.
 */
export async function proveRebaseRewrite(
  runGit: RunGit,
  input: RebaseRewriteProofInput,
): Promise<RebaseRewriteProof> {
  const { predecessor, candidate, baseRef } = input;
  const maxCommits = input.maxCommits ?? REBASE_PROOF_MAX_COMMITS;
  const refuse = (reason: string): RebaseRewriteProof => ({ ok: false, reason });

  if (!OID.test(predecessor) || !OID.test(candidate)) return refuse('commit identity unavailable');
  if (predecessor === candidate) return refuse('predecessor and candidate are identical');

  const resolve = async (rev: string): Promise<string | null> => {
    const r = await runGit(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
    const oid = r.stdout.trim();
    return r.exitCode === 0 && OID.test(oid) ? oid : null;
  };
  const mergeBase = async (a: string, b: string): Promise<string | null> => {
    const r = await runGit(['merge-base', a, b]);
    const oid = r.stdout.trim();
    return r.exitCode === 0 && OID.test(oid) ? oid : null;
  };

  if (!(await resolve(predecessor))) return refuse('predecessor commit missing');
  if (!(await resolve(candidate))) return refuse('candidate commit missing');
  const baseTip = await resolve(baseRef);
  if (!baseTip) return refuse(`base ref ${baseRef} unavailable`);

  const [predecessorFork, candidateFork] = await Promise.all([
    mergeBase(predecessor, baseTip),
    mergeBase(candidate, baseTip),
  ]);
  if (!predecessorFork) return refuse('predecessor shares no history with the base');
  if (!candidateFork) return refuse('candidate shares no history with the base');
  if (predecessorFork !== candidateFork) {
    const forward = await runGit(['merge-base', '--is-ancestor', predecessorFork, candidateFork]);
    if (forward.exitCode === 1) return refuse('candidate moves the branch backwards on its base');
    if (forward.exitCode !== 0) return refuse('could not compare base fork points');
  }

  const cherry = await runGit(['cherry', candidate, predecessor]);
  if (cherry.exitCode !== 0) return refuse('could not compare predecessor commits');
  const lines = cherry.stdout.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length > maxCommits)
    return refuse(`more than ${maxCommits} predecessor commits to account for`);

  let patchEquivalent = 0;
  const unmatched: string[] = [];
  for (const line of lines) {
    const match = /^([+-]) ([a-f0-9]{40}|[a-f0-9]{64})$/.exec(line.trim());
    if (!match) return refuse('unexpected commit comparison output');
    if (match[1] === '-') patchEquivalent++;
    else unmatched.push(match[2] as string);
  }

  let fingerprintMatched = 0;
  if (unmatched.length > 0) {
    // %x1f separates fields; -z separates records so subjects can't break parsing.
    const format = '--format=%H%x1f%an%x1f%ae%x1f%ad%x1f%s';
    const [predecessorSide, candidateSide] = await Promise.all([
      runGit(['log', '-z', '--no-merges', '--date=raw', format, predecessor, `^${candidate}`]),
      runGit([
        'log',
        '-z',
        '--no-merges',
        '--date=raw',
        format,
        `--max-count=${maxCommits * 2 + 1}`,
        candidate,
        `^${predecessor}`,
      ]),
    ]);
    if (predecessorSide.exitCode !== 0 || candidateSide.exitCode !== 0)
      return refuse('could not read commit identities');
    const parse = (stdout: string) =>
      stdout
        .split('\0')
        .map((record) => record.replace(/^\n/, ''))
        .filter((record) => record.length > 0)
        .map((record) => {
          const [oid = '', ...rest] = record.split('\x1f');
          return { oid, fingerprint: rest.join('\x1f') };
        });
    const fingerprints = new Map(
      parse(predecessorSide.stdout).map((entry) => [entry.oid, entry.fingerprint]),
    );
    const candidatePool = new Map<string, number>();
    for (const { fingerprint } of parse(candidateSide.stdout))
      candidatePool.set(fingerprint, (candidatePool.get(fingerprint) ?? 0) + 1);
    for (const oid of unmatched) {
      const fingerprint = fingerprints.get(oid);
      const available = fingerprint ? (candidatePool.get(fingerprint) ?? 0) : 0;
      if (!fingerprint || available === 0)
        return refuse(
          `predecessor commit ${oid.slice(0, 12)} is not accounted for by the candidate`,
        );
      candidatePool.set(fingerprint, available - 1);
      fingerprintMatched++;
    }
  }

  return {
    ok: true,
    predecessor,
    candidate,
    baseRef,
    baseTip,
    predecessorFork,
    candidateFork,
    patchEquivalent,
    fingerprintMatched,
  };
}
