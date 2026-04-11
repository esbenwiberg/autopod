# Real-time Agent Monitoring & Control — Implementation Plan

> **Goal**: Enable spinning up many isolated agents with real-time progress visibility, plan reporting, and the ability to pause/redirect running agents mid-flight.

**Status**: All phases complete. Phase 3 (TUI visual components) was implemented and subsequently removed — the CLI TUI has been deprecated in favour of the macOS desktop app.

## Design Principles

- **Model-provider agnostic** — all agent communication via MCP (no Anthropic SDK). Any agent runtime that speaks MCP can participate.
- **CLI-first** — nail the TUI experience before building a web dashboard. The daemon + WebSocket infra serves both.
- **Agents decide their own workflow** — we give them tools to report progress, not rigid phase gates. Autonomy > control.

---

## Phase 1: MCP Progress & Plan Tools ✅ Done

**New MCP tools added to the escalation server** (injected into every agent container):

### `report_plan`
```
report_plan(summary: string, steps: string[])
```
- Agent calls this **before writing any code** to declare its intended approach
- Fire-and-forget (non-blocking, unlike `ask_human`)
- Emits `AgentPlanEvent` → EventBus → WebSocket → TUI
- Plan stored on the session record for later review
- Enforced via CLAUDE.md instructions: *"Before writing any code, call `report_plan` with your high-level approach and numbered steps"*

### `report_progress`
```
report_progress(phase: string, description: string, currentPhase: number, totalPhases: number)
```
- Agent calls this at each milestone transition
- Fire-and-forget (non-blocking)
- Emits `AgentProgressEvent` → EventBus → WebSocket → TUI
- Phase names are agent-defined (flexible, not a fixed enum)
- CLAUDE.md instructions: *"Break your work into 3-6 phases. Report each transition via `report_progress`"*

### `check_messages`
```
check_messages() → { hasMessage: boolean, message?: string }
```
- Soft polling tool — agent can periodically check if the human wants to say something
- Returns pending message if one exists, otherwise `{ hasMessage: false }`
- Non-blocking: if no message, agent continues immediately
- CLAUDE.md instructions: *"Call `check_messages` between phases to check for human guidance"*
- Messages queued via new `ap nudge <id> "<message>"` command (works on `running` sessions without pausing)

### New Event Types

```typescript
interface AgentPlanEvent {
  type: 'plan';
  timestamp: string;
  summary: string;
  steps: string[];
}

interface AgentProgressEvent {
  type: 'progress';
  timestamp: string;
  phase: string;
  description: string;
  currentPhase: number;
  totalPhases: number;
}
```

### Files to modify/create
- `packages/escalation-mcp/src/tools/report-plan.ts` — new tool
- `packages/escalation-mcp/src/tools/report-progress.ts` — new tool
- `packages/escalation-mcp/src/tools/check-messages.ts` — new tool
- `packages/escalation-mcp/src/server.ts` — register new tools
- `packages/shared/src/types/runtime.ts` — add `AgentPlanEvent`, `AgentProgressEvent` to `AgentEvent` union
- `packages/daemon/src/sessions/session-manager.ts` — handle new event types, store plan on session
- `packages/daemon/src/sessions/session-repository.ts` — add plan + progress fields
- `packages/daemon/src/db/migrations/006_progress.sql` — new columns
- `packages/daemon/src/sessions/claude-md-generator.ts` — add phase/plan instructions

---

## Phase 2: Pause & Redirect ✅ Done

### New state: `paused`

Add to the session state machine:
```
running → paused    (via `ap pause`)
paused  → running   (via `ap tell` or `ap resume`)
paused  → killing   (via `ap kill`)
```

### `ap pause <id>`
1. Calls `runtime.suspend(sessionId)` — kills the exec stream but **preserves Claude session ID** (NOT `abort()` which clears it)
2. **Keeps container + worktree alive** (critical — don't destroy the workspace)
3. Transitions session: `running → paused`
4. Claude session ID already persisted to SQLite (survives daemon restart)
5. Emits `SessionStatusChangedEvent` → TUI shows "PAUSED" badge
6. **Accepted risk:** if agent was mid-tool-call, worktree may have dirty state — agent sorts it out on resume via `--resume` conversation history

### `ap tell <id> "<message>"` (extended)
Currently only works on `awaiting_input`. Extend to also work on `paused`:
- Transitions: `paused → running`
- Calls `runtime.resume(sessionId, message, containerId)` with `--resume <agentSessionId>`
- Agent picks up conversation history + your new direction
- Events flow back through the normal pipeline

### `ap nudge <id> "<message>"` (new — soft messaging)
- Works on `running` sessions **without pausing**
- Queues message in a per-session mailbox (SQLite table or in-memory map)
- Agent picks it up next time it calls `check_messages()`
- If agent never checks, message persists until session ends
- Useful for gentle course corrections: *"also make sure to add tests for the edge case"*

### TUI keyboard shortcuts
- `p` — pause selected session (if running)
- `t` — tell/resume (works on `paused` + `awaiting_input`)
- `u` — nudge (works on `running` — queue a soft message)

### Files to modify/create
- `packages/shared/src/types/session.ts` — add `paused` status
- `packages/daemon/src/sessions/session-manager.ts` — add `pauseSession()`, extend `sendMessage()` for paused state, add `nudgeSession()` + message queue
- `packages/daemon/src/api/routes/sessions.ts` — add `POST /sessions/:id/pause`, `POST /sessions/:id/nudge`
- `packages/daemon/src/runtimes/claude-runtime.ts` — add `suspend()` method (kills stream, preserves session ID), persist `claudeSessionId` to DB
- `packages/daemon/src/runtimes/codex-runtime.ts` — same pattern
- `packages/daemon/src/sessions/session-manager.ts` — refactor event loop to be re-entrant (separate stream consumption from session lifecycle)
- `packages/cli/src/commands/session.ts` — add `ap pause`, `ap nudge` commands
- `packages/cli/src/tui/Dashboard.tsx` — add `p` and `u` hotkeys
- `packages/escalation-mcp/src/tools/check-messages.ts` — reads from message queue
- `packages/daemon/src/db/migrations/006_progress.sql` — message queue table (or extend same migration)

---

## Phase 3: TUI Upgrades ✅ Done (removed — desktop app supersedes)

### Progress bar component
- Segmented bar below each session in the table (or in detail panel)
- Segments colored by phase type (heuristic mapping: planning=red, implementing=orange, testing=blue, validating=green)
- If agent doesn't call `report_progress`, shows "no progress reported" — honest > misleading
- Shows `currentPhase / totalPhases` as text alongside bar

### Plan display
- Detail panel gets a new "Plan" section showing the agent's declared approach
- Steps rendered as a checklist, with current phase highlighted
- Cross-references `report_progress` with plan steps for visual mapping

### Live metrics
- **Tool count**: aggregate from `AgentToolUseEvent` + `AgentFileChangeEvent` events
- **Token count**: if available from stream (Claude NDJSON `result` event includes usage stats)
- **Duration**: live timer from `session.startedAt` — tick every second in TUI
- **Status badge**: add `PAUSED` (yellow) alongside existing badges

### Session card layout (optional upgrade)
- Consider switching from table rows to card-based layout for running sessions
- Each card shows: status, model, task summary, progress bar, metrics
- Table layout remains for queued/completed sessions (compact)
- This is a TUI layout exploration — may stay as table if it looks cleaner

### Files to modify/create
- `packages/cli/src/tui/components/ProgressBar.tsx` — new component
- `packages/cli/src/tui/components/PlanPanel.tsx` — new component
- `packages/cli/src/tui/components/MetricsBar.tsx` — new component (tools, tokens, duration)
- `packages/cli/src/tui/components/DetailPanel.tsx` — integrate plan + progress
- `packages/cli/src/tui/components/SessionTable.tsx` — add inline progress bar
- `packages/cli/src/tui/components/StatusBadge.tsx` — add `paused` badge
- `packages/cli/src/tui/hooks/useSessionMetrics.ts` — aggregate metrics from events

---

## Phase 4: CLAUDE.md Template Updates ✅ Done

Update the instruction template injected into every agent container:

```markdown
## Workflow Requirements

1. **Plan first**: Before writing any code, call `report_plan` with your approach and numbered steps.
2. **Report progress**: Break your work into 3-6 phases. Call `report_progress` at each transition.
3. **Check for messages**: Call `check_messages` between phases to see if the human has guidance.
4. **Phases are yours to define**: Name them whatever makes sense for the task. Common patterns:
   - Exploration → Implementation → Testing → Cleanup
   - Analysis → Design → Build → Verify
   - Investigation → Fix → Test → Document
```

This is **guidance, not enforcement** — we rely on the agent's cooperation. If an agent ignores it, the TUI shows "no progress reported" honestly.

### Provider-agnostic note
These instructions work for any model/runtime that supports MCP tool calling. The CLAUDE.md format is just markdown — no provider-specific syntax.

---

## Implementation Order

| Step | What | Why first |
|------|-------|-----------|
| 1 | New event types in shared + `paused` status | Everything depends on the type definitions |
| 2 | DB migration (`006_progress.sql`) — plan, progress, message queue, `claude_session_id` | Single migration covering all new persistence |
| 3 | MCP tools (report_plan, report_progress, check_messages) | Foundation — agents need these before TUI can show anything |
| 4 | Session repository changes | Persist plans, progress, read/write message queue |
| 5 | Runtime refactor: add `suspend()` to claude-runtime + codex-runtime, persist session IDs to DB | Prerequisite for pause — must separate from destructive `abort()` |
| 6 | Session manager: refactor event loop for re-entry + handle new events + pause/nudge logic | Core orchestration — depends on runtime + repo changes |
| 7 | API routes (pause, nudge) | Expose to CLI |
| 8 | CLI commands (ap pause, ap nudge) | User-facing commands |
| 9 | CLAUDE.md template updates | Tell agents about the new tools |
| 10 | TUI components (progress bar, plan panel, metrics, PAUSED badge) | Visual layer — last because it consumes everything above |
| 11 | TUI keyboard shortcuts (p, u) | Wire up pause/nudge in dashboard |

---

## Resolved Decisions

1. **`check_messages` is optional.** You can't force an LLM to call a tool — CLAUDE.md is guidance, not enforcement. Agents that ignore it can only be hard-paused. That's fine.

2. **Progress bar colors: agent-defined category string, mapped to colors on the TUI side.** Small default palette. Not worth overthinking.

3. **Message queue: SQLite.** Already use it for everything else. Losing nudge messages on daemon crash is worse UX than one extra table.

4. **Token counting: final only (from `result` event).** No mid-stream estimation — noisy and misleading. Can add later if people actually ask for it.

5. **`report_plan`: fire-and-forget.** Plan approval can be a separate opt-in feature later (`ap plan-gate`). Don't tax every session with latency.

6. **Activity-based progress inference: cut from Phase 3.** Inferring "exploring" from Read/Grep is wrong too often (agents read files during implementation, run bash during exploration). Show "no progress reported" honestly instead. Can add heuristics later if there's demand, but ripping out misleading UX is harder than adding a feature.

---

## Architectural Risks & Mitigations

### 1. Pause requires a new `suspend()` path — not reuse of `abort()`

Current `abort()` in `claude-runtime.ts` calls `handle.kill()` **and clears `claudeSessionIds`** — that's the resume ticket gone. Must split into:
- **`abort()`** (destructive): current behavior, tears everything down
- **`suspend()`** (preserving): kills the stream but **preserves** the Claude session ID mapping

### 2. Claude session IDs must be persisted to SQLite

`claudeSessionIds` is an in-memory `Map`. Daemon crash = all session IDs gone = no resume for paused sessions. Store `claude_session_id` in the sessions table. Include in `006_progress.sql` migration.

### 3. Event consumption loop needs refactoring for re-entry

`consumeAgentEvents()` is a tight `for await...of` over the stream. Pause kills the stream, resume spawns a new one. But `processSession()` does provisioning → spawn → consume in sequence. Need to separate "consume events from a stream" from "process a session end-to-end" so resume can re-enter the event loop without re-provisioning.

### 4. Dirty state on pause (mid-tool-call) — accepted risk

If pause fires while the agent is mid-`Edit`, the worktree may have half-written files. **Decision: accept it.** The agent sorts it out on resume — Claude's `--resume` carries conversation history, so it knows what it was doing. Document this behavior.

### 5. `check_messages` hop count is acceptable

Flow: agent → MCP tool → escalation server → SessionBridge → daemon → SQLite → back (4 hops). Fine for correctness. Agents call it between phases, not in a tight loop. Not a bottleneck.
