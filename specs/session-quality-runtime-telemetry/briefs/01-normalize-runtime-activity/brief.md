---
title: "Normalize runtime quality activity"
touches:
  - packages/daemon/src/pods/quality-activity.ts
  - packages/daemon/src/pods/quality-activity.test.ts
  - packages/daemon/src/runtimes/pi-rpc-parser.ts
  - packages/daemon/src/runtimes/pi-rpc-parser.test.ts
  - packages/daemon/src/runtimes/codex-stream-parser.test.ts
does_not_touch:
  - packages/desktop/
  - packages/daemon/src/pods/quality-score-repository.ts
---

## Task

Create normalized inspection and mutation evidence for quality telemetry. Support conservative Codex content-inspection commands, canonical repository paths, and Pi's documented tool-execution records without double counting begin/end events.

## Touches

- `packages/daemon/src/pods/quality-activity.ts`
- `packages/daemon/src/pods/quality-activity.test.ts`
- `packages/daemon/src/runtimes/pi-rpc-parser.ts`
- `packages/daemon/src/runtimes/pi-rpc-parser.test.ts`
- `packages/daemon/src/runtimes/codex-stream-parser.test.ts`

## Does not touch

- `packages/desktop/`
- `packages/daemon/src/pods/quality-score-repository.ts`

## Constraints

Never execute shell text while classifying it. Unknown, mutating, or ambiguous command forms provide no positive inspection evidence. Strip only known workspace prefixes; never use unrestricted suffix matching.

Follow `design.md` contracts for canonical paths and call-ID correlation. Preserve ADR-033's strict Pi RPC adapter boundary and the existing runtime-neutral `AgentEvent` surface.

## Test expectations

Cover recognized and rejected Codex commands, quoting, multiple operands, relative and `/workspace` paths, begin/end call correlation, malformed Pi records, and lowercase Pi `read`, `edit`, and `write` events. Fixtures must prove one logical invocation is counted once.

## Wrap-up

Before finishing:
1. Follow the profile finish prompt, if one is configured.
2. Re-run build and tests; both must still pass.
3. Commit and push.
