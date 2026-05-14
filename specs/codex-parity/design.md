# Design — Codex parity

## Blast radius

Five briefs across four packages.

**`@autopod/shared`** (brief 01)
- `src/types/runtime.ts` — `AgentEvent` union widens (new `AgentReasoningEvent`); `AgentStatusEvent` gains optional `sessionId?: string`.
- `src/types/pod.ts` — `Pod` gains `codexSessionId: string | null`, mirroring `claudeSessionId`.
- `src/pricing/model-pricing.json` — entries added for any current Codex models that aren't already keyed (today: `gpt-5`, `gpt-5-mini`; verify against profiles).
- `src/pricing/index.test.ts` — coverage for any new entries.

**`@autopod/daemon`** (briefs 01, 02, 03, 05)
- `src/db/migrations/100_pod_codex_session_id.sql` — new migration, additive column.
- `src/pods/pod-repository.ts` + `.test.ts` — round-trip `codexSessionId` (brief 01).
- `src/runtimes/codex-stream-parser.ts` + `.test.ts` — `patch_apply_*` → `file_change`, costUsd at `turn_complete`, reasoning emission, sessionId surfacing (brief 02).
- `src/runtimes/codex-runtime.ts` + `.test.ts` — pass model into the parse stream; `resume()` switches to `exec resume <id>` (brief 05).
- `src/runtimes/claude-stream-parser.ts` + `.test.ts` — emit reasoning for `thinking` blocks (no longer drop); set `sessionId` on init status (brief 03).
- `src/runtimes/codex-state-store.ts` + `.test.ts` — new module mirroring `claude-state-store.ts` (brief 05).
- `src/pods/pod-manager.ts` — bind-mount `~/.codex/sessions/` for Codex pods, route session-ID persistence by runtime, retire the Claude regex hack (brief 05).

**`@autopod/desktop`** (brief 04)
- `Sources/AutopodUI/Models/AgentEvent.swift` — rename `.output` → `.reasoning`.
- `Sources/AutopodUI/Models/MockEvents.swift` — 3 call sites updated.
- `Sources/AutopodUI/Views/Logs/LogStreamView.swift` — filter set updated.

**`@autopod/cli`** (brief 04)
- `src/commands/pod.ts` — explicit `case 'reasoning'` in the watch event switch.

**Repo-level** (brief 01)
- `docs/decisions/ADR-026-parser-side-cost-for-non-claude-runtimes.md`.

Aggregate: ~18 source files, no brief exceeds 5 modified files. No package other than the four above is touched.

## Seams

The work splits cleanly along package + concern boundaries:

| Seam | Brief on the left | Brief on the right | Contract crossing |
|------|-------------------|--------------------|-------------------|
| Shared types → both parsers | 01 (contracts) | 02 + 03 (parsers consume the new union variant + field) | `AgentReasoningEvent`, `AgentStatusEvent.sessionId` |
| Shared types → DB layer | 01 (contracts) | 05 (pod-manager persists by routing on `pod.runtime`) | `Pod.codexSessionId` + migration column |
| Parser ↔ runtime ↔ pod-manager | 02 (parser emits `sessionId`) | 05 (pod-manager reads `event.sessionId`, runtime calls `exec resume`) | `AgentStatusEvent.sessionId` carries the captured Codex session ID; `pod.codexSessionId` is the persistence side |
| Shared pricing → parser | 01 (JSON entries) | 02 (parser calls `computeCost`) | `MODEL_PRICING` keys must include any model the parser sees on `session_configured` |
| Runtime → desktop / CLI | 01 + 02 + 03 (new event type emitted) | 04 (renderers handle the new type) | `AgentEvent.type === 'reasoning'` |

Gate 2's three briefs (02, 03, 04) are independent — they share no file touches and their dependencies all converge at brief 01. Brief 05 depends on 01 (for the column + the event-field contract) and 02 (which is the brief that actually emits `event.sessionId` and uses the model from `session_configured` to compute cost).

## Contracts

### `AgentReasoningEvent` (new union variant, owner: brief 01)

```ts
// packages/shared/src/types/runtime.ts
export interface AgentReasoningEvent {
  type: 'reasoning';
  timestamp: string;
  text: string;
  /** true for Codex agent_reasoning_raw_content (full raw); false/undefined for summary reasoning. */
  isRaw?: boolean;
}

export type AgentEvent =
  | AgentStatusEvent
  | AgentToolUseEvent
  | AgentFileChangeEvent
  | AgentCompleteEvent
  | AgentErrorEvent
  | AgentEscalationEvent
  | AgentPlanEvent
  | AgentProgressEvent
  | AgentTaskSummaryEvent
  | AgentReasoningEvent; // new
```

Consumers: brief 02 (Codex parser), brief 03 (Claude parser), brief 04 (desktop + CLI renderers).

### `AgentStatusEvent.sessionId` (new optional field, owner: brief 01)

```ts
export interface AgentStatusEvent {
  type: 'status';
  timestamp: string;
  message: string;
  /** Populated when this status event represents a runtime session-ready emission. */
  sessionId?: string;
}
```

Producers: brief 02 (Codex parser sets on `session_configured`), brief 03 (Claude parser sets on `system/init`).
Consumer: brief 05 (pod-manager reads and routes to `claudeSessionId` / `codexSessionId` based on `pod.runtime`).

### `Pod.codexSessionId` (new optional field, owner: brief 01)

```ts
// packages/shared/src/types/pod.ts
export interface Pod {
  // ...existing fields...
  claudeSessionId: string | null;
  codexSessionId: string | null; // new — mirrors claudeSessionId
}
```

Migration: `100_pod_codex_session_id.sql` adds `codex_session_id TEXT DEFAULT NULL` to the `pods` table.

Consumers: brief 05 (pod-manager persists; codex-runtime reads on resume).

### Codex `exec resume` invocation (owner: brief 05)

```ts
// packages/daemon/src/runtimes/codex-runtime.ts
// In resume():
const sessionId = pod.codexSessionId;
const args = sessionId
  ? ['exec', 'resume', sessionId, message, '--json']
  : ['exec', message, '--full-auto', '--json']; // fallback when not yet captured
```

Exact arg layout (positional `<message>` vs `--prompt`) verified against `codex --help exec resume` in the container image during implementation. Test fixtures lock the shape once verified.

## Reference reading

- `packages/daemon/src/runtimes/claude-state-store.ts` — the template `codex-state-store.ts` mirrors verbatim, just swapping the path constants.
- `packages/daemon/src/pods/pod-manager.ts:3566-3580` — the existing Claude state-dir bind-mount block. Brief 05 adds a sibling block for Codex.
- `packages/daemon/src/pods/pod-manager.ts:4806-4811` — the existing Claude regex-hack that captures the session ID from a status message. Brief 05 retires this in favor of the new `event.sessionId` field, then routes by `pod.runtime`.
- `packages/daemon/src/runtimes/claude-stream-parser.ts:124-152` — the iteration pattern over `assistant.message.content` and the `thinking` skip. Brief 03 changes the skip into an emit.
- `packages/daemon/src/runtimes/claude-stream-parser.ts:134-143` — the `Edit`/`Write`/`MultiEdit` → `file_change` mapping. Brief 02 mirrors the shape for Codex `patch_apply_end`.
- `packages/daemon/src/runtimes/claude-stream-parser.ts:181-205` — the `result` event mapping that extracts `total_cost_usd` and emits `AgentCompleteEvent.costUsd`. Brief 02 builds the equivalent path for Codex, computing the value rather than reading it.
- `packages/daemon/src/runtimes/codex-stream-parser.ts:30-42, 270-325` — the existing `latestUsage` state pattern and `parse()` stitcher. Brief 02 extends with `latestModel` from `session_configured`.
- `packages/daemon/src/pods/pod-manager.ts:4812-4836` — the runtime-agnostic token + cost accumulator (`tokenUpdates.costUsd = currentSession.costUsd + event.costUsd`). No changes needed here; brief 02 makes Codex's `event.costUsd` non-undefined so this code starts writing real values.
- `packages/shared/src/pricing/index.ts` — `MODEL_PRICING`, `computeCost`, `effectiveCostUsd`, `canonicalModelKey`. Brief 02 imports `computeCost`. Brief 01 adds to `MODEL_PRICING` (the JSON).
- `packages/desktop/Sources/AutopodUI/Models/AgentEvent.swift:5-80` — `AgentEventType` enum with label / icon / color / `isOverviewWorthy`. Brief 04 renames `.output` → `.reasoning`.
- `packages/cli/src/commands/pod.ts:670-729` — the `agent_activity` event-type switch with the trailing `default: console.log(JSON.stringify(inner))` fallback. Brief 04 adds an explicit `case 'reasoning'`.
- `CLAUDE.md` and `packages/daemon/CLAUDE.md` — migration prefix rules + runtime overview + recovery-mode notes.
- `docs/decisions/ADR-007-local-recovery-requeue-not-resume.md` — the recovery contract; explains why `runtime.resume()` is invoked from the re-queue path. Brief 05 finally makes Codex's recovery actually resume.
- `docs/decisions/ADR-015-model-pricing-bundled-json.md` — the existing read-time aggregation pattern. Brief 01's ADR-026 amends.
- `docs/decisions/ADR-022-model-canonical-alias-map.md` — `MODEL_CANONICAL` alias coalescing. Brief 01 must keep `MODEL_CANONICAL` in sync if it introduces a new short alias.
- Codex Rust protocol — `openai/codex` repo, `codex-rs/protocol/src/protocol.rs`. Authoritative source for event shapes (`patch_apply_begin/updated/end`, `session_configured`, `token_count`, `turn_complete`, `agent_reasoning`, `agent_reasoning_raw_content`).
- OpenAI Codex changelog (May 2026) — confirms `codex exec resume <SESSION_ID>` syntax and `reasoning_output_tokens` in `turn.completed.usage`.

## Decisions

- **ADR-026** — Parser-side `costUsd` emission for runtimes without native cost. Introduced by this spec. Amends (does not supersede) ADR-015.
- **ADR-007** — Re-queue Recovery Instead of Dedicated Resume Path. Reused. Brief 05 is the implementation that finally makes ADR-007 work for Codex.
- **ADR-015** — Model pricing as bundled JSON in `@autopod/shared`. Reused. Brief 02 calls into `computeCost` from the parser; brief 01 adds JSON entries.
- **ADR-022** — `MODEL_CANONICAL` alias map. Reused. Brief 01 must touch `MODEL_CANONICAL` only if it introduces a new short alias (today, no Codex aliases are needed — entries use canonical IDs).
