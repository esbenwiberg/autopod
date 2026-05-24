---
title: "Select and inject relevant memories"
touches:
  - packages/daemon/src/pods/memory-selector.ts
  - packages/daemon/src/pods/memory-selector.test.ts
  - packages/daemon/src/pods/system-instructions-generator.ts
  - packages/daemon/src/pods/system-instructions-generator.test.ts
  - packages/daemon/src/pods/pod-manager.ts
  - packages/shared/src/constants.ts
does_not_touch:
  - packages/escalation-mcp/
  - packages/desktop/
  - packages/daemon/src/pods/memory-candidate-recorder.ts
---

## Task

Select relevant memories before the pod starts and inject a small, useful briefing into system instructions. Replace the old `## Available Memory` index with `## Relevant Memory`, capped at five entries, including memory content and the reviewer-model explanation of why each entry matters now.

The selector uses deterministic prefiltering plus reviewer-model ranking. No embeddings, vector DB, or semantic-search claims. If reviewer ranking fails, fail soft: still start the pod, record a fallback/skipped reason, and expose that memory was unavailable rather than silently unused.

## Touches

- `packages/daemon/src/pods/memory-selector.ts` - prefilter, reviewer-rank, fallback, and usage selection records.
- `packages/daemon/src/pods/system-instructions-generator.ts` - render top-5 `Relevant Memory`.
- `packages/daemon/src/pods/pod-manager.ts` - call selector before `generateSystemInstructions`.
- `packages/daemon/src/pods/memory-selector.test.ts` - selection behavior.
- `packages/daemon/src/pods/system-instructions-generator.test.ts` - instruction rendering behavior.
- `packages/shared/src/constants.ts` - retire or reduce the old `MAX_MEMORY_INDEX_ENTRIES` usage.

## Does not touch

- `packages/escalation-mcp/` - reporting schemas are brief 05.
- `packages/desktop/` - UI comes later.
- `packages/daemon/src/pods/memory-candidate-recorder.ts` - extraction is brief 03.

## Constraints

- Applies only to agent-driven pods.
- Candidate memories are not injected until approved.
- Existing globals may be injected only if strongly relevant.
- Pod-scoped ephemeral memories stay as-is and may be included for downstream series pods when scope allows.
- Profile reviewer model fallback: `profile.reviewerModel || profile.defaultModel || pod.model || "claude-haiku-4-5"`.

## Test expectations

Cover top-5 cap, content injection, rationale injection, no old 100-entry index, profile/global/pod ordering boundaries, global strong relevance gate, fail-soft fallback records, and selected/injected usage rows.

## Wrap-up

Before finishing:
1. Run `/simplify` and address its findings.
2. Re-run build and tests; both must still pass.
3. Commit and push.
