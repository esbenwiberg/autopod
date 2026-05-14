---
title: "Map Codex parser to full Claude parity"
depends_on: [01-establish-shared-contracts]
acceptance_criteria:
  - type: cmd
    outcome: codex parser maps patch_apply_end to file_change event
    hint: grep -nE "patch_apply_end" packages/daemon/src/runtimes/codex-stream-parser.ts
    polarity: expect-output
  - type: cmd
    outcome: codex parser computes costUsd via shared computeCost
    hint: grep -nE "computeCost|effectiveCostUsd" packages/daemon/src/runtimes/codex-stream-parser.ts
    polarity: expect-output
  - type: cmd
    outcome: codex parser emits reasoning event variant
    hint: "grep -nE \"type: 'reasoning'\" packages/daemon/src/runtimes/codex-stream-parser.ts"
    polarity: expect-output
  - type: cmd
    outcome: codex parser populates sessionId on session_configured status emission
    hint: grep -nE "sessionId:" packages/daemon/src/runtimes/codex-stream-parser.ts
    polarity: expect-output
touches:
  - packages/daemon/src/runtimes/codex-stream-parser.ts
  - packages/daemon/src/runtimes/codex-stream-parser.test.ts
  - packages/daemon/src/runtimes/codex-runtime.ts
does_not_touch:
  - packages/daemon/src/runtimes/claude-stream-parser.ts
  - packages/daemon/src/runtimes/copilot-stream-parser.ts
  - packages/daemon/src/pods/pod-manager.ts
  - packages/shared/
---

## Task

Bring the Codex stream parser to Claude-equivalent behavior on four axes:

1. **`patch_apply_*` events → `AgentFileChangeEvent`**. The Codex Rust protocol emits `patch_apply_begin` (announcement), `patch_apply_updated` (live updates while patching), and `patch_apply_end` (final). Today all three are absent from our parser. Map `patch_apply_end` to `AgentFileChangeEvent` per file in the `changes` payload, with `action: 'create' | 'modify' | 'delete'` derived from the patch op. Mirror Claude's shape at `claude-stream-parser.ts:134-143` (no `diff` field, just `path` + `action`). Emit one `file_change` event per file touched. `patch_apply_begin` and `_updated` stay ignored — `_end` is the materialization point that matches Claude's emit timing.

   Verify the exact struct shape against `codex-rs/protocol/src/protocol.rs` → `PatchApplyEndEvent` before implementing. The Rust source is authoritative.

2. **`costUsd` computation at `turn_complete`**. Today the parser carries `latestUsage` across `token_count` events and flushes the token totals into the emitted `AgentCompleteEvent` at `turn_complete`. Extend the same state with `latestModel: string | null`. Populate it when the parser sees `session_configured` (which carries the model). At `turn_complete`, compute `costUsd = computeCost(latestModel, input, output)` using the helper from `@autopod/shared/pricing` and set it on the emitted `AgentCompleteEvent.costUsd`. If `latestModel` is null (defensively — shouldn't happen since `session_configured` is the first event), `computeCost` returns 0; mirror Claude's existing optional-`costUsd` semantics.

3. **`agent_reasoning` and `agent_reasoning_raw_content` → `AgentReasoningEvent`**. Today `agent_reasoning` (codex-stream-parser.ts:95-99) emits a status event with `"Reasoning:"` prefix, truncated to 1000 chars. Replace: emit `{ type: 'reasoning', timestamp: ts, text, isRaw: false }`. Add a new case for `agent_reasoning_raw_content` emitting the same shape with `isRaw: true`. Continue to ignore `agent_reasoning_delta` and `agent_reasoning_raw_content_delta` (high-frequency, no clean stitching boundary for full-text re-emission). Raise the truncation cap from `MAX_REASONING_LEN = 1000` to 4000 chars (consistent with the existing `MAX_OUTPUT_LEN`).

4. **`session_configured` → `AgentStatusEvent.sessionId`**. The existing mapping at codex-stream-parser.ts:83 returns a status with message `"Codex session ready"` but doesn't carry the session ID. Populate the new `sessionId` field on the emitted `AgentStatusEvent` from `msg.session_id`. Brief 05 (pod-manager) reads it from there to persist `pod.codexSessionId`.

The `codex-runtime.ts` change is minimal: today `CodexStreamParser.parse(handle.stdout, podId, logger)` is called from both `spawn()` and `resume()`. The model is already in `config.model` (for spawn) but not exposed to `resume()`. Two options:
   - (a) Plumb model through to both call sites. Simpler at the runtime, but parser now takes an extra param.
   - (b) Always read model from `session_configured` event (which always fires first). Self-contained parser.

   Recommendation: **(b)** — keep the parser self-contained. The model is reliably in the first emitted event; no plumbing change at the runtime layer.

## Touches

- `packages/daemon/src/runtimes/codex-stream-parser.ts` — primary file. Add `latestModel` state, four new mappings/changes.
- `packages/daemon/src/runtimes/codex-stream-parser.test.ts` — fixtures + assertions for each new mapping.
- `packages/daemon/src/runtimes/codex-runtime.ts` — touched only if option (a) above is chosen (model plumbed in). Likely untouched if option (b).

## Does not touch

- `packages/daemon/src/runtimes/claude-stream-parser.ts` — gated by brief 03.
- `packages/daemon/src/runtimes/copilot-stream-parser.ts` — out of scope (non-goal).
- `packages/daemon/src/pods/pod-manager.ts` — gated by brief 05.
- `packages/shared/` — gated by brief 01.

## Constraints

- **Existing state pattern**: parser already carries `latestUsage` across `token_count` events (codex-stream-parser.ts:272-298, with the flush at `turn_complete` at line 300-320). Extend the same pattern for `latestModel`. Do NOT push state into `mapEvent` — that function is exported and used in single-event tests with no carried state; keep it pure.
- **MCP tool-call mappings** (codex-stream-parser.ts:134-173) stay unchanged. They were never in scope.
- **Truncation cap**: bump `MAX_REASONING_LEN` to 4000 but keep `MAX_OUTPUT_LEN` at 2000 (existing). Reasoning is high-signal; tool output is high-noise.
- **`apply_patch_approval_request`** stays in the ignore list (codex-stream-parser.ts:239) — that's the human-approval prompt, not a patch event. Don't conflate.
- **Token taxonomy**: `latestUsage` already pulls `input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens` from `total_token_usage` (codex-stream-parser.ts:30-42). The `costUsd` computation must use `input_tokens` and `output_tokens` (matching Claude's input/output split) — reasoning tokens are folded into `output_tokens` by Codex per the May 2026 changelog. Don't add reasoning tokens separately.

## Test expectations

Add to `codex-stream-parser.test.ts`:

- A `patch_apply_end` envelope fixture with a `changes: { 'src/foo.ts': { type: 'update' } }` payload — assert one emitted `AgentFileChangeEvent` with `path: 'src/foo.ts'`, `action: 'modify'`.
- A `patch_apply_end` fixture with multiple files and mixed actions (create + update + delete) — assert one event per file with the right action.
- `patch_apply_begin` and `patch_apply_updated` fixtures — assert they emit nothing (still ignored).
- A turn-complete fixture preceded by `session_configured` with `model: 'gpt-5'` and `token_count` with known input/output — assert the emitted `AgentCompleteEvent.costUsd === computeCost('gpt-5', input, output)`. Use the actual helper to derive the expected value, not a hardcoded number, so the test doesn't drift if pricing changes.
- A turn-complete fixture WITHOUT preceding `session_configured` — assert `costUsd` is undefined or 0 (graceful degradation).
- A turn-complete fixture with `session_configured` carrying a model NOT in `MODEL_PRICING` — assert `costUsd === 0` and a warn log line surfaces.
- An `agent_reasoning` fixture with a 500-char text — assert emitted event has `type: 'reasoning'`, `isRaw: false`, full text untruncated.
- An `agent_reasoning` fixture with a 5000-char text — assert text truncated to 4000 chars + ellipsis.
- An `agent_reasoning_raw_content` fixture — assert `type: 'reasoning'`, `isRaw: true`.
- The old test "maps agent_reasoning to a status event prefixed 'Reasoning:'" at line 49 needs renaming + assertion update (it now tests the reasoning-event emission, no prefix, no truncation at 1000).
- A `session_configured` fixture — assert emitted `AgentStatusEvent.sessionId === msg.session_id`.

## Wrap-up

Before finishing:
1. Run `/simplify` and address its findings.
2. Re-run build and tests; both must still pass.
3. Commit and push.
