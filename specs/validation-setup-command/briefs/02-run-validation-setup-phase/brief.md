---
title: "Run validation setup as the first daemon phase"
touches:
  - packages/shared/src/types/events.ts
  - packages/shared/src/types/validation.ts
  - packages/daemon/src/interfaces/validation-engine.ts
  - packages/daemon/src/validation/local-validation-engine.ts
  - packages/daemon/src/validation/local-validation-engine.test.ts
  - packages/daemon/src/pods/pod-manager.ts
  - packages/daemon/src/pods/correction-context.ts
  - packages/daemon/src/pods/feedback-formatter.ts
does_not_touch:
  - packages/daemon/src/profiles/profile-store.ts
  - packages/escalation-mcp/
  - packages/desktop/
---

## Task
Implement setup execution in the daemon validation pipeline. Setup must run
before lint, SAST, build, tests, health, pages, facts, and review. It must use
`validationSetupCommand`, reuse `buildTimeout`, emit phase start/completion
events, store setup output in validation results, and appear first in failure
summaries.

## Touches
Update shared validation/event result types, validation config, local validation
engine ordering, pod-manager config/summaries, and fix-pod feedback context.

## Does not touch
Do not change profile persistence, MCP `validate_locally`, or desktop UI in this
brief.

## Constraints
Setup is a blocking phase. A failed setup stops downstream phases immediately
and sets overall validation to fail. Missing or skipped setup is neutral. Do not
add a new timeout field; use `buildTimeout`.

## Test expectations
Cover phase order, timeout choice, skipped setup, setup failure stopping
downstream phases, setup events/results, and failed-phase summary wording.

## Risks / pitfalls
Existing validation result history will not have `setup`; keep all new fields
optional and clients tolerant of missing data.

## Wrap-up
Before finishing:
1. Run `/simplify` and address its findings.
2. Re-run focused tests named in `contract.yaml`.
3. Commit and push.
