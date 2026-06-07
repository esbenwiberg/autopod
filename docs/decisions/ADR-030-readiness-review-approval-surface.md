# ADR-030: Readiness Review as the approval decision surface

## Status

Proposed

## Context

Autopod already stores release-relevant evidence across validation history,
required facts, advisory browser QA, action audit records, security scans,
network policy snapshots, denied egress events, PR state, quality scores, and
logs. The operator can inspect these surfaces, but approval still lacks a single
decision summary that says whether the pod is ready, needs human review, is
risky, or is being accepted through a waiver.

Several existing gaps are intentional. Advisory browser QA is evidence, not
validation. Security warning and scanner-error fail-open behavior should remain
soft. Side effects outside existing MCP actions, validation, PR, network, and
logs are not becoming a new audit domain in this feature.

Single-PR series add another constraint: the final PR represents work from
multiple member pods, so approval cannot truthfully use only the final pod's own
signals.

## Decision

Add Readiness Review as an advisory approval companion and the user-facing
approval decision surface.

The top-level statuses are:

- `ready` - no release-relevant findings;
- `needs_review` - soft findings that should be inspected;
- `risky` - known hard release risk or missing blocking proof;
- `waived` - validation proof was skipped, waived, or force-approved.

Automation approves only `ready`. Manual `ready` approval stays direct.
Manual `needs_review` approval routes through the Readiness surface but does not
require a reason. Manual `risky` and `waived` approval must happen from the
Readiness surface and requires a non-empty reason. Approval metadata is stored
inside the latest Readiness snapshot and emitted as an event.

Advisory browser QA remains evidence-only per ADR-027. A concern or error can
make Readiness `needs_review`, but it does not change validation overall,
validation retry behavior, or PR creation. If advisory QA is enabled and already
in flight at approval time, approval waits for it, then recomputes Readiness.

Store the latest per-pod Readiness snapshot on the pod row as compact JSON. Do
not add an append-only readiness table in v1. Do not add a series table. For
single-PR series, compute Series Readiness as a projection over member pod
snapshots and use that rollup for final PR approval. Missing historical member
snapshots make the rollup `needs_review`; there is no backfill.

Readiness v1 stays out of PR bodies. It links to existing evidence surfaces
instead of embedding raw logs, diffs, screenshots, scan payloads, action bundles,
or PR check payloads.

## Consequences

Easier:

- Approval has one compact, auditable decision summary.
- Automation becomes conservative without adding new blockers to validation.
- Single-PR series approval reflects the whole series, not only the final pod.
- Existing validation, advisory QA, security, action, network, and PR systems
  remain authoritative for raw evidence.

Harder:

- Approval paths must recompute Readiness and handle in-flight advisory QA.
- Desktop needs a dedicated Readiness tab while keeping Overview compact.
- Old pods have no snapshot and must render Readiness unavailable.
- Single-PR rollups must tolerate partial historical data.

Committed to:

- Plain Readiness Review terminology in code, UI, docs, and copy.
- Advisory approval companion, not a new validation phase.
- `autoApprove` and approve-all only approve `ready`.
- `risky` and `waived` require an approval reason.
- Series Readiness for single-PR approval.
- No PR body change, no series table, and no historical backfill in v1.

## Alternatives rejected

- **Hard validation gate.** This would turn soft evidence into blockers and
  conflict with ADR-027 and existing scanner fail-open behavior.
- **Rich evidence bundle.** This duplicates logs, scans, screenshots, diffs, and
  action records that already have owners and retention behavior.
- **Append-only readiness table.** Useful later for analytics, but unnecessary
  for the approval decision surface and heavier than the current need.
- **Final-pod-only single-PR approval.** This hides risks from earlier member
  pods in a PR that ships the whole series.
- **PR body section in v1.** The existing PR body already carries validation
  waiver and security details; Readiness belongs first in Desktop/API/CLI
  approval flows.
