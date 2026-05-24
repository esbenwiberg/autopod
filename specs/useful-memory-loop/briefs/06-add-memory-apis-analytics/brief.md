---
title: "Add memory review and analytics APIs"
touches:
  - packages/daemon/src/api/routes/memory.ts
  - packages/daemon/src/api/routes/memory.test.ts
  - packages/daemon/src/api/routes/pods.ts
  - packages/daemon/src/api/routes/pods.test.ts
  - packages/daemon/src/api/server.ts
  - packages/daemon/src/pods/memory-effectiveness-aggregator.ts
  - packages/daemon/src/pods/memory-effectiveness-aggregator.test.ts
does_not_touch:
  - packages/desktop/
  - packages/escalation-mcp/
---

## Task

Expose the daemon APIs the desktop needs: pending candidate list, candidate approval/edit/rejection, per-memory usage history, source evidence, stale/harmful evidence, and `GET /pods/analytics/memory?days=N` for the lightweight Analytics card.

The Memory analytics response should focus on repeated-pain proxies: validation failures, PR fix attempts, escalations, quality score, excess cost, and throughput/first-pass/rework where data exists. It should compare same-profile future pods with selected/injected memories against similar pods without selected memories. This is evidence, not automatic disabling.

## Touches

- `packages/daemon/src/api/routes/memory.ts` - extend existing REST surface rather than creating a new top-level resource family unless the current route becomes unreadable.
- `packages/daemon/src/api/routes/pods.ts` - add `/pods/analytics/memory`.
- `packages/daemon/src/pods/memory-effectiveness-aggregator.ts` - pure aggregation logic.
- `packages/daemon/src/api/routes/memory.test.ts`, `packages/daemon/src/api/routes/pods.test.ts`, and `packages/daemon/src/pods/memory-effectiveness-aggregator.test.ts` - route/aggregator tests.
- `packages/daemon/src/api/server.ts` - wire dependencies.

## Does not touch

- `packages/desktop/` - client/UI comes next.
- `packages/escalation-mcp/` - usage reporting was brief 05.

## Constraints

- Approval remains human-gated for durable memories.
- Stale/harmful behavior is evidence-only in v1: no auto-disable, no deprecated state, no pending deactivation candidate.
- Keep manual edit/delete controls compatible with existing memory routes.
- API errors should be explicit when repositories are not wired, matching other analytics routes.

## Test expectations

Cover candidate list, approve create candidate, approve update candidate, reject candidate, edit candidate before approval, usage history response, source-evidence response, invalid days, empty analytics cohort, and positive analytics cohort with selected/injected/read/applied counts.

## Wrap-up

Before finishing:
1. Run `/simplify` and address its findings.
2. Re-run build and tests; both must still pass.
3. Commit and push.
