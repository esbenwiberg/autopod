---
title: "Canonicalize council findings and lifecycle provenance"
touches:
  - packages/shared/src/types/validation.ts
  - packages/daemon/src/validation/review-synthesizer.ts
  - packages/daemon/src/validation/review-synthesizer.test.ts
  - packages/daemon/src/validation/review-batch-runner.ts
  - packages/daemon/src/validation/review-batch-runner.test.ts
  - packages/daemon/src/validation/review-ledger.ts
  - packages/daemon/src/validation/review-ledger.test.ts
  - packages/daemon/src/validation/local-validation-engine.ts
  - packages/daemon/src/validation/local-validation-engine.test.ts
does_not_touch:
  - packages/desktop/
---

## Task

Make the review council's canonical authority explicit. Healthy councils must show and persist structured canonical findings, with initial first-gate findings retained as provenance rather than duplicate active cards. Degraded councils must preserve unmatched initial findings as visible fail-closed fallback blockers.

Add durable review quality/degradation metadata, source-aware ledger reconciliation, and accurate fixed-resolution metadata.

## Required Behavior

- Add optional `quality: healthy|degraded` and bounded degradation reasons to new batches.
- Healthy requires all five valid axes, stable HEAD, valid exhaustive synthesis, and canonicalization of every initial finding.
- Run synthesis through the structured response/retry boundary from Brief 01.
- Permit a synthesis merge to include initial and structured sources only when at least one source is structured and every displayed field is source-backed by a structured source.
- Never allow a standalone initial finding in a healthy canonical result.
- Mark unmatched initial findings as degraded first-gate fallback blockers.
- Build healthy ledger input from canonical accepted findings and complete provenance source sets; do not separately insert merged initial records.
- In degraded mode, conservatively retain valid structured candidates and unmatched initial fallback blockers.
- Reconcile prior raw initial records to later canonical structured records through unique provenance overlap without producing fixed-plus-new duplicates.
- Ambiguous provenance overlap fails closed.
- Add durable fixed resolution metadata with reviewed HEAD, optional repair diff hash, and verbatim closure evidence.
- Clear current fixed treatment when a finding regresses.

## Constraints

- Synthesis remains consolidation, not review: no invented paths, claims, severity, evidence, or remediation.
- Every candidate is addressed exactly once using known source IDs.
- Initial blockers may not disappear merely because synthesis is malformed or an axis is missing.
- Existing historical batches and ledgers remain readable.
- No validation-result database migration.
- Keep closure evidence bounded and require it to occur in the frozen repair delta.

## Test Expectations

- Initial plus structured duplicate becomes one canonical structured ledger entry carrying both source IDs.
- A healthy council contains no standalone initial record.
- An unmatched initial record marks the council degraded and remains an active fallback blocker.
- Invalid synthesis is retried once, then produces deterministic degraded fallback.
- Synthesis cannot invent or alter source-backed fields and must be exhaustive.
- Raw initial identity migrates to canonical structured identity through unique provenance without duplicate lifecycle records.
- Ambiguous source overlap does not merge unrelated records.
- Fixed resolution stores the exact reviewed HEAD/evidence and only follows completed valid closure verification.
- A fixed finding that reappears becomes regressed and no longer presents current fixed resolution.

## Wrap-up

Run focused synthesis, batch, ledger, and local validation tests, then the full daemon test package. Commit and push before completion.
