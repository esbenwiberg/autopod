---
name: update-validation-engine
depends_on: [update-ac-schema]
touches:
  - packages/daemon/src/validation/local-validation-engine.ts
  - packages/daemon/src/validation/local-validation-engine.test.ts
  - packages/daemon/src/validation/classify-ac-types.test.ts
does_not_touch:
  - packages/shared/**
  - packages/desktop/**
  - specs/**
acceptance_criteria:
  - type: api
    outcome: a declared web AC starting with "/pr-dashboard" survives classifyAcTypes as type=web
    hint: POST /pods with a profile carrying { type: 'web', outcome: '/pr-dashboard renders with header', hint: '/pr-dashboard' }; assert pods[0].acceptanceCriteria[0].type === 'web'
  - type: cmd
    outcome: NEGATIVE_HINTS regex-scanning dead code is removed
    hint: grep -n 'NEGATIVE_HINTS\|expectNoOutput' packages/daemon/src/validation/local-validation-engine.ts
    polarity: expect-no-output
  - type: cmd
    outcome: cmd executor reads ac.polarity directly
    hint: grep -n 'ac.polarity' packages/daemon/src/validation/local-validation-engine.ts
    polarity: expect-output
  - type: cmd
    outcome: daemon validation test suite passes
    hint: npx pnpm --filter @autopod/daemon test -- classify-ac-types local-validation-engine
    polarity: exit-zero
---

## Task

Four surgical changes to `local-validation-engine.ts`. This is the brief
that actually closes the `confidential-loon` bug.

### 1. Tighten the slash-command regex

In `COMMAND_LIKE_AC_PATTERNS` (≈line 1131–1144), replace:

```ts
/^\/[a-z]/i,  // /simplify, /review, /fix etc. (slash commands)
```

with:

```ts
/^\/[a-z][a-z0-9-]*\s*$/i,  // single-token slash commands only
```

This still catches `/simplify`, `/review`, `/fix`, but no longer catches
user-written outcomes like `/pr-dashboard renders with the header bar`.

### 2. Trust declared web / api types in classifyAcTypes

In `classifyAcTypes` (≈line 1163–1297), the pre-pass currently runs
`isCommandLikeAc()` against every AC regardless of declared type, then
force-converts matches to `'none'`. Gate that override:

```ts
if (isCommandLikeAc(ac.outcome) && (ac.type === 'cmd' || ac.type == null)) {
  return { ...ac, type: 'none' };
}
```

A declared `web` or `api` AC must survive intact — even if the outcome
text happens to match the (now-tightened) regex.

### 3. Replace NEGATIVE_HINTS with ac.polarity

`executeCmdChecks` (≈line 1953–2023) currently inspects the (now-removed)
`pass:` string with `NEGATIVE_HINTS` regexes to choose between
expect-output / expect-no-output. Delete that whole block. Read
`ac.polarity` directly:

```ts
const expectsOutput   = ac.polarity === 'expect-output';
const expectsNoOutput = ac.polarity === 'expect-no-output';
// exit-zero (default for cmd): trust exit code only, ignore stdout content
```

### 4. Thread ac.hint into LLM prompts

`generateAcInstructions` (≈line 1563–1622) builds the prompt that turns an
AC into browser steps or curl commands. When `ac.hint` is present, append
a separate line:

- `web` → `Page hint: ${ac.hint}`
- `api` → `Endpoint hint: ${ac.hint}`
- `cmd` → no hint line (the hint IS the command; the executor reads it
  directly via `ac.hint`, not via the LLM)

The outcome stays the primary signal; the hint is supplementary context
the model uses when the outcome is ambiguous.

## Touches

- `packages/daemon/src/validation/local-validation-engine.ts` — the four
  changes above.
- `packages/daemon/src/validation/local-validation-engine.test.ts` — extend
  existing tests with the regression case.
- `packages/daemon/src/validation/classify-ac-types.test.ts` (new) —
  tabular tests for every combination of declared type × outcome shape ×
  polarity.

## Does not touch

- `packages/shared/**` — schema is brief 01's job.
- `packages/desktop/**` — UI is brief 04's job.
- `specs/**` — migration is brief 02's job.

## Constraints

- The cmd executor must still default to `polarity: exit-zero` when an AC
  has no polarity set (defensive, since the type system allows the field
  to be absent).
- LLM prompts must not include the `Page hint:` / `Endpoint hint:` line
  when `ac.hint` is empty or whitespace.

## Test expectations

- New tabular test in `classify-ac-types.test.ts`:
  - declared `web` + outcome `/pr-dashboard renders with header` + hint
    `/pr-dashboard` → result type is `web`. **This is the regression case
    for `confidential-loon`.**
  - declared `cmd` + outcome `/review`  → result type is `none` (single-token
    slash command, override applies because declared `cmd`).
  - declared `cmd` + outcome `grep foo bar.ts` + polarity `expect-no-output`
    → result type is `cmd`.
  - undeclared type + outcome `/fix` → result type is `none`.
- Existing tests in `local-validation-engine.test.ts` must continue to
  pass after the NEGATIVE_HINTS deletion.

## Wrap-up

The api-style AC at the top of `acceptance_criteria` is the firing check
the rest of the spec hinges on. If the integration runner can't do
`POST /pods` + read response, escalate immediately — fall back to a
vitest integration test that constructs a `Pod` in-process and asserts
`classifyAcTypes` preserves the type. Don't silently turn the AC into a
structural grep.
