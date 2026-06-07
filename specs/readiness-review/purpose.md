# Readiness Review

## Problem

Autopod already records many release-relevant signals: validation results,
required facts, advisory browser QA, security scans, action audit records,
network policy snapshots, denied egress events, PR/CI state, quality scores, and
full pod logs. Those signals live in separate surfaces. At approval time there is
no compact answer to: "Is this pod ready to release, what should a human inspect,
and am I overriding anything?"

The existing quality score only measures agent behavior. It is useful, but it is
not a release-readiness judgment. A pod can have a high agent score while still
having waived validation, denied egress, a failed advisory browser observation,
or a blocked PR gate.

## Outcome

Add a Readiness Review that produces one latest per-pod snapshot with:

- a top-level status: `ready`, `needs_review`, `risky`, or `waived`;
- grouped findings for validation, security, actions, network, scope, quality,
  advisory QA, and PR state;
- references to existing evidence surfaces instead of duplicating raw logs,
  screenshots, diffs, scan output, or action records;
- an optional approval record when a human approves a `needs_review`, `risky`,
  or `waived` pod.

Desktop shows Readiness as a dedicated tab, a compact Overview card, and a header
pill. CLI shows a compact Readiness line in existing status output. Approval
automation only approves `ready` pods. Manual approval can approve `ready`
directly, routes `needs_review` through the Readiness tab, and requires a reason
from the Readiness tab for `risky` or `waived`.

For single-PR series, approval uses a Series Readiness rollup computed from the
member pod snapshots. The rollup is shown first on the final/PR-owning pod's
Readiness tab.

## Users

Esben as the Autopod operator. The affected experience is the macOS desktop pod
detail view, daemon approval flow, and existing CLI status/approve commands.

Agents are affected only indirectly: their existing validation, advisory QA,
action, and summary outputs become inputs to a human-readable readiness summary.
This feature does not add new agent-facing tool requirements.

## Success Signal

A pod that reaches `validated`, `review_required`, or `failed` has a Readiness
Review snapshot that explains its release state without requiring the operator
to manually correlate validation, logs, PR checks, security findings, action
audit state, and advisory QA.

Automation proves that:

- clean pods become `ready` and can be auto-approved;
- failed or unknown blocking validation, invalid action audit chain, compromised
  worktree, and blocked PR gates become `risky`;
- validation waivers, skipped validation, and force-approve paths become
  `waived`;
- soft signals such as security warnings, denied egress, advisory QA concerns,
  scope drift, action quarantine/PII events, and low quality become
  `needs_review`;
- `risky` and `waived` manual approval requires a reason and stores it;
- `autoApprove` and approve-all skip anything other than `ready`;
- single-PR series approval uses the series rollup, not only the final pod.

Desktop human review validates the final UI layout because Autopod-self pods run
in Linux and cannot execute native SwiftUI/AppKit proof inside the pod image.

## Non-Goals

- Use plain Readiness Review terminology in code, UI, docs, and copy.
- No hard merge blocker for advisory browser QA concerns. ADR-027 still holds:
  advisory QA is evidence, not validation.
- No append-only readiness table and no rich raw evidence bundle.
- No new series table. Series Readiness is a projection over pods that share the
  existing `series_id`.
- No historical backfill. Old pods without a snapshot show Readiness unavailable.
- No PR body changes in v1.
- No new raw action/security/network drilldown screens or routes in v1.
- No change to intentionally soft security scanner behavior. Warn/escalate and
  scanner-error fail-open cases remain soft review signals unless existing code
  already failed the pod.
- No attempt to audit side effects outside the existing MCP action audit,
  validation, PR, network, and log evidence that Autopod already persists.
- No scheduler brake for branch/no-PR dependency chains or single-PR member pods.
  Readiness is an approval/release decision surface.

## Glossary

- **Readiness Review** - The per-pod release-decision summary persisted as the
  latest snapshot on the pod row.
- **Series Readiness** - A computed rollup over member pod Readiness snapshots
  for a single-PR series.
- **Finding** - A concise human-readable issue or note inside a Readiness area.
  Findings reference existing evidence surfaces instead of embedding raw data.
- **Area** - One readiness dimension: validation, security, actions, network,
  scope, quality, advisory QA, or PR.
- **Source reference** - A small pointer to existing evidence such as Validation,
  Work, Logs, Diff, PR, or Evidence.
- **Approval record** - The human approval metadata stored inside the snapshot
  when approving `needs_review`, `risky`, or `waived`, including the reason when
  required.

## Reversibility

Rollback is mostly code-only. The new nullable pod column can remain unused if
the feature is disabled or reverted. Existing validation, security, action,
network, PR, and quality records remain authoritative because Readiness stores a
derived summary, not the underlying evidence.
