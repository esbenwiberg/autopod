# 007 — Deterministic selector with one fuzzy boundary

## Claim
The selector is a pure function. The fuzzy step (text → envelope) is isolated at the boundary; everything downstream is unit-testable.

## Context
Pod tasks are natural language; selection of context should be reproducible. Claiming "fully deterministic" is dishonest — somewhere a fuzzy step lives. The honest move is to NAME the boundary and test each side appropriately.

## Decision
- The **envelope** is the boundary artifact: `{files, subsystems, tags}` (extensible later, but minimal at v0).
- Three envelope producers, in order of preference:
  1. **Mechanical** — worktree diff → `files`; path mapping → `subsystems`. No LLM.
  2. **Human-authored** during `/prep` interview.
  3. **LLM-extracted** from prose, with a closed-vocabulary schema validator.
- Below the boundary the selector is pure SQL/code:
  - Unit-testable as a function.
  - Golden-regression-testable against fixture envelopes.
  - Per-link-type traversal: `refines / supersedes / implements` walk to fixpoint (with cycle guard); `related / contradicts` zero hops unless tag-matched.
  - Relevance scoring with a token budget, NOT uniform hop counts.

## Constraint
- `tags` and `subsystems` are **closed-vocabulary**. New value requires explicit taxonomy-update PR. This makes drift surface as a visible action, not silent rot.
- **Drop `flows` from the envelope** (or demote to a free-text hint the selector ignores). Premortem 3.6 showed it's not extractable with useful F1.

## Rejected alternatives
- **Fully LLM-driven retrieval** — not testable, no audit trail, can't reproduce.
- **Vector embedding retrieval** — fuzzy, can't explain why an atom was matched, biases toward semantic similarity not relevance.
- **Uniform one-hop graph walk** — premortem 3.7 showed it's wrong-sized; needs per-link-type behavior or it becomes a knob factory.
- **"Fully deterministic" claim** — dishonest; the envelope production step is fuzzy and we own that.

## Open follow-up
- Concrete relevance scoring formula. Candidates: weighted sum of (anchor specificity, tag overlap, link distance, recency). Tune against ablation data once available.

## Provenance
Synthesized from premortem deep-dives 3.6 + 3.7 + chat with Esben, 2026-05-28.
