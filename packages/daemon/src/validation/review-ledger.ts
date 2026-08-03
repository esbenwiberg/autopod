import type {
  ReviewBatchResult,
  ReviewClosureVerification,
  ReviewFindingCandidate,
  ReviewFindingLedgerEntry,
} from '@autopod/shared';

function sourceIds(finding: ReviewFindingCandidate): string[] {
  return [finding.id];
}

/** Old packets did not retain a ledger; their accepted findings are active conservatively. */
export function seedReviewLedger(batch: ReviewBatchResult | undefined): ReviewFindingLedgerEntry[] {
  if (!batch) return [];
  if (batch.ledger) return batch.ledger;
  return batch.accepted.map((finding) => ({
    semanticId: finding.id,
    finding,
    state: 'open' as const,
    priorSourceIds: sourceIds(finding),
    currentSourceIds: sourceIds(finding),
  }));
}

export function activeLedgerEntries(
  batch: ReviewBatchResult | undefined,
): ReviewFindingLedgerEntry[] {
  return seedReviewLedger(batch).filter((entry) => entry.state !== 'fixed');
}

/**
 * Reconciles only canonical synthesized findings. Closure is deliberately opt-in:
 * an absent, malformed, or unavailable verifier can never create a fixed entry.
 */
export function reconcileReviewLedger(
  priorBatch: ReviewBatchResult | undefined,
  current: ReviewFindingCandidate[],
  closure: ReviewClosureVerification | undefined,
): ReviewFindingLedgerEntry[] {
  const prior = seedReviewLedger(priorBatch);
  const currentById = new Map(current.map((finding) => [finding.id, finding]));
  const decisions = new Map(
    closure?.status === 'completed'
      ? closure.decisions.map((decision) => [decision.semanticId, decision])
      : [],
  );
  const out: ReviewFindingLedgerEntry[] = [];
  for (const entry of prior) {
    const now = currentById.get(entry.semanticId);
    if (now) {
      out.push({
        ...entry,
        finding: now,
        state: entry.state === 'fixed' ? 'regressed' : 'open',
        priorSourceIds: entry.currentSourceIds,
        currentSourceIds: sourceIds(now),
      });
      currentById.delete(entry.semanticId);
      continue;
    }
    if (entry.state === 'fixed') {
      out.push(entry);
      continue;
    }
    const decision = decisions.get(entry.semanticId);
    const fixed = decision?.fixed === true && Boolean(decision.evidence?.trim());
    out.push({
      ...entry,
      state: fixed ? 'fixed' : 'open',
      priorSourceIds: entry.currentSourceIds,
      currentSourceIds: [],
      ...(fixed ? { closureEvidence: decision.evidence?.slice(0, 8_000) } : {}),
    });
  }
  for (const finding of currentById.values()) {
    out.push({
      semanticId: finding.id,
      finding,
      state: 'new',
      priorSourceIds: [],
      currentSourceIds: sourceIds(finding),
    });
  }
  return out.sort((a, b) => a.semanticId.localeCompare(b.semanticId));
}

export function activeLedgerFindings(ledger: ReviewFindingLedgerEntry[]): ReviewFindingCandidate[] {
  return ledger.filter((entry) => entry.state !== 'fixed').map((entry) => entry.finding);
}

export function closurePrompt(prior: ReviewFindingLedgerEntry[], repairDelta: string): string {
  return `You are a read-only repair closure verifier. Return JSON only: {"decisions":[{"semanticId":"known id","fixed":true|false,"evidence":"frozen source-backed proof"}]}. Return exactly one decision for every known active finding and no others. A finding is fixed only when the supplied repair delta and frozen evidence prove it. Known findings: ${JSON.stringify(prior.filter((e) => e.state !== 'fixed'))}\nRepair delta:\n${repairDelta}`;
}

export function parseClosureVerification(
  stdout: string,
  prior: ReviewFindingLedgerEntry[],
): ReviewClosureVerification {
  try {
    const parsed: unknown = JSON.parse(stdout);
    const raw =
      parsed && typeof parsed === 'object' ? (parsed as { decisions?: unknown }).decisions : null;
    if (!Array.isArray(raw)) throw new Error('missing decisions');
    const expected = prior
      .filter((entry) => entry.state !== 'fixed')
      .map((entry) => entry.semanticId)
      .sort();
    const decisions = raw.map((value) => {
      if (!value || typeof value !== 'object') throw new Error('malformed decision');
      const d = value as Record<string, unknown>;
      if (typeof d.semanticId !== 'string' || typeof d.fixed !== 'boolean')
        throw new Error('malformed decision');
      if (d.fixed && (typeof d.evidence !== 'string' || !d.evidence.trim()))
        throw new Error('missing evidence');
      return {
        semanticId: d.semanticId,
        fixed: d.fixed,
        ...(typeof d.evidence === 'string' ? { evidence: d.evidence.slice(0, 8_000) } : {}),
      };
    });
    if (
      decisions
        .map((d) => d.semanticId)
        .sort()
        .join('\0') !== expected.join('\0')
    )
      throw new Error('omitted or invented finding ID');
    return { status: 'completed', decisions };
  } catch (error) {
    return {
      status: 'invalid',
      decisions: [],
      reason: error instanceof Error ? error.message : 'invalid closure response',
    };
  }
}
