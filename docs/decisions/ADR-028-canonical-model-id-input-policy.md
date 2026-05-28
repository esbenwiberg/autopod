# ADR-028: Canonical model ID input policy

## Status

Accepted

## Context

Autopod historically accepted short Claude aliases (`opus`, `sonnet`, and
`haiku`) in profile defaults, create-pod model overrides, and the legacy
`escalation.askAi.model` payload. That convenience became ambiguous once Opus
4.8 became the current Opus choice for new Claude work: old `pods.model = 'opus'`
rows describe work that ran under the earlier Opus 4.7 alias mapping, while new
profile and pod writes should explicitly identify `claude-opus-4-8`.

ADR-022 already defines `MODEL_CANONICAL` as an analytics coalescing map over
historical `pods.model` rows. That map must preserve the meaning of old pod rows,
so changing `MODEL_CANONICAL.opus` to Opus 4.8 would rewrite history at read
time. ADR-015 keeps model pricing as bundled JSON, which means the short alias
price rows still need to exist temporarily for legacy raw lookup paths even
though they are no longer a public input contract.

## Decision

New model-bearing writes must use canonical provider model IDs. Exact short
Claude aliases are rejected by shared Zod schemas for:

- `createPodRequestSchema.model`
- `createProfileSchema.defaultModel`
- `updateProfileSchema.defaultModel`
- `createProfileSchema.reviewerModel`
- `updateProfileSchema.reviewerModel`
- `createProfileSchema.escalation.askAi.model`
- `updateProfileSchema.escalation.askAi.model`

The current shared Claude defaults are:

```ts
export const CLAUDE_DEFAULT_MODEL = 'claude-opus-4-8';
export const CLAUDE_REVIEWER_MODEL = 'claude-sonnet-4-6';
```

The rejected legacy alias set is:

```ts
export const LEGACY_CLAUDE_MODEL_ALIASES = new Set(['opus', 'sonnet', 'haiku']);
```

Null profile values keep their inheritance semantics. A derived profile can
still send or materialize `null` for model-bearing fields to inherit from its
parent; the rejection applies only when a caller sends the exact short alias
strings as concrete values.

`MODEL_CANONICAL` remains a historical analytics map:

```ts
export const MODEL_CANONICAL = {
  opus: 'claude-opus-4-7',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5',
};
```

Short alias price rows remain in `model-pricing.json` only as legacy-internal
pricing shims pending GitHub issue #139. They must not be documented or treated
as accepted new input.

## Consequences

**Easier**

- New profiles and pod overrides persist explicit model identities, so current
  defaults can move to Opus 4.8 without overloading the old `opus` string.
- Shared schema validation gives CLI, API, Desktop, issue watcher, and series
  paths one consistent rejection message for legacy aliases.
- Historical analytics remains stable because old `pods.model = 'opus'` rows
  continue to coalesce to `claude-opus-4-7`.

**Harder**

- Compatibility now has two layers with different purposes: schemas reject
  aliases for new writes, while pricing and analytics still understand aliases
  for historical data. Future edits must preserve that distinction.
- Existing stored profile aliases require a daemon migration before all persisted
  profile rows become canonical. This ADR defines the new-write contract; the
  migration is owned by the daemon runtime brief.

**Committed to**

- Do not remap `MODEL_CANONICAL.opus` to `claude-opus-4-8`.
- Do not remove the short alias price rows until the legacy pricing shim cleanup
  tracked by GitHub issue #139 is implemented.
- Do not add network price fetching or runtime-specific price tables; ADR-015's
  bundled JSON decision remains in force.

## Amends, not supersedes

ADR-022 remains the decision for historical analytics coalescing. This ADR
narrows public input policy for new writes and clarifies that legacy aliases in
pricing and analytics are compatibility mechanisms, not supported spellings for
new profile or pod requests.

