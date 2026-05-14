# Handover: bold-moose (brief 03 — Claude parser parity)

## What was built

Brought `claude-stream-parser.ts` to symmetric reasoning surfacing with the Codex parser:

1. **`thinking` blocks → `AgentReasoningEvent`** — added `mapContentBlock(block, ts)`, a static method that maps a single assistant content block to an `AgentEvent`. For `thinking` blocks with non-empty text it emits `{ type: 'reasoning', isRaw: false }`. In `parse()`, assistant events are now handled with a per-block loop (not a single `mapEvent` call), so one assistant message can yield N events (reasoning + text or tool_use) in order. Empty thinking blocks are silently skipped.

2. **`system/init` → `AgentStatusEvent.sessionId`** — the emitted `AgentStatusEvent` now carries `sessionId: event.session_id` directly. The human-readable `(xxx-yyy-zzz)` suffix in `message` is kept for backwards compatibility (brief 05 may retire it via the regex hack in pod-manager once it reads `event.sessionId`).

3. **`mapEvent` assistant case removed** — the `assistant` case was deleted from `mapEvent` (replaced by `parse()` + `mapContentBlock`). Callers that previously used `mapEvent` for assistant events (only the tests) now use `mapContentBlock` for single-block assertions and `parse()` (via `collectFromEvents()`) for multi-block assertions.

## Contracts changed that downstream pods must know about

| Contract | Location | Change |
|---|---|---|
| `AgentStatusEvent.sessionId` | emitted from `system/init` in `claude-stream-parser.ts:153` | Now populated directly (not just in the `message` string) — brief 05 (pod-manager) can read this field instead of the regex hack |
| `AgentReasoningEvent` | `claude-stream-parser.ts:112` | Claude parser now emits this variant for thinking blocks — renderers (brief 04: desktop, CLI) must handle `type === 'reasoning'` |
| `ClaudeStreamParser.mapContentBlock` | new public static method | Single-block unit test surface; not part of any public interface contract beyond tests |

## Files owned by this pod — do not modify without reason

- `packages/daemon/src/runtimes/claude-stream-parser.ts`
- `packages/daemon/src/runtimes/claude-stream-parser.test.ts`

## Landmines / constraints for downstream pods

- **`mapEvent` no longer handles `assistant` events** — calls to `mapEvent` with `type:'assistant'` events fall through to `default` and return `null`. Any caller outside `parse()` that was relying on `mapEvent` for assistant processing must now use `mapContentBlock` per block, or drive `parse()` via a stream.
- **`sessionId: event.session_id`** when `session_id` is undefined sets the property to `undefined` (not absent). `JSON.stringify` will omit it, but property-presence checks (`'sessionId' in result`) will return `true`. If brief 05 does presence checks, it should check truthiness instead.
- **Brief 05 can retire the regex hack**: `pod-manager.ts:4806-4811` parses the session ID from the `message` string. Now that `event.sessionId` is populated on the init event, brief 05 can read it directly and drop the regex.
- **`as string` cast in `mapContentBlock:122`** — intentional and required: `Record<string,unknown>` values are `unknown`, so `input.file_path ?? input.path ?? 'unknown'` resolves to `unknown` without the cast. Do not remove it.
