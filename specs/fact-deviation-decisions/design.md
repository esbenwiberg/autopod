# Design - Fact Deviation Decisions

## Blast Radius

### Escalation MCP and Daemon Bridge (Brief 01)

- `packages/escalation-mcp/src/pod-bridge.ts` - extend the bridge contract with
  report-blocker counting and a way to create non-human-notifying escalation
  records.
- `packages/escalation-mcp/src/tools/report-blocker.ts` - count
  `report_blocker` records, not `ask_ai`, and pass whether this report should
  notify the human.
- `packages/escalation-mcp/src/tools/escalation-tools.test.ts` - update
  below-threshold and threshold coverage.
- `packages/daemon/src/pods/pod-bridge-impl.ts` - implement report-blocker count
  through `escalationRepo.countBySessionAndType(podId, 'report_blocker')` and
  respect the non-notifying create option.
- `packages/daemon/src/pods/pod-bridge-escalation.test.ts` - new focused bridge
  test if no existing bridge escalation test home is suitable.
- `packages/daemon/src/pods/escalation-repository.test.ts` - add count coverage
  only if the bridge test needs repository-level proof.

### Daemon Fact Decisions (Brief 02)

- `packages/daemon/src/api/routes/pods.ts` - remove the old
  `/approve-waiver` route and add `POST /pods/:podId/facts/decisions`.
- `packages/daemon/src/api/routes/pods.test.ts` - route-level integration
  coverage for success and invalid batches.
- `packages/daemon/src/pods/pod-manager.ts` - replace `approveFactWaiver(...)`
  with a batch method that validates pending facts, updates task summary once,
  emits activity, and revalidates once.
- `packages/daemon/src/pods/pod-manager.test.ts` - batch decision, one
  revalidation, status guard, and unavailable-command activity coverage.
- `packages/daemon/src/validation/local-validation-engine.ts` - keep existing
  decision semantics; adjust only for clearer unavailable-command reasoning if
  needed.
- `packages/daemon/src/validation/local-validation-engine.test.ts` - add or
  confirm coverage for waive, replacement proof, and enforce-original behavior.

### Desktop (Brief 03)

- `packages/desktop/Sources/AutopodClient/DaemonAPI.swift` - replace
  `approveFactWaiver(...)` with a batch fact-decision request.
- `packages/desktop/Sources/AutopodDesktop/Stores/ActionHandler.swift` - replace
  action-handler glue.
- `packages/desktop/Sources/AutopodUI/Models/PodActions.swift` - expose the
  batch decision action to views.
- `packages/desktop/Sources/AutopodUI/Views/Detail/ValidationTab.swift` - replace
  per-fact waiver popovers with the batch decision panel.
- `packages/desktop/Sources/AutopodUI/Views/Detail/OverviewTab.swift` -
  special-case pods with pending fact decisions.
- `packages/desktop/Sources/AutopodUI/Views/Detail/SummaryTab.swift` - render
  fact deviation decisions with domain terms.
- `packages/desktop/Sources/AutopodDesktop/Stores/EventStream.swift` - branch
  validation-completed notification handling for pending facts.
- `packages/desktop/Sources/AutopodDesktop/Services/NotificationService.swift` -
  add a specific fact-decision notification method.

## Seams and Brief Order

Three sequential briefs:

1. **Report blocker threshold semantics** - fixes the escalation/MCP contract
   without touching fact decisions.
2. **Batch fact decisions backend** - replaces the daemon API and manager path.
   Depends on Brief 01 only to avoid overlapping daemon/bridge semantics in the
   same running series.
3. **Desktop fact-decision experience** - consumes the new daemon API and updates
   user-visible copy, layout, and notifications. Depends on Brief 02.

There are no parallel groups. Brief 03 must not start before Brief 02 because it
removes the old desktop client method and targets the new route.

## Contracts

### Report Blocker Bridge Contract

The MCP bridge should expose the smallest surface needed for correct threshold
behavior. One acceptable shape:

```ts
getReportBlockerCount(podId: string): number;
createEscalation(
  escalation: EscalationRequest,
  options?: { notifyHuman?: boolean },
): void;
```

Rules:

- `report_blocker` calls count only prior `report_blocker` rows for the same pod.
- `notifyHuman` defaults to `true` so existing `ask_human`, `action_approval`,
  and `request_credential` call sites retain current behavior.
- Below threshold, `report_blocker` passes `notifyHuman: false`.
- At threshold, `report_blocker` passes `notifyHuman: true` and waits for the
  pending human response.
- `getAiEscalationCount` remains available for `ask_ai` limits.

### Fact Decision API Contract

Replace:

```http
POST /pods/:podId/facts/:factId/approve-waiver
```

with:

```http
POST /pods/:podId/facts/decisions
```

Request:

```ts
{
  decisions: Array<{
    factId: string;
    action:
      | 'waive_required_fact'
      | 'use_replacement_proof'
      | 'enforce_original_fact';
    reason?: string;
  }>;
}
```

Response:

```ts
{
  ok: true;
  newCommits: boolean;
  result: 'pass' | 'fail';
}
```

Validation:

- Pod status must be `failed` or `review_required`.
- Every currently pending-human required fact in the latest validation result
  must have exactly one decision.
- Missing, duplicate, unknown, non-pending, and invalid-action decisions are
  rejected with 4xx errors.
- `use_replacement_proof` is valid only when the existing fact deviation request
  carries replacement proof.
- The route should not accept partial batches.

Mapping:

| Public action | Internal task-summary decision |
| --- | --- |
| `waive_required_fact` | `approved_waive` |
| `use_replacement_proof` | `approved_replace` |
| `enforce_original_fact` | `rejected` |

The local validation engine already interprets `approved_waive`,
`approved_replace`, and `rejected`; the implementation should preserve that
contract unless it finds a narrow bug while adding coverage.

### Unavailable Command Activity

When validation returns a required fact with `status: 'pending_human'` and
`exitCode: 127`, the daemon should emit a user-visible pod activity/log line,
for example:

```text
Required fact command unavailable: fact-swift-only (swift not found, exit 127)
```

This activity is informational for the operator. It does not replace the
existing feedback path that tells the agent to report `factDeviations`.

## UX Flows

### Overview Attention State

Approved wireframe:

```text
Overview
┌ Required fact decision needed ──────────────────────┐
│ 2 required facts need decisions before validation.   │
│ [Open Validation]                                    │
└──────────────────────────────────────────────────────┘
```

Behavior:

- Show this specific state when a pod is `failed` or `review_required` and the
  latest validation result contains pending-human required facts.
- The copy should tell the operator how many required facts need decisions.
- The action should take the operator to the Validation tab.

### Validation Batch Decision Panel

Approved wireframe:

```text
Validation > Required Facts
┌ Required Fact Decisions (2) ─────────────────────────┐
│ Choose one decision for each pending fact.            │
│                                                       │
│ fact-swift-only                         pending       │
│ swift not found, exit 127                            │
│ ( ) Waive Required Fact                              │
│ ( ) Enforce Original Fact                            │
│                                                       │
│ fact-browser-proof                      pending       │
│ Replacement proof available                          │
│ ( ) Use Replacement Proof                            │
│ ( ) Enforce Original Fact                            │
│                                                       │
│ [Apply Decisions & Revalidate] disabled until 2/2 set │
└───────────────────────────────────────────────────────┘
```

Behavior:

- Render one panel for all pending-human required facts.
- No choice is preselected.
- `Apply Decisions & Revalidate` stays disabled until every pending fact has an
  explicit decision.
- `Use Replacement Proof` appears only when replacement proof exists.
- Submit sends one batch request and disables controls while in flight.
- Backend errors appear near the panel without clearing current selections.
- The UI must use the terms `Waive Required Fact`, `Use Replacement Proof`, and
  `Enforce Original Fact`; do not show generic approve/reject wording for these
  choices.

### Summary and Notifications

- Summary/detail views should map internal decisions to user-facing labels:
  `Waived Required Fact`, `Using Replacement Proof`, and
  `Original Fact Enforced`.
- When `validationCompleted` has `result.factValidation?.status == "pending_human"`,
  desktop should send a specific `Required fact decision needed` native
  notification and should not also send the generic validation-failed
  notification for the same event.

## Reference Reading

- `AGENTS.md` - repo architecture, validation, and Autopod-self gotchas.
- `docs/conventions/convention-001-autopod-self-required-facts.md` - desktop
  Swift/AppKit tests are not valid required facts in Linux pods.
- `docs/decisions/ADR-027-advisory-browser-qa-evidence-not-validation.md` -
  relevant precedent for separating executable facts from evidence/human review
  when the environment cannot run native UI checks.
- `packages/escalation-mcp/src/tools/report-blocker.ts` - current
  report-blocker behavior.
- `packages/escalation-mcp/src/pod-bridge.ts` - MCP bridge interface.
- `packages/daemon/src/pods/pod-bridge-impl.ts` - bridge insert/notify boundary.
- `packages/daemon/src/api/routes/pods.ts` - current single-fact waiver route.
- `packages/daemon/src/pods/pod-manager.ts` - current waiver method,
  validation handling, and activity logging utilities.
- `packages/daemon/src/validation/local-validation-engine.ts` - required-fact
  deviation decision semantics.
- `packages/desktop/Sources/AutopodUI/Views/Detail/ValidationTab.swift` -
  current per-fact waiver UI.
- `packages/desktop/Sources/AutopodDesktop/Stores/EventStream.swift` and
  `packages/desktop/Sources/AutopodDesktop/Services/NotificationService.swift` -
  desktop validation notifications.

## Decisions

No new ADR is required. This plan replaces an existing backend/API/UI flow
without adding a new durable architecture policy, persistence model, or external
integration.
