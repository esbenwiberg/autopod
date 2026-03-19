# Real-time Agent Monitoring & Control — Implementation Plan

> **Goal**: Enable spinning up many isolated agents with real-time progress visibility, plan reporting, and the ability to pause/redirect running agents mid-flight.

## Design Principles

- **Model-provider agnostic** — all agent communication via MCP (no Anthropic SDK). Any agent runtime that speaks MCP can participate.
- **CLI-first** — nail the TUI experience before building a web dashboard. The daemon + WebSocket infra serves both.
- **Agents decide their own workflow** — we give them tools to report progress, not rigid phase gates. Autonomy > control.

---

## Phase 1: MCP Progress & Plan Tools

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

## Phase 2: Pause & Redirect

### New state: `paused`

Add to the session state machine:
```
running → paused    (via `ap pause`)
paused  → running   (via `ap tell` or `ap resume`)
paused  → killing   (via `ap kill`)
```

### `ap pause <id>`
1. Calls `runtime.abort(sessionId)` — kills the exec stream
2. **Keeps container + worktree alive** (critical — don't destroy the workspace)
3. Transitions session: `running → paused`
4. Stores the Claude/Codex session ID for later resume
5. Emits `SessionStatusChangedEvent` → TUI shows "PAUSED" badge

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
- `packages/daemon/src/runtimes/claude-runtime.ts` — ensure abort preserves session ID mapping
- `packages/daemon/src/runtimes/codex-runtime.ts` — same
- `packages/cli/src/commands/session.ts` — add `ap pause`, `ap nudge` commands
- `packages/cli/src/tui/Dashboard.tsx` — add `p` and `u` hotkeys
- `packages/escalation-mcp/src/tools/check-messages.ts` — reads from message queue
- `packages/daemon/src/db/migrations/006_progress.sql` — message queue table (or extend same migration)

---

## Phase 3: TUI Upgrades

### Progress bar component
- Segmented bar below each session in the table (or in detail panel)
- Segments colored by phase type (heuristic mapping: planning=red, implementing=orange, testing=blue, validating=green)
- Falls back to **activity-based inference** if agent doesn't call `report_progress`:
  - Lots of `Read`/`Grep` → "exploring" (red)
  - `Edit`/`Write` calls → "implementing" (orange)
  - `Bash` calls → "testing/building" (blue)
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

## Phase 4: CLAUDE.md Template Updates

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

This is **guidance, not enforcement** — we rely on the agent's cooperation. If an agent ignores it, the activity-based heuristic progress still works.

### Provider-agnostic note
These instructions work for any model/runtime that supports MCP tool calling. The CLAUDE.md format is just markdown — no provider-specific syntax.

---

## Implementation Order

| Step | What | Why first |
|------|-------|-----------|
| 1 | New event types in shared | Everything depends on the type definitions |
| 2 | MCP tools (report_plan, report_progress, check_messages) | Foundation — agents need these before TUI can show anything |
| 3 | DB migration + session repository changes | Persist plans, progress, message queue |
| 4 | Session manager changes (new event handling, pause, nudge) | Core orchestration logic |
| 5 | API routes (pause, nudge) | Expose to CLI |
| 6 | CLI commands (ap pause, ap nudge) | User-facing commands |
| 7 | CLAUDE.md template updates | Tell agents about the new tools |
| 8 | TUI components (progress bar, plan panel, metrics) | Visual layer — last because it consumes everything above |
| 9 | TUI keyboard shortcuts (p, u) | Wire up pause/nudge in dashboard |

---

## Open Questions

1. **Should `check_messages` be mandatory or optional?** If optional, agents that ignore it can only be hard-paused. If mandatory (enforced via instructions), it adds overhead to every session but enables smooth nudging.

2. **Progress bar segments — fixed colors or agent-defined?** Could let agents pass a `category` field (e.g., "planning", "coding", "testing") and map to colors, or keep it simple with position-based coloring.

3. **Message queue persistence** — SQLite table vs in-memory Map? SQLite survives daemon restarts but adds complexity. In-memory is simpler but messages lost on crash.

4. **Token counting** — Claude's NDJSON stream includes usage in the `result` event, but only at the end. For live token count, we'd need to estimate from content length mid-stream. Worth the complexity?

5. **Should `report_plan` block until acknowledged?** Currently proposed as fire-and-forget. Could optionally block so the human can approve the plan before the agent starts coding (like a lightweight gate). This would be powerful but adds latency to every session start.
