---
title: "Add memory repositories"
touches:
  - packages/daemon/src/pods/memory-repository.ts
  - packages/daemon/src/pods/memory-candidate-repository.ts
  - packages/daemon/src/pods/memory-usage-repository.ts
  - packages/daemon/src/pods/memory-repository.test.ts
  - packages/daemon/src/pods/index.ts
  - packages/daemon/src/index.ts
does_not_touch:
  - packages/daemon/src/pods/pod-manager.ts
  - packages/daemon/src/pods/system-instructions-generator.ts
  - packages/escalation-mcp/
  - packages/desktop/
---

## Task

Add repository support for the schema introduced by brief 01. `MemoryRepository` must keep existing CRUD/search behavior while reading/writing the new structured fields. Add a candidate repository for daemon-curated pending create/update candidates and a usage repository for selected, injected, read, searched, plan_reported, summary_reported, and not_reported events.

Approval of an update candidate must increment the target memory version rather than creating a duplicate. New-memory candidates create a normal profile-scoped approved entry only after approval. Rejection must retain enough candidate state for audit/history but keep it out of active memory selection.

## Touches

- `packages/daemon/src/pods/memory-repository.ts` - preserve CRUD/search and add metadata mapping.
- `packages/daemon/src/pods/memory-candidate-repository.ts` - new candidate CRUD and approval/rejection helpers.
- `packages/daemon/src/pods/memory-usage-repository.ts` - new usage recorder and read APIs for analytics/UI.
- `packages/daemon/src/pods/memory-repository.test.ts` - repository and migration coverage.
- `packages/daemon/src/pods/index.ts` and `packages/daemon/src/index.ts` - export and wire repositories without changing orchestration behavior.

## Does not touch

- `packages/daemon/src/pods/pod-manager.ts` - extraction and selection come later.
- `packages/daemon/src/pods/system-instructions-generator.ts` - briefing comes later.
- `packages/escalation-mcp/` - usage reporting schemas come later.
- `packages/desktop/` - UI consumption comes later.

## Constraints

- Keep `memory_search` keyword behavior intact in this brief.
- Store source evidence as sanitized structured JSON, not as an opaque blob when the type can express it.
- Do not auto-approve durable daemon candidates.
- Pod-scoped memories remain auto-approved and lightweight.

## Test expectations

Add tests for legacy-row mapping, metadata persistence, create-candidate approval, update-candidate approval/version increment, rejection, duplicate/overlap handling, and usage-event insertion/listing.

## Wrap-up

Before finishing:
1. Run `/simplify` and address its findings.
2. Re-run build and tests; both must still pass.
3. Commit and push.
