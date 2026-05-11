# Handover — rival-ermine (Brief 01: AC schema v2)

## What was built

Replaced the `AcDefinition` v1 shape `{ type, test, pass, fail }` with the v2 shape `{ type, outcome, hint?, polarity? }`:

- **`packages/shared/src/types/ac.ts`** — Rewrote `AcDefinition` as a discriminated union: `none | api | web` branches have `{ type, outcome, hint? }`; the `cmd` branch adds `polarity?: AcPolarity`. TypeScript refuses to compile `{ type: 'web', polarity: ... }` literals.
- **`packages/shared/src/errors.ts`** + **`packages/shared/src/index.ts`** — Added `BriefParseError` exported from the shared package.
- **`packages/shared/src/series/parse-briefs.ts`** — `parseBriefFrontmatter` now calls `validateAcItems` which throws `BriefParseError` (with best-effort line number) when any AC item has a `test`, `pass`, or `fail` key. The markdown-section fallback path now emits `{ type: 'none', outcome }` instead of the v1 shape.
- **`packages/daemon/src/pods/pod-repository.ts`** — `parseAcceptanceCriteria` now throws when it finds a legacy-shape row (missing `outcome`, or `test`/`pass`/`fail` present).
- **`packages/desktop/Sources/AutopodClient/Types/AcDefinition.swift`** — Mirrored v2 shape with `outcome`, `hint?`, `polarity?`. Added `AcPolarity` enum with `String` raw-values (`"expect-output"`, `"expect-no-output"`, `"exit-zero"`).
- **`packages/shared/src/types/ac.test.ts`** (new) — Round-trip tests for all three polarity values, BriefParseError tests for each legacy key, happy-path frontmatter tests, and `@ts-expect-error` compile-time guards.
- Several existing test files updated to use v2 shape.

## Deviations

**Brief said "does not touch" `local-validation-engine.ts`**, but it had ~20 references to `ac.test`, `ac.pass`, `ac.fail` that would have failed TypeScript DTS generation. Minimal rename-only changes were applied (`ac.test` → `ac.outcome`; `ac.pass`/`ac.fail` refs to `AcDefinition` were removed from ClassifiedAc construction). The engine logic was NOT changed — brief 03 must complete the proper overhaul (replacing the `pass`-based polarity detection in `executeCmdChecks` with `ac.polarity`, and wiring `ac.hint` into `generateAcInstructions`).

The same minimal rename was applied to `system-instructions-generator.ts`, `plan-evaluator.ts`, and `pod-manager.ts` for the same compilation reason.

## Interfaces changed — downstream pods must know

### TypeScript contract (`packages/shared/src/types/ac.ts`)

```ts
export type AcPolarity = 'expect-output' | 'expect-no-output' | 'exit-zero';

export type AcDefinition =
  | (AcBase & { type: 'none' })
  | (AcBase & { type: 'api' })
  | (AcBase & { type: 'web' })
  | (AcBase & { type: 'cmd'; polarity?: AcPolarity });

// where AcBase = { outcome: string; hint?: string }
```

### YAML frontmatter shape

```yaml
acceptance_criteria:
  - type: web
    outcome: /pr-dashboard renders with the header bar
    hint: /pr-dashboard
  - type: cmd
    outcome: legacy keys removed from shared types
    hint: grep -n 'pass:\|fail:' packages/shared/src/types/ac.ts
    polarity: expect-no-output
```

### DB JSON

`pods.acceptance_criteria` TEXT column must contain JSON arrays of v2-shape objects. The wrap-up SQL to clear legacy rows:
```sql
UPDATE pods SET acceptance_criteria = NULL
WHERE acceptance_criteria LIKE '%"pass"%'
   OR acceptance_criteria LIKE '%"fail"%';
```

## Files I own — do NOT modify without good reason

- `packages/shared/src/types/ac.ts` — the contract
- `packages/shared/src/series/parse-briefs.ts` — legacy key rejection logic
- `packages/desktop/Sources/AutopodClient/Types/AcDefinition.swift` — Swift mirror

## What brief 03 must finish in `local-validation-engine.ts`

The engine was renamed to compile but NOT logically updated:

1. **`isCommandLikeAc`** still checks `ac.outcome`. Brief 03 should check `ac.hint` instead (or both).
2. **`executeCmdChecks`** uses `ac.criterion` (the outcome text) as the shell command. It should use `ac.hint` as the actual command.
3. **`expectNoOutput`** (polarity detection) still reads `ClassifiedAc.pass` via `NEGATIVE_HINTS` regex scan. It should read `ac.polarity` from the enriched classification instead.
4. **`generateAcInstructions`** no longer has pass/fail hints to show the LLM (they were stripped). Brief 03 should thread `ac.hint` into the prompt when present.
5. **`ClassifiedAc.pass`/`.fail`** are no longer populated from AcDefinition. Brief 03 can remove those fields from ClassifiedAc or repurpose them.

## Discovered constraints / landmines

- `AcDefinition` is a discriminated union, not an interface. Code that does `ac as Record<string, unknown>` will fail TypeScript DTS build — must use `ac as unknown as Record<string, unknown>` (already done in parse-briefs.ts).
- `AutopodUI` Swift files (`CreatePodSheet.swift`, `ValidationTab.swift`, `MockData.swift`) still reference `criterion.test` and `AcDefinition(test:)`. These are owned by brief 04.
- Build is `tsup` with `dts: true` which runs the TypeScript type checker — all packages must compile cleanly, not just transpile.
- `parseAcceptanceCriteria` in `pod-repository.ts` initially wrapped its whole body in a `try/catch { return null }`, which silently swallowed the legacy-key throws. Fixed on commit 22eb7d0: only `JSON.parse` is in the catch (returns null for malformed JSON / non-array); schema validation errors (`field "test" found`, missing `outcome`) now propagate as intended. Tests in `pod-repository.test.ts::parseAcceptanceCriteria (legacy shape detection)` cover all four throw paths.

## Cutover landmine — validation harness incompatibility

This brief is the cutover step itself, and that creates a chicken-and-egg with the running host daemon:

1. The brief frontmatter is authored in v2 shape (outcome/hint/polarity) — the very shape this brief introduces.
2. The host autopod daemon (still on v1 trunk when this pod ran) parses that brief, finds no `test`/`pass`/`fail` keys, and stores the v2-shape JSON in `pods.acceptance_criteria`.
3. The host daemon's v1 `local-validation-engine.ts` calls `baseText(ac.test)` in `deduplicateAcsByBaseText`. `ac.test` is undefined for v2-shape rows, so `.replace(...)` throws `TypeError: Cannot read properties of undefined (reading 'replace')`.
4. `pod-manager.ts:6520-6557` catches that and synthesises a fake validation result with `build.status='fail' / output=String(err)` and `health.status='fail' / url=''`. That is exactly the failure message shown to the agent on attempt 1/3 of this pod.

The brief's "Reversibility" section anticipates the *forward* direction (v2 daemon reading v1 rows) and provides wrap-up SQL to NULL legacy rows. The *inverse* (v1 daemon reading v2 rows) was implicit in the `in-flight-pods: null-ok` greenlight: drain the queue before deploying v2, accept that any in-flight pod loses its AC results.

**For brief 02+**: this validation gate will keep failing until the host daemon is itself running v2 code. The blocker has been reported. Mitigations available to a reviewer:

- (a) deploy this branch's daemon to the host machine before re-validating,
- (b) `UPDATE pods SET acceptance_criteria = NULL WHERE id = '<pod-id>'` on the host autopod.db so the v1 validator skips AC processing for the bootstrap pods,
- (c) approve / merge brief 01 manually so subsequent briefs see a v2 daemon.

My pod's build, tests, daemon-startup, and `/health` all pass cleanly (verified via `validate_locally` and manual curl) — the failure is entirely a v1-host vs v2-brief schema collision.
