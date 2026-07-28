---
title: "Integrate confidence-aware quality signals"
touches:
  - packages/shared/src/types/pod.ts
  - packages/daemon/src/pods/quality-signals.ts
  - packages/daemon/src/pods/quality-signals.test.ts
  - packages/daemon/src/pods/quality-score.ts
  - packages/daemon/src/pods/quality-score.test.ts
  - packages/daemon/src/api/routes/pods.test.ts
does_not_touch:
  - packages/desktop/
  - packages/daemon/src/db/migrations/
---

## Task

Integrate normalized activity into the live quality contract. Make inspection-dependent values explicitly unavailable when evidence is incomplete, count distinct blind files, and use only agent-authored prose for tell detection.

## Touches

- `packages/shared/src/types/pod.ts`
- `packages/daemon/src/pods/quality-signals.ts`
- `packages/daemon/src/pods/quality-signals.test.ts`
- `packages/daemon/src/pods/quality-score.ts`
- `packages/daemon/src/pods/quality-score.test.ts`
- `packages/daemon/src/api/routes/pods.test.ts`

## Does not touch

- `packages/desktop/`
- `packages/daemon/src/db/migrations/`

## Constraints

Keep Claude behavior compatible. A genuine measured zero must remain distinct from unavailable telemetry, and unavailable inspection evidence must not create a red grade or reading/blind-edit score penalty.

Provider-continuity pods can contain events from multiple runtimes, so consume normalized evidence per event rather than trusting only the final mutable pod runtime. Do not retune unrelated score weights or UI thresholds.

## Test expectations

Cover Codex read-before-edit, canonical path comparison, repeated modifications to one unread file, unavailable telemetry scoring, tool-output tell false positives, and unchanged Claude read/edit behavior. Include route-level serialization coverage for the live availability shape.

## Wrap-up

Before finishing:
1. Follow the profile finish prompt, if one is configured.
2. Re-run build and tests; both must still pass.
3. Commit and push.
