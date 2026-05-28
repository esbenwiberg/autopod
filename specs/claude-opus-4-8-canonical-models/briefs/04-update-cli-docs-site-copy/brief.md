---
title: "Update CLI template docs and website copy"
touches:
  - packages/cli/src/commands/profile.ts
  - README.md
  - website/index.html
  - scripts/check-canonical-model-copy.sh
does_not_touch:
  - packages/shared/src/
  - packages/daemon/src/db/migrations/
  - packages/desktop/
---

## Task

Update public copy and the CLI profile template so new examples use canonical
model IDs only. Do not say `opus`, `sonnet`, or `haiku` are accepted. Update
stale escalation docs so `ask_ai` is described as using `profile.reviewerModel`;
keep `escalation.askAi.model` out of public examples except if explicitly
labeled legacy wire compatibility.

## Touches

Update `packages/cli/src/commands/profile.ts`, `README.md`,
`website/index.html`, and add a small smoke script for canonical model copy.

## Does not touch

Do not change shared schemas, daemon migrations, runtime behavior, or desktop
source in this brief.

## Constraints

Use `claude-opus-4-8` in docs/examples for Opus. Use `claude-sonnet-4-6` for
reviewer/ask_ai examples. Do not document short aliases as accepted inputs.

## Test expectations

Add `scripts/check-canonical-model-copy.sh` with focused greps over README,
website, and CLI template. The script should fail when public examples contain
`--model opus`, `model: opus`, `model: sonnet`, or the old claim that
`escalation.askAi.model` is the task-review model.

## Wrap-up

Before finishing:

1. Run `/simplify` and address its findings.
2. Re-run build and tests; both must still pass.
3. Commit and push.
