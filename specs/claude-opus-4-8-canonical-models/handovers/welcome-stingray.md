# Handover - welcome-stingray

## Built

- Added `claude-opus-4-8` to shared bundled pricing with the same input,
  cached-input, and output prices as `claude-opus-4-7`.
- Added shared model identity constants for the current Claude default,
  reviewer model, and legacy short aliases.
- Updated profile and pod schemas so exact short aliases `opus`, `sonnet`, and
  `haiku` are rejected for new model-bearing writes while canonical IDs are
  accepted and nullable profile inheritance is preserved. Both schemas use the
  shared `withCanonicalModelIdPolicy()` helper.
- Wrote ADR-028 and regenerated the generated decisions index.

No deviations from the brief scope.

## Downstream Contracts

- `CLAUDE_DEFAULT_MODEL` is now `claude-opus-4-8`.
- `CLAUDE_REVIEWER_MODEL` is now `claude-sonnet-4-6`.
- `LEGACY_CLAUDE_MODEL_ALIASES` defines the exact rejected aliases:
  `opus`, `sonnet`, `haiku`.
- `withCanonicalModelIdPolicy()` is the shared Zod refinement helper for applying
  the canonical-ID new-write policy.
- `MODEL_CANONICAL.opus` intentionally remains `claude-opus-4-7` for historical
  pod analytics. Do not consume it as the current default.
- `model-pricing.json` still carries short alias rows only as legacy pricing
  shims pending GitHub issue #139.

## Files To Treat As Owned

- `packages/shared/src/pricing/index.ts`
- `packages/shared/src/pricing/model-pricing.json`
- `packages/shared/src/schemas/profile.schema.ts`
- `packages/shared/src/schemas/pod.schema.ts`
- `packages/shared/src/schemas/model.schema.ts`
- `docs/decisions/ADR-028-canonical-model-id-input-policy.md`

Downstream pods should avoid changing these contracts unless their brief
explicitly extends the canonical model policy.

## Landmines

- Do not create a daemon migration in this brief's branch follow-up unless you
  are working brief 02.
- Do not change `MODEL_CANONICAL.opus` to Opus 4.8; that would corrupt
  historical analytics by reinterpreting old `pods.model = 'opus'` rows.
- Profile schema defaults now materialize canonical model IDs, but existing
  stored profile rows still need the daemon migration from the next brief.
