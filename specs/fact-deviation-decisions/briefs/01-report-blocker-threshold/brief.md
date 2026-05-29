---
title: "Make report_blocker threshold-aware and nonblocking below threshold"
touches:
  - packages/escalation-mcp/src/pod-bridge.ts
  - packages/escalation-mcp/src/tools/report-blocker.ts
  - packages/escalation-mcp/src/tools/escalation-tools.test.ts
  - packages/daemon/src/pods/pod-bridge-impl.ts
  - packages/daemon/src/pods/pod-bridge-escalation.test.ts
  - packages/daemon/src/pods/escalation-repository.test.ts
does_not_touch:
  - packages/desktop/
  - packages/cli/
  - packages/shared/src/types/task-summary.ts
  - packages/daemon/src/pods/pod-manager.ts
  - packages/daemon/src/db/migrations/
---

## Task

Fix `report_blocker` so it is a log/analytics record below the auto-pause
threshold and a human-blocking escalation only at or above that threshold.

The tool currently uses `getAiEscalationCount(podId)` before creating a
`report_blocker`, then always calls `bridge.createEscalation(escalation)` and
`bridge.incrementEscalationCount(podId)`. The daemon bridge treats
`report_blocker` like `ask_human`, so every blocker immediately calls
`podManager.notifyEscalation(...)`, moves the pod to `awaiting_input`, and sets
`pendingEscalation`.

Change that contract so:

1. `report_blocker` counts prior `report_blocker` rows for the same pod/session.
2. Every report is still inserted into the escalations repository.
3. Below threshold, the insert is non-notifying and the tool returns the existing
   "Continuing with reduced confidence" style response.
4. At threshold, the insert is human-notifying and the tool waits for the pending
   response exactly as it does today.

## Touches

- `packages/escalation-mcp/src/pod-bridge.ts` - add the smallest bridge surface
  needed for report-blocker counts and non-notifying inserts, for example
  `getReportBlockerCount(podId)` and
  `createEscalation(escalation, { notifyHuman?: boolean })`.
- `packages/escalation-mcp/src/tools/report-blocker.ts` - use the report-blocker
  count and pass `notifyHuman: currentCount + 1 >= threshold`.
- `packages/escalation-mcp/src/tools/escalation-tools.test.ts` - update existing
  below-threshold and threshold tests.
- `packages/daemon/src/pods/pod-bridge-impl.ts` - implement the new bridge
  surface with `escalationRepo.countBySessionAndType(podId, 'report_blocker')`;
  default `notifyHuman` to true for existing call sites.
- `packages/daemon/src/pods/pod-bridge-escalation.test.ts` - add focused bridge
  tests if no existing bridge escalation test file is suitable.
- `packages/daemon/src/pods/escalation-repository.test.ts` - add count coverage
  only if the bridge test needs repository-level proof.

## Does Not Touch

Do not change desktop UI, CLI, task summary/fact deviation types, pod statuses,
state-machine transitions, or database migrations.

## Constraints

- Keep `getAiEscalationCount` behavior for `ask_ai`; this brief must not alter
  AI-consult limits.
- Keep blocker escalation rows visible to analytics and logs even when
  nonblocking.
- Do not call `pendingRequests.waitForResponse(...)` below threshold.
- Do not increment pod human-escalation counters below threshold;
  `podManager.notifyEscalation(...)` remains the human-attention boundary.
- Preserve default behavior for `ask_human`, `action_approval`, and
  `request_credential` bridge inserts.

## Test Expectations

- Below-threshold MCP test: current report-blocker count below threshold,
  `createEscalation` receives `notifyHuman: false`,
  `pendingRequests.waitForResponse` is not called, return text says continuing.
- Threshold MCP test: current report-blocker count plus this report reaches
  threshold, `createEscalation` receives `notifyHuman: true`, the tool waits for
  and returns the human response.
- Daemon bridge test: non-notifying `report_blocker` inserts an escalation row
  but does not call `podManager.notifyEscalation`.
- Daemon bridge test: default/notifying `report_blocker` still calls
  `podManager.notifyEscalation`.

## Wrap-up

Before finishing:
1. Run `/simplify` and address its findings.
2. Run `npx pnpm --filter @autopod/escalation-mcp test -- escalation-tools.test.ts`.
3. Run the focused daemon test that covers the bridge.
4. Commit and push.
