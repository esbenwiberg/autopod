# Handover: fragile-mosquito (brief 02 — Codex parser parity)

## What was built

Brought `codex-stream-parser.ts` to Claude-equivalent behavior on four axes:

1. **`patch_apply_end` → `AgentFileChangeEvent`** — handled in `parse()` (not `mapEvent`) so multiple files in a single patch event each yield their own `file_change` event. Action mapping: `create→create`, `update→modify`, `delete→delete`. `patch_apply_begin` and `patch_apply_updated` added to the ignore list.

2. **`costUsd` at `turn_complete`** — parser carries `latestModel: string | null` state (captured from `session_configured.model`). At `turn_complete`, calls `canonicalModelKey(latestModel)` then `computeCost(key, input, output)` from `@autopod/shared/pricing`. Warns and sets `costUsd=0` when the model key isn't in `MODEL_PRICING`. `latestModel` is never reset (session-scoped, not turn-scoped).

3. **`agent_reasoning` / `agent_reasoning_raw_content` → `AgentReasoningEvent`** — `agent_reasoning` emits `{ type: 'reasoning', isRaw: false }`, `agent_reasoning_raw_content` emits `{ type: 'reasoning', isRaw: true }` (field fallback: `msg.text ?? msg.content`). `agent_reasoning_raw_content` removed from the ignore list. `MAX_REASONING_LEN` bumped from 1000 to 4000.

4. **`session_configured` → `AgentStatusEvent.sessionId`** — `msg.session_id` is now spread onto the emitted status event so brief 05 (pod-manager) can read it and persist `pod.codexSessionId`.

## Deviation: prerequisite shared types were added here

Brief 01 (parent pod `unhappy-kangaroo`) produced no handover and left `packages/shared/src/types/runtime.ts` unchanged. Since brief 02 cannot compile without `AgentReasoningEvent` and `AgentStatusEvent.sessionId`, this pod added those two type changes as a prerequisite deviation:

- `AgentReasoningEvent` interface added + wired into `AgentEvent` union
- `sessionId?: string` added to `AgentStatusEvent`
- `AgentReasoningEvent` exported from `packages/shared/src/index.ts`

**Model pricing JSON (`gpt-5`, `gpt-5-mini`) and `Pod.codexSessionId` / migration `100_*` were NOT added** — those remain for brief 05 or whichever pod picks them up. The pricing entries already existed in the JSON from a prior commit. The migration and `Pod.codexSessionId` field are still needed.

## Contracts changed that downstream pods must know about

| Contract | Location | Change |
|---|---|---|
| `AgentEvent` union | `packages/shared/src/types/runtime.ts:44` | Now includes `AgentReasoningEvent` |
| `AgentStatusEvent` | `packages/shared/src/types/runtime.ts:55` | Gained optional `sessionId?: string` |
| `AgentReasoningEvent` | `packages/shared/src/types/runtime.ts:67` | New interface: `{ type:'reasoning'; timestamp; text; isRaw? }` |

Any exhaustive switch on `AgentEvent.type` (e.g. the Swift desktop model) will now get a compile error for the missing `'reasoning'` case — this is intentional (brief 04).

## Files owned by this pod — do not modify without reason

- `packages/daemon/src/runtimes/codex-stream-parser.ts`
- `packages/daemon/src/runtimes/codex-stream-parser.test.ts`
- `packages/shared/src/types/runtime.ts` (the two additions above)
- `packages/shared/src/index.ts` (the `AgentReasoningEvent` export line)

## Landmines / constraints for downstream pods

- **`agent_reasoning_raw_content` field name**: the Codex protocol may emit the text as `text` or `content` — the parser tries both, preferring `text`. If the actual Rust protocol uses a different field name, brief 05 should update the fallback in `mapEvent` case `agent_reasoning_raw_content`.
- **`patch_apply_end` is handled in `parse()`, not `mapEvent`**: `mapEvent` returns `null` for `patch_apply_end` (it's in the stateful-list comment). Single-event tests using `mapEvent` directly will see `null` — this is by design.
- **Brief 01 remainder**: `Pod.codexSessionId` field in `packages/shared/src/types/pod.ts`, migration `100_pod_codex_session_id.sql`, and `pod-repository.ts` round-trip are still undone. Brief 05 (pod-manager resume wiring) depends on all three.
- **`latestModel` is session-scoped**: it's set once from `session_configured` and never reset. If Codex ever emits multiple `session_configured` events (model reroute), the model is updated to the latest. This matches the intent.
