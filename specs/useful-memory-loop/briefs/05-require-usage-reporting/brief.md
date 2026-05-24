---
title: "Require memory usage reporting"
touches:
  - packages/escalation-mcp/src/server.ts
  - packages/escalation-mcp/src/tools/report-plan.ts
  - packages/escalation-mcp/src/tools/report-task-summary.ts
  - packages/escalation-mcp/src/pod-bridge.ts
  - packages/daemon/src/pods/pod-bridge-impl.ts
  - packages/daemon/src/pods/pod-bridge-task-summary.test.ts
  - packages/daemon/src/pods/pod-bridge-memory.test.ts
does_not_touch:
  - packages/desktop/
  - packages/daemon/src/pods/memory-candidate-recorder.ts
  - packages/daemon/src/pods/system-instructions-generator.ts
---

## Task

Make usage reporting measurable. When selected/injected memories exist, `report_plan` must include intended memory use and `report_task_summary` must include final per-memory outcome: `applied`, `not_applicable`, or `harmful_stale`, each with a short reason. Tool calls with missing/invalid memory usage fields should reject so the agent can retry the tool call.

Do not fail the pod lifecycle solely because memory reporting is missing. If a pod ends without final memory usage reporting, record `not_reported` usage evidence for each selected/injected memory.

## Touches

- `packages/escalation-mcp/src/server.ts`, `report-plan.ts`, and `report-task-summary.ts` - MCP schemas and responses.
- `packages/escalation-mcp/src/pod-bridge.ts` - bridge contract additions.
- `packages/daemon/src/pods/pod-bridge-impl.ts` - record read/search/plan/summary usage events and enforce schema requirements against the pod's selected/injected memories.
- `packages/daemon/src/pods/pod-bridge-task-summary.test.ts` - summary lock behavior with memory usage.
- `packages/daemon/src/pods/pod-bridge-memory.test.ts` - memory read/search/reporting evidence.

## Does not touch

- `packages/desktop/` - display comes later.
- `packages/daemon/src/pods/memory-candidate-recorder.ts` - extraction remains independent.
- `packages/daemon/src/pods/system-instructions-generator.ts` - briefing was brief 04.

## Constraints

- Required usage fields only activate when selected/injected memories exist.
- Re-report lock must preserve original task summary text, but memory usage/fact evidence may still update following the current `factEvidence` pattern.
- `read` and `searched` are recorded daemon-side from memory tools.
- `selected` and `injected` are recorded by the selector/briefing path.

## Test expectations

Cover missing plan memory intent rejection, missing summary usage rejection, valid retry after rejection, read/search event recording, not_reported recording on terminal pod without summary, and no requirement when zero memories were selected.

## Wrap-up

Before finishing:
1. Run `/simplify` and address its findings.
2. Re-run build and tests; both must still pass.
3. Commit and push.
