# Design - Claude Opus 4.8 canonical models

## Blast radius

Shared model identity and validation:

- `packages/shared/src/pricing/model-pricing.json`
- `packages/shared/src/pricing/index.ts`
- `packages/shared/src/pricing/index.test.ts`
- `packages/shared/src/schemas/profile.schema.ts`
- `packages/shared/src/schemas/profile.schema.test.ts`
- `packages/shared/src/schemas/pod.schema.ts`
- `packages/shared/src/schemas/pod.schema.test.ts`

Daemon migration and runtime paths:

- `packages/daemon/src/db/migrations/110_canonicalize_profile_model_aliases.sql`
- `packages/daemon/src/db/migrate.test.ts`
- `packages/daemon/src/pods/runtime-resolver.ts`
- `packages/daemon/src/pods/runtime-resolver.test.ts`
- `packages/daemon/src/runtimes/claude-runtime.ts`
- `packages/daemon/src/runtimes/claude-runtime.test.ts`
- `packages/daemon/src/providers/llm-client.ts`
- `packages/daemon/src/providers/llm-client.test.ts`
- `packages/daemon/src/profiles/`
- `packages/daemon/src/test-utils/mock-helpers.ts`

Desktop:

- `packages/desktop/Sources/AutopodUI/Models/RuntimeModelOptions.swift`
- `packages/desktop/Tests/AutopodUITests/RuntimeModelOptionsTests.swift`
- `packages/desktop/Sources/AutopodUI/Models/Profile.swift`
- `packages/desktop/Sources/AutopodClient/Types/ProfileResponse.swift`
- `packages/desktop/Sources/AutopodDesktop/Mapping/ProfileMapper.swift`
- `packages/desktop/Sources/AutopodUI/Views/Profiles/ProfileEditorView.swift`
- `packages/desktop/Sources/AutopodUI/Views/Profiles/ProfileFieldCatalog.swift`
- `scripts/check-desktop-canonical-models.sh`

CLI and public copy:

- `packages/cli/src/commands/profile.ts`
- `README.md`
- `website/index.html`
- `scripts/check-canonical-model-copy.sh`

Durable decisions:

- `docs/decisions/ADR-028-canonical-model-id-input-policy.md`
- `docs/decisions/index.md`

## Seams

Brief 01 owns the shared model contract. It adds Opus 4.8 pricing, the
new-write alias rejection policy, and ADR-028. Later briefs must consume that
contract rather than redefining alias behavior.

Brief 02 owns daemon persistence and execution. It applies the profile migration
and updates runtime/default paths so resolved current Claude work uses
`claude-opus-4-8`. It must not change historical pod analytics mapping.

Brief 03 owns Desktop presentation. It consumes the canonical ID contract and
updates picker/default/help behavior without changing daemon or shared schemas.

Brief 04 owns CLI template and public docs/site copy. It consumes the canonical
ID contract and removes public alias examples.

## Contracts

### Canonical new-write policy

New writes reject exact short aliases:

```ts
const LEGACY_CLAUDE_MODEL_ALIASES = new Set(['opus', 'sonnet', 'haiku']);
```

The rejection applies to:

- `createPodRequestSchema.model`
- `createProfileSchema.defaultModel`
- `updateProfileSchema.defaultModel`
- `createProfileSchema.reviewerModel`
- `updateProfileSchema.reviewerModel`
- `createProfileSchema.escalation.askAi.model`
- `updateProfileSchema.escalation.askAi.model`

Null profile values keep their existing inheritance semantics.

### Current model IDs

Current Claude defaults after the feature:

```ts
export const CLAUDE_DEFAULT_MODEL = 'claude-opus-4-8';
export const CLAUDE_REVIEWER_MODEL = 'claude-sonnet-4-6';
```

`claude-opus-4-7` remains accepted when explicitly provided as a full canonical
ID; it is no longer the curated Opus default.

### Profile migration mapping

Migration 110 rewrites profile-owned aliases:

| Existing value | New profile value |
| --- | --- |
| `opus` | `claude-opus-4-8` |
| `sonnet` | `claude-sonnet-4-6` |
| `haiku` | `claude-haiku-4-5` |

Fields:

- `profiles.default_model`
- `profiles.reviewer_model`
- `profiles.escalation_config` at JSON path `$.askAi.model` when JSON is valid

The migration does not rewrite `pods.model`.

### Historical analytics mapping

`MODEL_CANONICAL` remains historical:

```ts
export const MODEL_CANONICAL = {
  opus: 'claude-opus-4-7',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5',
};
```

Do not change `MODEL_CANONICAL.opus` to `claude-opus-4-8`.

### Legacy pricing shim

Short alias rows may remain in `model-pricing.json` only as a legacy-internal
shim for raw cost lookup paths. Comments and tests should describe them as
legacy, not supported new input. Follow-up cleanup is GitHub issue #139.

### Ask AI model ownership

`ask_ai` uses `profile.reviewerModel` through `PodBridge.callReviewerModel()` and
`PodBridge.getReviewerModel()`. `escalation.askAi.model` remains a legacy payload
shape only; new public copy and Desktop controls should not present it as the
active reviewer/consultation model.

## UX flows

Desktop profile editor:

1. User opens an existing profile.
2. Default Model picker shows curated Claude options with Opus 4.8 first for
   Claude runtime.
3. Reviewer Model picker shows canonical reviewer options.
4. Existing explicit `claude-opus-4-7` values remain displayable if already
   stored, but Opus 4.7 is not the curated Opus default.
5. Escalation settings no longer show a separate short-alias "Ask AI model"
   control; users use Reviewer Model.

No wireframe is required because this feature does not add a new screen or
significantly rearrange the profile editor. It updates values/copy and removes a
stale field from an existing surface.

CLI/docs:

1. User reads README, website examples, or opens the CLI profile template.
2. New examples show canonical IDs such as `claude-opus-4-8`.
3. No public example claims `opus`, `sonnet`, or `haiku` are accepted new input.
4. Escalation copy points at `profile.reviewerModel` for AI review and `ask_ai`.

## Reference reading

- `AGENTS.md` - repo validation and migration prefix rules.
- `docs/conventions/convention-001-autopod-self-required-facts.md` - Desktop
  SwiftUI/AppKit validation is not a Linux pod required fact.
- `docs/decisions/ADR-015-model-pricing-bundled-json.md` - pricing stays bundled
  JSON.
- `docs/decisions/ADR-022-model-canonical-alias-map.md` - analytics coalesces
  historical aliases through `MODEL_CANONICAL`.
- `docs/decisions/ADR-026-parser-side-cost-for-non-claude-runtimes.md` - parser
  cost uses shared pricing.
- `packages/shared/src/pricing/index.ts` - pricing and canonical alias helper.
- `packages/shared/src/schemas/profile.schema.ts` - profile model-bearing fields.
- `packages/shared/src/schemas/pod.schema.ts` - pod create model override.
- `packages/daemon/src/pods/runtime-resolver.ts` - daemon runtime/model defaults.
- `packages/daemon/src/runtimes/claude-runtime.ts` - Claude Code CLI `--model`
  argument construction.
- `packages/daemon/src/providers/llm-client.ts` - daemon-side Anthropic helper
  alias expansion.
- `packages/desktop/Sources/AutopodUI/Models/RuntimeModelOptions.swift` -
  Desktop picker/default options.
- Anthropic announcement: `https://www.anthropic.com/news/claude-opus-4-8`
- Anthropic model overview: `https://platform.claude.com/docs/en/about-claude/models/overview`

## Decisions

- ADR-015: Model pricing as bundled JSON in @autopod/shared (existing)
- ADR-022: `MODEL_CANONICAL` alias map for analytics rollups (existing)
- ADR-026: Parser-side `costUsd` emission for runtimes without native cost
  (existing)
- ADR-028: Canonical model ID input policy (introduced)
