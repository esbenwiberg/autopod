---
title: "Canonicalize daemon migration and runtime paths"
touches:
  - packages/daemon/src/db/migrations/110_canonicalize_profile_model_aliases.sql
  - packages/daemon/src/db/migrate.test.ts
  - packages/daemon/src/pods/runtime-resolver.ts
  - packages/daemon/src/pods/runtime-resolver.test.ts
  - packages/daemon/src/runtimes/claude-runtime.ts
  - packages/daemon/src/runtimes/claude-runtime.test.ts
  - packages/daemon/src/providers/llm-client.ts
  - packages/daemon/src/providers/llm-client.test.ts
  - packages/daemon/src/profiles/
  - packages/daemon/src/test-utils/mock-helpers.ts
does_not_touch:
  - packages/shared/src/pricing/model-pricing.json
  - packages/desktop/
  - README.md
  - website/index.html
---

## Task

Migrate existing profile model aliases to canonical IDs and update daemon
runtime model resolution so current Claude work defaults to `claude-opus-4-8`.
Historical pod analytics must continue treating old `pods.model = 'opus'` rows
as Opus 4.7.

## Touches

Create migration 110 after checking the highest migration prefix. Update
migration tests, runtime resolver tests, Claude runtime model argument tests,
daemon-side Anthropic helper alias tests, and daemon profile test fixtures that
now violate the shared no-short-alias input policy.

## Does not touch

Do not change shared pricing aliases or analytics coalescing to 4.8. Do not add
Claude fast mode, effort controls, or mid-conversation system-message support.
Do not change desktop or docs in this brief.

## Constraints

Follow `design.md` -> Contracts. Migration rules: `default_model = 'opus'`
becomes `claude-opus-4-8`; `reviewer_model = 'opus'` and legacy
`escalation_config.askAi.model = 'opus'` also become `claude-opus-4-8`.
`sonnet` and `haiku` become their current canonical IDs. Explicit full IDs such
as `claude-opus-4-7` are not rewritten. Do not rewrite `pods.model`.

## Test expectations

Add a migration test that seeds aliases in `default_model`, `reviewer_model`,
and valid JSON `escalation_config.askAi.model`, runs migrations, and asserts
canonical values. Add resolver tests for default Opus 4.8, canonical explicit
Opus 4.7 staying accepted, and short override rejection. Add Claude runtime and
LLM client tests for defensive alias expansion.

## Risks / pitfalls

The migration runner keys on numeric prefixes; do not reuse prefix 109. The
current next prefix is 110. SQLite JSON1 is already used in prior migrations and
can be used for `escalation_config`.

## Wrap-up

Before finishing:

1. Run `/simplify` and address its findings.
2. Re-run build and tests; both must still pass.
3. Commit and push.
