# pure-kiwi handover

## Built

- Added `CreateEscalationOptions` to the MCP `PodBridge` contract so escalation inserts can opt out of human notification.
- Added `getReportBlockerCount(podId)` and changed `report_blocker` to count prior `report_blocker` rows instead of `ask_ai` rows.
- `report_blocker` now inserts every blocker row. Below threshold it passes `{ notifyHuman: false }`, does not wait for a human response, and does not increment the human escalation count. At threshold it passes `{ notifyHuman: true }`, increments the existing human escalation count path, and waits for the human response.
- The daemon bridge now defaults `notifyHuman` to true for existing `ask_human`, `report_blocker`, `action_approval`, and `request_credential` callers, but skips `podManager.notifyEscalation(...)` when explicitly passed `{ notifyHuman: false }`.
- Added focused daemon bridge coverage in `packages/daemon/src/pods/pod-bridge-escalation.test.ts`.

## Deviations

- No intentional deviations from the brief.
- I updated existing test bridge mocks outside the core touch list only to satisfy the expanded `PodBridge` interface.

## Changed contracts downstream pods should know

- `PodBridge.createEscalation(escalation, options?)` accepts `options.notifyHuman`.
- `notifyHuman` defaults to true; callers only need to pass false when they want an analytics/log row without a human-attention transition.
- `PodBridge.getReportBlockerCount(podId)` is the report-blocker-specific counter. `getAiEscalationCount(podId)` remains ask-AI-only.

## Files to avoid changing without a good reason

- `packages/escalation-mcp/src/pod-bridge.ts`
- `packages/escalation-mcp/src/tools/report-blocker.ts`
- `packages/escalation-mcp/src/tools/escalation-tools.test.ts`
- `packages/daemon/src/pods/pod-bridge-impl.ts`
- `packages/daemon/src/pods/pod-bridge-escalation.test.ts`

## Landmines

- `incrementEscalationCount` is still called for threshold `report_blocker` requests to preserve the existing human-escalation path, but is intentionally skipped below threshold.
- Non-notifying blocker rows still live in the escalations table, so analytics that count stored `report_blocker` rows will see them even though the pod was not paused.
