---
name: update-ac-schema
depends_on: []
touches:
  - packages/shared/src/types/ac.ts
  - packages/shared/src/series/parse-briefs.ts
  - packages/daemon/src/pods/pod-repository.ts
  - packages/desktop/Sources/AutopodClient/Types/AcDefinition.swift
  - packages/shared/src/types/ac.test.ts
does_not_touch:
  - packages/daemon/src/validation/local-validation-engine.ts
  - packages/desktop/Sources/AutopodUI/**
acceptance_criteria:
  - type: cmd
    outcome: legacy pass/fail keys removed from shared and Swift types
    hint: grep -nE 'pass:|fail:' packages/shared/src/types/ac.ts packages/desktop/Sources/AutopodClient/Types/AcDefinition.swift
    polarity: expect-no-output
  - type: cmd
    outcome: shared package test suite passes with new schema
    hint: npx pnpm --filter @autopod/shared test -- ac
    polarity: exit-zero
---

## Task

Replace `AcDefinition`'s `{ type, test, pass, fail }` shape with
`{ type, outcome, hint?, polarity? }`:

- `outcome` (was `test`) — user-visible criterion description. Required, ≤200 chars.
- `hint` (new, optional) — technical pointer: URL / selector / endpoint /
  shell command. Consumed by `generateAcInstructions` (LLM prompt) and by
  the cmd executor (the actual command). ≤500 chars.
- `polarity` (new, `cmd`-only) — `'expect-output' | 'expect-no-output' | 'exit-zero'`.
  Replaces the regex-scanned `pass:` / `fail:` strings.

Brief frontmatter and DB JSON shapes follow the same schema. No DB migration
— ACs persist as JSON in `pods.acceptance_criteria` TEXT column. No
back-compat parser path.

## Touches

- `packages/shared/src/types/ac.ts` — rewrite `AcDefinition`; add `AcPolarity`.
  Use a discriminated union so TS rejects `polarity` on non-`cmd` types.
- `packages/shared/src/series/parse-briefs.ts:191-201` — read new shape;
  throw `BriefParseError` with line number when given any legacy key
  (`test:`, `pass:`, `fail:`).
- `packages/daemon/src/pods/pod-repository.ts:206` — `parseAcceptanceCriteria`:
  throw on legacy JSON rows (missing `outcome` field). Existing rows must
  be migrated by the wrap-up SQL — see below.
- `packages/desktop/Sources/AutopodClient/Types/AcDefinition.swift` — mirror
  the new shape. Use `String` raw-values for the enums so JSON decode works.
- `packages/shared/src/types/ac.test.ts` (new) — parser + round-trip tests.

## Does not touch

- `packages/daemon/src/validation/local-validation-engine.ts` — owned by brief 03.
- `packages/desktop/Sources/AutopodUI/**` — owned by brief 04.

## Constraints

- No back-compat. Loader must reject legacy shape with a clear error
  including the offending field name.
- `outcome` is required and non-empty.
- `polarity` is only valid when `type === 'cmd'`. TS should refuse to
  compile a literal carrying both `type: 'web'` and `polarity: ...`.
- Swift mirror must use `String` raw-values (`expect-output` etc.) so the
  JSON wire format matches TS exactly.

## Test expectations

- Round-trip serialize → parse for all three polarity values.
- Parser throws with line number when given legacy `test:`, `pass:`, or
  `fail:` keys at the AC level.
- Brief frontmatter happy path: a YAML doc with one of each type parses
  cleanly and the resulting `AcDefinition[]` matches the input shape.
- Negative: a `web` AC carrying `polarity: exit-zero` is rejected.

## Wrap-up

Before merging this brief, run the following in the dev daemon to clear any
legacy `pods.acceptance_criteria` rows that would otherwise crash on read:

```sh
sqlite3 ./autopod.db \
  "UPDATE pods SET acceptance_criteria = NULL \
   WHERE acceptance_criteria LIKE '%\"pass\"%' \
      OR acceptance_criteria LIKE '%\"fail\"%';"
```

Note this in the PR body. In-flight pods at the moment of cutover will lose
their AC results — this is the accepted trade-off per the plan
(`in-flight-pods: null-ok`). Drain the queue first if you can.
