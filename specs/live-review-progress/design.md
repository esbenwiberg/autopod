# Design — Live Review Progress

## Blast radius

### Shared contract and frozen runner

- `packages/shared/src/types/validation.ts`
- `packages/shared/src/types/events.ts`
- `packages/daemon/src/interfaces/validation-engine.ts`
- `packages/daemon/src/validation/review-batch-runner.ts`
- `packages/daemon/src/validation/review-batch-runner.test.ts`

### Daemon assembly, emission, and hydration

- `packages/daemon/src/validation/local-validation-engine.ts`
- `packages/daemon/src/validation/local-validation-engine.test.ts`
- `packages/daemon/src/pods/pod-manager.ts`
- `packages/daemon/src/pods/pod-manager.test.ts`
- `packages/daemon/src/api/routes/pods.ts`
- `packages/daemon/src/api/routes/pods.test.ts`

### Desktop transport and state

- `packages/desktop/Sources/AutopodClient/Types/PodResponse.swift`
- `packages/desktop/Sources/AutopodClient/Types/EventTypes.swift`
- `packages/desktop/Sources/AutopodDesktop/Mapping/PodMapper.swift`
- `packages/desktop/Sources/AutopodDesktop/Stores/EventStream.swift`
- `packages/desktop/Sources/AutopodDesktop/Stores/PodStore.swift`
- `packages/desktop/Sources/AutopodUI/Models/Pod.swift`
- `packages/desktop/Tests/review-progress-contract.mjs`
- `packages/desktop/Tests/AutopodClientTests/ReviewProgressStateTests.swift`

### Desktop presentation

- `packages/desktop/Sources/AutopodUI/Views/Cards/PodCardFinal.swift`
- `packages/desktop/Sources/AutopodUI/Views/Detail/ValidationTab.swift`
- `packages/desktop/Sources/AutopodUI/Views/Detail/LiveReviewProgressView.swift`
- `packages/desktop/Sources/AutopodUI/Views/Shared/ActivityFeedList.swift`
- `packages/desktop/Tests/AutopodUITests/ValidationProgressTests.swift`
- `packages/desktop/Tests/AutopodUITests/ReviewCouncilTests.swift`

## Seams

1. The frozen runner owns safe execution transitions; brief 01 exposes them through the
   validation callback contract.
2. The local engine owns snapshot assembly; brief 02 emits full snapshots through the existing
   persisted event bus and attaches the latest active snapshot during REST hydration.
3. The Swift client owns wire decoding and state-race handling; brief 03 converts both event and
   REST payloads into the same domain model.
4. SwiftUI owns presentation only; brief 04 renders the domain model and groups projected council
   activity without changing completed review data.

## Contracts

Brief 01 owns the additive shared shape consumed by every later brief:

```ts
export type ReviewProgressStage = 'axes' | 'synthesis' | 'closure' | 'finalizing';
export type ReviewProgressAxisStatus = 'queued' | 'running' | 'completed' | 'unavailable';

export interface ReviewProgressAxis {
  axis: ReviewAxis;
  status: ReviewProgressAxisStatus;
  attempt: number;
  durationMs?: number;
  failureKind?: ReviewFailureKind;
}

export interface ReviewProgressSnapshot {
  attempt: number;
  startedAt: string;
  updatedAt: string;
  elapsedMs: number;
  guardrailMs: number;
  stage: ReviewProgressStage;
  axes: ReviewProgressAxis[];
}
```

`pod.review_progress` carries `podId` plus one complete snapshot. Derived counts are computed from
the ordered axis array: settled includes completed and unavailable; completed includes completed
only. Progress contains no prompts, provider output, or findings.

Full pod REST hydration gains an optional `reviewProgress` field. Compact pod hydration keeps the
existing `progressSummary` field and derives a concise string only for active validating pods.
Both fields are additive and absent for older daemons or inactive Review phases.

The Swift domain model mirrors the shared contract and records a freshness timestamp. PodStore
must preserve a newer streamed snapshot when a stale REST hydration completes.

## UX flows

### Validating pod card

The existing validating card keeps its attempt line and optional Open App action. When structured
Review progress exists, it adds two compact lines: stage/settled state and running/unavailable plus
elapsed/guardrail state. With no snapshot it preserves the current appearance.

```text
┌──────────────────────────────────────┐
│ VALIDATING · Attempt 1 of 3          │
│ Review council · 4/5 settled         │
│ 1 running · 1 unavailable            │
│ 1m 22s / 5m guardrail                │
└──────────────────────────────────────┘
```

### Validation → Review

While Review is running, the detail branch renders five human-named axes, stage, actual elapsed
time, configured guardrail, attempts, and unavailable warnings. After phase completion the
existing completed `ReviewCouncilView` remains authoritative.

```text
Review Council                   Running
4/5 settled · 1m 22s / 5m guardrail

[Contract       completed]
[Security       unavailable · 2 attempts]
[Reliability    completed]
[Persistence    running · attempt 1]
[Tests          completed]

Next: synthesis → closure → finalizing
```

### Grouped activity

EventStream projects safe full snapshots into marked activity events. The overview feed shows only
the newest council row while the ungrouped full event log retains every projected event. Expanding
the grouped row shows the five axis states and timing.

```text
Review council · 4/5 settled · 1m 22s  ▾
  Contract completed · 72s
  Security unavailable · 2 attempts
  Reliability completed · 83s
  Persistence running · attempt 1
  Tests completed · 219s
```

## Reference reading

- `AGENTS.md` — repository architecture, validation, desktop, and test constraints.
- `docs/decisions/ADR-036-frozen-review-council-synthesis.md` — frozen authority and fail-closed semantics.
- `docs/conventions/convention-001-autopod-self-required-facts.md` — Linux fact and native UI boundaries.
- `packages/daemon/src/validation/review-batch-runner.ts` — five-axis concurrency, retry, and deadline behavior.
- `packages/daemon/src/validation/local-validation-engine.ts` — synthesis, repair delta, and closure orchestration.
- `packages/daemon/src/pods/event-bus.ts` — persisted, sanitized system-event emission.
- `packages/daemon/src/api/websocket.ts` — replay and truncation behavior.
- `packages/desktop/Sources/AutopodDesktop/Stores/EventStream.swift` — replay, REST resync, and event projection.
- `packages/desktop/Sources/AutopodUI/Views/Detail/ReviewCouncilView.swift` — completed-council visual language.

## Decisions

- ADR-036: Frozen Review Council Synthesis (reused).
- No new ADR: this is additive, reversible operational telemetry with no authority or storage-format change.
