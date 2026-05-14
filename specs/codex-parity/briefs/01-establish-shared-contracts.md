---
title: "Establish shared contracts for Codex parity"
acceptance_criteria:
  - type: cmd
    outcome: AgentReasoningEvent variant exists in shared runtime types
    hint: "grep -nE \"type: 'reasoning'\" packages/shared/src/types/runtime.ts"
    polarity: expect-output
  - type: cmd
    outcome: AgentStatusEvent carries optional sessionId field
    hint: grep -nE "sessionId\?:" packages/shared/src/types/runtime.ts
    polarity: expect-output
  - type: cmd
    outcome: pods.codex_session_id migration file exists
    hint: test -f packages/daemon/src/db/migrations/100_pod_codex_session_id.sql
    polarity: expect-output
  - type: cmd
    outcome: ADR-026 file exists
    hint: test -f docs/decisions/ADR-026-parser-side-cost-for-non-claude-runtimes.md
    polarity: expect-output
touches:
  - packages/shared/src/types/runtime.ts
  - packages/shared/src/types/pod.ts
  - packages/shared/src/pricing/model-pricing.json
  - packages/shared/src/pricing/index.test.ts
  - packages/daemon/src/db/migrations/100_pod_codex_session_id.sql
  - packages/daemon/src/pods/pod-repository.ts
  - packages/daemon/src/pods/pod-repository.test.ts
  - docs/decisions/ADR-026-parser-side-cost-for-non-claude-runtimes.md
does_not_touch:
  - packages/daemon/src/runtimes/
  - packages/desktop/
  - packages/cli/
---

## Task

Lay the cross-package contracts the other 4 briefs depend on:

- Add `AgentReasoningEvent { type: 'reasoning'; timestamp: string; text: string; isRaw?: boolean }` to the `AgentEvent` union in `packages/shared/src/types/runtime.ts`.
- Add optional `sessionId?: string` to `AgentStatusEvent` in the same file so parsers can surface session IDs cleanly without a regex hack.
- Add `codexSessionId: string | null` to the `Pod` type in `packages/shared/src/types/pod.ts`. Mirror the existing `claudeSessionId` field one-for-one.
- Create migration `100_pod_codex_session_id.sql` adding the column to `pods` with NULL default and no backfill (existing rows are never-resumable, which is acceptable per `purpose.md` → Non-goals).
- Update `pod-repository.ts` to round-trip `codexSessionId`. Mirror the existing `claudeSessionId` plumbing at lines 339 (row → object) and 614-616 (`update()`).
- Add Codex model entries to `model-pricing.json` for any current Codex models missing today. Today's JSON has `gpt-5` and `gpt-5-mini`. Audit profiles in the repo for `runtime: codex` and add their `defaultModel` value if not already present (research step — likely none needed beyond what's there, but verify before assuming).
- Write `docs/decisions/ADR-026-parser-side-cost-for-non-claude-runtimes.md` per the draft shape (Context → Decision → Consequences → Amends, not supersedes → Alternatives rejected). Status: Accepted.

## Touches

- `packages/shared/src/types/runtime.ts`
- `packages/shared/src/types/pod.ts`
- `packages/shared/src/pricing/model-pricing.json`
- `packages/shared/src/pricing/index.test.ts`
- `packages/daemon/src/db/migrations/100_pod_codex_session_id.sql` (new)
- `packages/daemon/src/pods/pod-repository.ts`
- `packages/daemon/src/pods/pod-repository.test.ts`
- `docs/decisions/ADR-026-parser-side-cost-for-non-claude-runtimes.md` (new)

## Does not touch

- `packages/daemon/src/runtimes/` — parsers/runtime adapters are gated by briefs 02, 03, 05.
- `packages/desktop/` — renderer updates are gated by brief 04.
- `packages/cli/` — renderer updates are gated by brief 04.

## Constraints

- **Migration prefix**: the latest is `099_single_fix_pod.sql`. Use `100_*`. A `PreToolUse` hook (`.claude/hooks/migration-prefix-check.sh`) blocks Write/Edit on colliding prefixes locally; this brief uses the next free number.
- **`Pod.codexSessionId` must mirror `claudeSessionId`** — both are `string | null`, both default to NULL on insert, both are cleared (`null`) on certain recovery paths. See `pod-manager.ts:1354, 6520` for the existing init patterns.
- **ADR-026 amends ADR-015, does not supersede.** Claude's `total_cost_usd` path stays authoritative. The amendment only covers runtimes without a native cost field (Codex today, Copilot future). Reference `docs/decisions/ADR-015-model-pricing-bundled-json.md` for the unchanged read-time-aggregation pattern.
- **MODEL_CANONICAL (ADR-022)**: if you add a new *short alias* (e.g. `gpt5` → `gpt-5`), also add it to `MODEL_CANONICAL` in `packages/shared/src/pricing/index.ts`. Today's GPT entries use canonical IDs only, so no alias additions are required unless a profile demands one.

## Test expectations

- `packages/shared/src/pricing/index.test.ts`: add a case for any newly-added Codex model entry — assert `computeCost('<model>', 1_000_000, 0)` returns the `inputPer1M` value from the JSON. If no new entries are needed beyond the existing `gpt-5`/`gpt-5-mini`, no new test code is required (existing coverage is fine).
- `packages/daemon/src/pods/pod-repository.test.ts`: add a round-trip test for `codexSessionId` — insert a pod with `codexSessionId: 'abc-123-xyz'` set, read it back via `getOrThrow`, assert equality. Also assert that NULL round-trips correctly (insert without, read back as `null`).
- No new tests needed for the type-union additions (`AgentReasoningEvent`, `AgentStatusEvent.sessionId`) — TypeScript errors will surface at build time across all consumers, caught by `pnpm build` which the pipeline auto-runs.

## Risks / pitfalls

- The pricing JSON file has a `$comment` documentation key at the top — preserve it. The `index.ts` strip-comment code handles it but new entries must come after it as siblings, not nested.
- The new optional `sessionId?` field on `AgentStatusEvent` is non-breaking for existing consumers, but any `satisfies AgentStatusEvent` literal that exhaustively-typed its fields could surface a lint warning. Quick grep before changing the type confirms scope.

## Wrap-up

Before finishing:
1. Run `/simplify` and address its findings.
2. Re-run build and tests; both must still pass.
3. Commit and push.
