# Design - Readiness Review

## Blast Radius

### Shared Types and Persistence (Brief 01)

- `packages/shared/src/types/` - add exported Readiness Review types and include
  the optional snapshot on the pod type.
- `packages/shared/src/schemas/pod.schema.ts` - include optional/null readiness
  payload validation if pod schemas are kept in sync with wire types.
- `packages/daemon/src/db/migrations/` - add one nullable pod column for the
  latest snapshot, likely `116_pod_readiness_review.sql` if no newer migration
  exists at implementation time.
- `packages/daemon/src/pods/pod-repository.ts` - read/write the JSON snapshot
  and expose an update path.
- `packages/daemon/src/pods/pod-repository.test.ts` - JSON round-trip and clear
  coverage.
- `packages/daemon/src/api/wire-serializers.ts` - pass the nullable snapshot
  through without embedding raw evidence.
- `packages/daemon/src/api/routes/pods.test.ts` or a serializer test - prove API
  null/object behavior.

### Daemon Computation and Series Rollup (Brief 02)

- `packages/daemon/src/pods/readiness-review.ts` or similar - new computation
  service for per-pod snapshots and single-PR series rollups.
- `packages/daemon/src/pods/pod-manager.ts` - refresh snapshots at validation,
  waiver, terminal/review status, and approval decision points.
- `packages/daemon/src/pods/pod-manager.test.ts` - lifecycle hooks, advisory QA
  wait behavior, and series rollup tests.
- `packages/daemon/src/validation/` and validation repositories - read latest
  validation/advisory data without changing validation semantics.
- `packages/daemon/src/security/scan-repository.ts` - read latest scan results.
- `packages/daemon/src/actions/audit-repository.ts` - verify the action audit
  chain and read action safety metadata.
- `packages/daemon/src/pods/event-repository.ts` - read denied egress, quarantine,
  and relevant safety events by pod.
- `packages/daemon/src/pods/pod-repository.ts` - use `getPodsBySeries(...)` for
  rollups.

### Approval and Automation Gates (Brief 03)

- `packages/daemon/src/pods/pod-manager.ts` - extend `approveSession(...)` to
  recompute readiness, wait for in-flight advisory QA when relevant, enforce
  reason requirements, store approval metadata, and emit an event.
- `packages/daemon/src/api/routes/pods.ts` - accept optional `reason` on
  `POST /pods/:id/approve`; update approve-all response with skipped pods.
- `packages/daemon/src/api/routes/pods.test.ts` - approval route and approve-all
  coverage.
- `packages/daemon/src/pods/pod-manager.test.ts` - manual, automatic, and
  single-PR approval gate coverage.
- Auto-approval call sites in `pod-manager.ts` - only auto-approve `ready`
  readiness.

### CLI and API Surface (Brief 04)

- `packages/cli/src/client.ts` - pass approval reason through existing approve
  client method.
- `packages/cli/src/commands/session.ts` or `packages/cli/src/commands/pod.ts`
  - add `ap approve --reason`, render approve-all skipped pods, and show compact
  Readiness in `ap status <id>`.
- CLI tests for status and approval command parsing.
- Shared API/client types if the CLI consumes generated or shared response
  shapes.

### Desktop Readiness Experience (Brief 05)

- `packages/desktop/Sources/AutopodClient/DaemonAPI.swift` - decode readiness
  payload and send approval reason.
- `packages/desktop/Sources/AutopodDesktop/Mapping/PodMapper.swift` - map pod and
  series readiness models.
- `packages/desktop/Sources/AutopodUI/Models/` - add UI models for readiness
  status, areas, findings, source refs, and approval state.
- `packages/desktop/Sources/AutopodUI/Views/Detail/DetailPanelView.swift` - add
  the Readiness tab, header pill, and route approval buttons through the new
  flow.
- `packages/desktop/Sources/AutopodUI/Views/Detail/OverviewTab.swift` - add a
  compact no-scroll Readiness card.
- `packages/desktop/Sources/AutopodUI/Views/Detail/ReadinessTab.swift` - new
  tab with pod and series layouts.
- `packages/desktop/Sources/AutopodDesktop/Stores/ActionHandler.swift` - pass
  reason to daemon approval and avoid optimistic approval when daemon rejects.
- Desktop model/mapper checks stay in human review or local macOS test notes;
  they are not Autopod-self required facts because the pod image may not include
  Swift or Xcode.

## Boundaries and Brief Order

Five sequential briefs:

1. **Shared types and persistence** - create the durable shape and nullable
   pod-row storage.
2. **Daemon computation and series rollup** - derive snapshots and rollups from
   existing evidence.
3. **Approval and automation gates** - make approval consume readiness.
4. **CLI and API surface** - expose compact status and approval reason support.
5. **Desktop readiness experience** - render the user-facing decision surface.

Brief 03 depends on Brief 02 because approval needs the daemon computation.
Brief 05 depends on Brief 01 for the wire shape and Brief 03 for the approval
contract. Brief 04 can start after Brief 03.

## Readiness Contract

### Statuses

Top-level `ReadinessStatus`:

```ts
type ReadinessStatus = 'ready' | 'needs_review' | 'risky' | 'waived';
```

Area rows use the top-level statuses plus availability states:

```ts
type ReadinessAreaStatus =
  | ReadinessStatus
  | 'not_applicable'
  | 'not_available';
```

Areas:

```ts
type ReadinessArea =
  | 'validation'
  | 'security'
  | 'actions'
  | 'network'
  | 'scope'
  | 'quality'
  | 'advisory_qa'
  | 'pr';
```

### Snapshot Shape

One acceptable shared shape:

```ts
interface ReadinessReview {
  status: ReadinessStatus;
  summary: string;
  computedAt: string;
  scope: 'pod';
  areas: ReadinessAreaReview[];
  findings: ReadinessFinding[];
  approval?: ReadinessApproval | null;
}

interface ReadinessAreaReview {
  area: ReadinessArea;
  status: ReadinessAreaStatus;
  title: string;
  summary: string;
  sourceRefs: ReadinessSourceRef[];
}

interface ReadinessFinding {
  id: string;
  area: ReadinessArea;
  severity: 'info' | 'warning' | 'error';
  title: string;
  detail: string;
  sourceRefs: ReadinessSourceRef[];
}

interface ReadinessSourceRef {
  kind:
    | 'validation'
    | 'work'
    | 'logs'
    | 'diff'
    | 'pr'
    | 'evidence'
    | 'quality'
    | 'event';
  label: string;
  id?: string;
  href?: string;
}

interface ReadinessApproval {
  approvedAt: string;
  approvedBy?: string;
  statusAtApproval: ReadinessStatus;
  scope: 'pod' | 'series';
  seriesId?: string;
  reason?: string;
}
```

The stored payload must stay compact. It should not embed raw logs, screenshots,
diffs, full security findings, action audit bundles, or PR check payloads.

### Derived Status Rules

`ready` means no findings above informational level.

`needs_review` means at least one soft signal should be inspected, but Autopod is
not claiming a known release hazard. Examples:

- security warning/escalation or scanner-error fail-open result;
- denied egress events;
- advisory QA concern or error;
- relevant advisory QA still in flight before approval;
- scope drift or preflight overlap;
- action quarantine or PII-related safety event;
- low quality signal;
- missing legacy member snapshot in a single-PR series rollup.

`risky` means a known hard release risk or missing blocking proof exists.
Examples:

- latest blocking validation failed or is unknown when approval is attempted;
- invalid action audit hash chain;
- compromised worktree state;
- blocked PR review, CI, or merge gate;
- any existing daemon state that already represents an unapproved blocking PR
  condition.

`waived` means the approval path is accepting missing or bypassed validation
proof. Examples:

- validation waiver;
- skip-validation result that bypasses normal proof;
- force-approve path after failed validation.

If waived validation and a separate non-waiver hard risk are both present,
prefer top-level `risky` and include the waiver as a finding. Both statuses
require a manual reason.

### Refresh Timing

Refresh and persist per-pod Readiness:

- when blocking validation completes;
- when a deferred advisory result is merged into the latest validation result;
- when validation is skipped, waived, or force-approved;
- when the pod enters `failed`, `review_required`, or `validated`;
- inside `approveSession(...)` immediately before the approval decision.

Before `validated`, `review_required`, or `failed`, Desktop should show a compact
pending state such as "Readiness pending validation" rather than noisy
progressive rows.

### Advisory QA Semantics

ADR-027 remains authoritative: advisory browser QA is evidence, not validation.
It does not change `ValidationResult.overall`, retry behavior, or PR creation.

Readiness consumes advisory QA as a soft evidence area:

- disabled, skipped, or no checklist: area `not_applicable`;
- in-flight and relevant: area `not_available`, top-level `needs_review`;
- complete pass: area `ready`;
- concern/fail/error: area `needs_review`.

If advisory QA is enabled and already in flight when approval is attempted,
`approveSession(...)` waits for it, recomputes Readiness, then applies the normal
approval rules.

### Series Rollup

Every pod stores its own per-pod Readiness Review. There is no series table and
no stored series snapshot in v1.

For `prMode: 'single'`, compute Series Readiness from all pods with the same
`series_id`:

- the final/PR-owning pod's approval uses Series Readiness;
- the rollup status is the worst meaningful member status:
  `risky` or `waived`, then `needs_review`, then `ready`;
- if any member lacks a snapshot, the rollup is `needs_review` with a missing
  snapshot finding;
- the approval record is stored on the final/PR-owning pod with
  `scope: 'series'` and the `seriesId`.

Single-PR member pods keep moving through `needs_review`, `risky`, or `waived`
findings. Readiness does not stop branch/no-PR dependency chains. Stacked series
already wait on parent merge behavior through existing `waitForMerge` semantics.

### Approval Rules

- `ready` manual approval can proceed directly.
- `needs_review` manual approval routes through the Readiness tab but does not
  require a reason.
- `risky` and `waived` manual approval must happen from the Readiness tab and
  require a non-empty reason.
- Any supplied approval reason is stored in the Readiness approval object.
- Approval emits a pod event such as `pod.readiness_approved` with the status,
  scope, reason if supplied, and summary.
- `autoApprove` and approve-all approve only `ready` pods. They skip
  `needs_review`, `risky`, and `waived`, and report skipped pod IDs and reasons.

## UX Flows

### Pod Readiness

Approved wireframe:

```text
Header
[Readiness: risky]              [Review & Approve] [Reject]

Overview
Readiness: risky - 2 findings need a human decision        [Open Readiness]

Readiness
+----------------------------------------------------------+
| Readiness Review                                         |
| risky - Validation was waived; denied egress observed.   |
| Computed 14:32                                           |
|                                                          |
| Validation      waived        Human skipped failed facts  |
| Security        ready         No blocking findings        |
| Actions         ready         Audit chain valid           |
| Network         needs_review  3 denied egress events      |
| Scope           ready         No drift detected           |
| Quality         needs_review  Low self-check signal       |
| Advisory QA     not_available Still running / not run     |
| PR              ready         Merge gate clean            |
|                                                          |
| Approval reason required                                 |
| [ Explain why this is acceptable...                    ] |
| [Approve with reason] disabled until text is entered      |
+----------------------------------------------------------+
```

For `needs_review`, the Readiness tab still shows findings and the approval
button, but no reason field is required. For `ready`, header approval may approve
directly.

### Series Readiness

Approved wireframe:

```text
Header
[Series Readiness: needs_review]        [Review & Approve] [Reject]

Overview
Series Readiness: needs_review - 3 findings across 2 pods   [Open Readiness]

Readiness
+----------------------------------------------------------+
| Series Readiness                                         |
| needs_review - 3 findings across 2 of 5 pods             |
| Single PR: feature/readiness-review                      |
|                                                          |
| Overall areas                                            |
| Validation      ready         latest final validation OK  |
| Security        needs_review  warning in 01-backend      |
| Actions         ready         audit chain valid           |
| Advisory QA     needs_review  concern in 05-desktop      |
| PR              ready         merge gate clean            |
|                                                          |
| Member pods                                              |
| 01-backend      needs_review  Security warning            |
| 02-daemon       ready         no findings                 |
| 05-desktop      needs_review  Advisory QA concern         |
|                                                          |
| [Approve after review]                                   |
+----------------------------------------------------------+
```

For `risky` or `waived` series rollups, add the same required reason block at the
bottom.

### Evidence Links

V1 links only to existing surfaces:

- Validation;
- Work;
- Logs;
- Diff;
- PR;
- Evidence.

The Readiness tab should not introduce raw action/security/network drilldown
screens in v1. Source refs can be stored now so future drilldowns have stable
anchors.

## Reference Reading

- `AGENTS.md` - repo architecture, migration numbering, validation, desktop, and
  Autopod-self gotchas.
- `docs/conventions/convention-001-autopod-self-required-facts.md` - desktop
  Swift/AppKit proof boundary.
- `docs/decisions/ADR-018-safety-events-fleet-wide-scope.md` - safety events are
  fleet-wide operator evidence.
- `docs/decisions/ADR-019-pii-categories-outside-hash-chain.md` - PII categories
  stay outside the action audit hash payload.
- `docs/decisions/ADR-020-network-policy-resolved-snapshot.md` - resolved
  network policy is snapshotted on the pod row.
- `docs/decisions/ADR-025-single-fix-pod-per-pr.md` - existing PR/fix ownership
  context.
- `docs/decisions/ADR-027-advisory-browser-qa-evidence-not-validation.md` -
  advisory QA evidence semantics.
- `packages/daemon/src/pods/pod-manager.ts` - validation, advisory QA, approval,
  auto-approval, PR creation, and series dependency behavior.
- `packages/daemon/src/pods/pod-repository.ts` - pod JSON column patterns and
  `getPodsBySeries(...)`.
- `packages/daemon/src/api/routes/pods.ts` - approve, approve-all,
  skip-validation, force-approve routes.
- `packages/daemon/src/security/scan-repository.ts` - security scan storage.
- `packages/daemon/src/actions/audit-repository.ts` - action audit hash chain.
- `packages/daemon/src/api/wire-serializers.ts` - pod/validation serialization.
- `packages/desktop/Sources/AutopodUI/Views/Detail/DetailPanelView.swift` -
  detail tabs and approval buttons.
- `packages/desktop/Sources/AutopodUI/Views/Detail/OverviewTab.swift` -
  compact overview surface.
- `packages/desktop/Sources/AutopodUI/Views/Detail/ValidationTab.swift` -
  advisory QA and validation display precedent.
- `packages/desktop/Sources/AutopodUI/Views/Series/SeriesPipelineView.swift` -
  existing series projection UI.
- `packages/cli/src/commands/pod.ts` and `packages/cli/src/commands/session.ts`
  - existing status and approve commands.
