---
title: "Establish canonical model identity contracts"
touches:
  - docs/decisions/ADR-028-canonical-model-id-input-policy.md
  - docs/decisions/index.md
  - packages/shared/src/pricing/model-pricing.json
  - packages/shared/src/pricing/index.ts
  - packages/shared/src/pricing/index.test.ts
  - packages/shared/src/schemas/profile.schema.ts
  - packages/shared/src/schemas/profile.schema.test.ts
  - packages/shared/src/schemas/pod.schema.ts
  - packages/shared/src/schemas/pod.schema.test.ts
does_not_touch:
  - packages/daemon/src/db/migrations/
  - packages/desktop/
---

## Task

Add Claude Opus 4.8 as the current canonical Opus model in shared model
identity, pricing, and validation. New profile and pod writes must use canonical
model IDs; short aliases are legacy-only. Write ADR-028 to capture this policy
and update the generated ADR index.

## Touches

Touch the shared pricing files, shared profile and pod schemas, the new shared
schema tests, and the model identity ADR.

## Does not touch

Do not create database migrations, daemon runtime changes, desktop changes, or
docs/site copy in this brief.

## Constraints

Follow `design.md` -> Contracts. Honor ADR-015 and ADR-022: pricing remains
bundled JSON, and historical pod analytics still coalesces `opus` to
`claude-opus-4-7`. Keep short alias price rows as legacy-internal pending GitHub
issue #139. Do not add fast mode, effort controls, or mid-conversation
system-message support.

## Test expectations

Update shared pricing tests to assert `claude-opus-4-8` exists and costs the
same as Opus 4.7. Add shared profile schema tests that reject exact short
aliases `opus`, `sonnet`, and `haiku` in `defaultModel`, `reviewerModel`, and
`escalation.askAi.model`, while preserving null inheritance. Update pod schema
tests to reject exact short aliases in create-pod model overrides and accept
canonical Claude IDs.

## Risks / pitfalls

Do not remap `MODEL_CANONICAL.opus` to 4.8. That map describes historical
`pods.model` rows and must stay on 4.7. Do update comments so short price rows
are described as legacy shims, not public input.

## Wrap-up

Before finishing:

1. Run `/simplify` and address its findings.
2. Re-run build and tests; both must still pass.
3. Commit and push.
