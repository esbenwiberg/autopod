---
title: "Enforce structured reviewer responses and typed failures"
touches:
  - packages/shared/src/types/validation.ts
  - packages/daemon/src/validation/review-structured-output.ts
  - packages/daemon/src/validation/review-structured-output.test.ts
  - packages/daemon/src/validation/review-batch-runner.ts
  - packages/daemon/src/validation/review-batch-runner.test.ts
  - packages/daemon/src/validation/container-reviewer-runner.ts
  - packages/daemon/src/validation/container-reviewer-runner.test.ts
  - packages/daemon/src/validation/review-codex-runner.ts
  - packages/daemon/src/validation/review-codex-runner.test.ts
  - packages/daemon/src/runtimes/run-claude-cli.ts
  - packages/daemon/src/images/
  - templates/base/
does_not_touch:
  - packages/daemon/src/validation/review-ledger.ts
  - packages/desktop/
---

## Task

Build the fail-closed structured response boundary for frozen review-council axis calls and expose accurate typed failures. Use provider-native schema-constrained output for the pinned Claude and Codex CLI paths where supported, with strict local validation in every case.

Axis responses must be bounded and schema-valid before they count as completed. Retry one invalid response once with a stable validation error code and the same frozen packet. Never echo or persist malformed output.

## Required Behavior

- Add one reusable daemon structured-output module with strict axis response validation.
- Safely unwrap known provider/CLI envelopes and harmless JSON fences.
- Enforce response/finding count and field bounds, enums, positive line numbers, confidence range, and strict required fields.
- Keep changed-file filtering and daemon-derived IDs.
- Add an optional output contract to the generic container reviewer path.
- Wire native schema flags/files for the pinned Claude and Codex versions; verify exact capabilities rather than guessing.
- If an older cached image cannot constrain generation natively, permit prompt-only generation only when identical strict local validation remains in force.
- Retry invalid syntax/schema/semantic output once. The correction prompt contains a stable validation code, not raw output.
- Preserve numeric attempt count and legacy error while adding typed bounded failure metadata.
- Classify invalid response, timeout, provider unavailable, runner failure, and HEAD change separately.
- Ensure token usage includes retry calls.

## Constraints

- Malformed output can never become a completed axis.
- Do not coerce missing evidence, remediation, path, or severity into validity.
- Do not execute or re-prompt with model output.
- Do not include prompt/diff/raw output/credentials in persisted failure diagnostics.
- Keep response maximum at 1 MB and cap axis findings at 100.
- Temporary prompt/schema/output/log files must be uniquely named and cleaned up.
- Do not redesign synthesis or ledger behavior in this brief beyond the minimum hooks needed by Brief 02.
- All new shared wire fields must be optional for historical compatibility.

## Test Expectations

- Valid plain JSON, supported CLI envelope JSON, and one fenced JSON object parse successfully.
- Unknown fields, invalid enums, missing required evidence, oversized output, excessive findings, and invalid confidence/line fail validation.
- A malformed first response followed by valid output completes on attempt two.
- The second prompt includes a stable validation code and excludes malformed output.
- Two malformed responses produce an unavailable axis with `invalid-response` failure kind.
- Timeout, provider, runner, and HEAD drift produce distinct typed failures.
- Native schema command construction is covered for Claude and Codex.
- A typed failure can never yield a passing batch.

## Wrap-up

Run focused daemon tests, then `npx pnpm --filter @autopod/shared test` and `npx pnpm --filter @autopod/daemon test`. Commit and push before completion.
