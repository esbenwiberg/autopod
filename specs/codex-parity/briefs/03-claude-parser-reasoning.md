---
title: "Emit reasoning events from Claude thinking blocks"
depends_on: [01-establish-shared-contracts]
acceptance_criteria:
  - type: cmd
    outcome: claude parser emits reasoning event for thinking blocks
    hint: grep -nE "type: 'reasoning'" packages/daemon/src/runtimes/claude-stream-parser.ts
    polarity: expect-output
  - type: cmd
    outcome: claude parser populates sessionId on init status emission
    hint: grep -nE "sessionId:" packages/daemon/src/runtimes/claude-stream-parser.ts
    polarity: expect-output
touches:
  - packages/daemon/src/runtimes/claude-stream-parser.ts
  - packages/daemon/src/runtimes/claude-stream-parser.test.ts
does_not_touch:
  - packages/daemon/src/runtimes/codex-stream-parser.ts
  - packages/daemon/src/runtimes/copilot-stream-parser.ts
  - packages/daemon/src/pods/pod-manager.ts
  - packages/shared/
---

## Task

Lift Claude up to symmetric reasoning surfacing alongside the Codex parity work — same `AgentReasoningEvent` variant, same `AgentStatusEvent.sessionId` field.

1. **`thinking` blocks → `AgentReasoningEvent`**. Today `claude-stream-parser.ts:124` explicitly skips thinking blocks (the comment reads "Process the first meaningful content block (skip 'thinking' blocks)"). Replace: when iterating `assistant.message.content`, emit `{ type: 'reasoning', timestamp, text: block.thinking, isRaw: false }` for any `thinking` block with non-empty text.

   The existing single-emit return pattern in `mapEvent` (returns `null` or one `AgentEvent`) needs adjusting since one assistant message can now produce multiple events (one or more reasoning + one text/tool_use). Two viable shapes:

   - (a) `mapEvent` returns `AgentEvent[]`, callers iterate.
   - (b) Move the content-array iteration into `parse()`, yield each event individually, leave `mapEvent` for single-block tests only.

   Recommendation: **(b)** — keeps `mapEvent` pure for unit tests, the `parse()` async generator naturally yields multiple events. The current `parse()` at line 64-89 yields whatever `mapEvent` returns; widening it to yield-per-block is a one-line change inside the `assistant` case.

2. **`system/init` → `AgentStatusEvent.sessionId`**. The mapping at claude-stream-parser.ts:107-115 currently bakes `session_id` into the message string (`"Claude pod initialized (xxx-yyy-zzz)"`). Populate the new `sessionId` field on the emitted `AgentStatusEvent` directly from `event.session_id`. Keep the human-readable `(xxx)` suffix in the `message` for now — brief 05 retires the regex hack in pod-manager, after which the suffix could be dropped, but that's their brief's call.

## Touches

- `packages/daemon/src/runtimes/claude-stream-parser.ts`
- `packages/daemon/src/runtimes/claude-stream-parser.test.ts`

## Does not touch

- `packages/daemon/src/runtimes/codex-stream-parser.ts` — gated by brief 02.
- `packages/daemon/src/runtimes/copilot-stream-parser.ts` — out of scope.
- `packages/daemon/src/pods/pod-manager.ts` — gated by brief 05.
- `packages/shared/` — gated by brief 01.

## Constraints

- Claude's stream-json doesn't emit `thinking_delta` in this mode — full text comes in one block. No streaming concerns; no need to buffer or stitch.
- `block.thinking` may be empty or missing — guard with a truthy check before emitting (don't emit empty reasoning events).
- Don't truncate the thinking text. Claude thinking is high-signal and the UI handles display caps. Storage of the full text is fine.
- The existing test `skips assistant thinking blocks` at `claude-stream-parser.test.ts:52` is now load-bearing — it asserts the OLD behavior. It needs renaming (`emits reasoning event for thinking blocks`) and inverting before the parser change lands, or vice versa. Either order works, but they must land in the same commit.
- The `system/init` event already has `session_id` available at top-level (`ClaudeStreamEvent.session_id`, see `claude-stream-parser.ts:44`). Just thread it onto the returned `AgentStatusEvent`.

## Test expectations

- A new fixture where `assistant.message.content` is `[{ type: 'thinking', thinking: 'Let me think...' }]` — assert one `reasoning` event emitted with full text, `isRaw: false`.
- A new fixture mixing thinking + text in one content array (`[{ type: 'thinking', thinking: '...' }, { type: 'text', text: '...' }]`) — assert two events emit in order: reasoning then status.
- The existing `skips assistant thinking blocks` test (line 52) renamed + inverted to assert emission.
- A new fixture: assistant message with thinking text but no other blocks — assert one reasoning event, no status.
- A new fixture: assistant message with `thinking: ''` (empty string) — assert no reasoning event emitted (skip empties).
- A new fixture for `system/init` with `session_id: 'abc-123'` — assert `AgentStatusEvent.sessionId === 'abc-123'`. The existing init test should be extended rather than duplicated.

## Wrap-up

Before finishing:
1. Run `/simplify` and address its findings.
2. Re-run build and tests; both must still pass.
3. Commit and push.
