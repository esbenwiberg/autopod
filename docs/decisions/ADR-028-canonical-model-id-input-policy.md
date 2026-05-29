# ADR-028: Canonical model ID input policy

## Status

Proposed

## Context

Autopod historically accepted short Claude model aliases such as `opus`, `sonnet`,
and `haiku` in profile defaults and pod creation. Those aliases were convenient
when there was only one obvious current Opus/Sonnet/Haiku target, but they made
model identity noisy in storage, analytics, docs, and Desktop UI.

ADR-022 introduced `MODEL_CANONICAL` so analytics could coalesce historical
`pods.model` rows like `opus` into the canonical model that actually ran at the
time, currently `claude-opus-4-7`. That solved read-side analytics bisection, but
it did not settle the public input policy.

Claude Opus 4.8 introduced a new current Opus ID: `claude-opus-4-8`. If Autopod
keeps accepting `opus` as new input, the same short string would mean "current
Opus" for new profile writes while still meaning "old Opus 4.7" for historical
pod analytics. That split is surprising and makes cost, quality, and UI display
harder to reason about.

## Decision

New model writes use canonical provider model IDs. Short aliases are legacy-only.

Specifically:

- Profile writes reject exact short Claude aliases in `defaultModel`,
  `reviewerModel`, and legacy `escalation.askAi.model`.
- Pod creation rejects exact short Claude aliases in `model` overrides.
- Public docs, CLI templates, and Desktop curated pickers show canonical model
  IDs such as `claude-opus-4-8`, not `opus`.
- Existing profile rows are migrated forward: `opus` becomes
  `claude-opus-4-8`, while `sonnet` and `haiku` become their current canonical
  Claude IDs.
- Historical `pods.model` rows are not rewritten.
- `MODEL_CANONICAL.opus` remains historical and maps to `claude-opus-4-7` so
  old pod analytics continue describing what actually ran.
- Runtime/provider helper alias expansion may remain as defensive read
  compatibility, but it is not a public input contract.
- Short alias price rows in `model-pricing.json` may remain as a legacy-internal
  cost shim until raw cost lookup paths are canonicalized.

## Consequences

Easier:

- Current profile and pod writes persist one canonical model spelling.
- Desktop and CLI users see the real model ID that will be passed to the
  provider.
- Analytics can keep historical truth without making `opus` mean two different
  things in new writes.

Harder:

- External ad hoc scripts that still pass `--model opus` must change to
  `--model claude-opus-4-8`.
- Tests and fixtures that used short aliases as generic Claude placeholders must
  be updated or explicitly marked as legacy-history tests.
- Alias compatibility remains split by intent: profile migration maps `opus`
  forward to 4.8, while historical pod analytics maps `opus` to 4.7.

Committed to:

- Canonical IDs everywhere except legacy cleanup/read paths.
- No `pods.model` rewrite for historical analytics.
- No new runtime controls in this decision. Claude fast mode, effort controls,
  and mid-conversation system-message support are separate feature decisions.
- Follow-up cleanup for short alias price rows is tracked separately in GitHub
  issue #139.

## Alternatives rejected

- **Keep `opus` accepted as public input.** This preserves old convenience but
  makes `opus` ambiguous after Opus 4.8: new profile writes would want it to mean
  4.8, while old pod rows need it to mean 4.7.
- **Rewrite historical `pods.model` rows.** This would hide what was actually
  stored and risk changing historical analytics semantics. Read-side coalescing
  from ADR-022 is the safer boundary.
- **Remove all alias price rows immediately.** Some cost paths still price raw
  historical `pods.model` values through `computeCost` / `effectiveCostUsd`.
  Removing the rows is a separate cost-aggregation refactor.
