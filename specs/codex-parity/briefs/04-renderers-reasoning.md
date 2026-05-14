---
title: "Render reasoning events in desktop and CLI"
depends_on: [01-establish-shared-contracts]
acceptance_criteria:
  - type: cmd
    outcome: Swift AgentEventType has reasoning case
    hint: grep -nE "case reasoning" packages/desktop/Sources/AutopodUI/Models/AgentEvent.swift
    polarity: expect-output
  - type: cmd
    outcome: CLI watch has explicit reasoning case
    hint: grep -nE "case 'reasoning'" packages/cli/src/commands/pod.ts
    polarity: expect-output
touches:
  - packages/desktop/Sources/AutopodUI/Models/AgentEvent.swift
  - packages/desktop/Sources/AutopodUI/Models/MockEvents.swift
  - packages/desktop/Sources/AutopodUI/Views/Logs/LogStreamView.swift
  - packages/cli/src/commands/pod.ts
does_not_touch:
  - packages/daemon/
  - packages/shared/
---

## Task

Render the new `reasoning` event variant in the desktop and CLI UIs.

**Desktop**: Today `AgentEvent.swift:16` has `.output` with the literal label `"Agent text output / reasoning"` — clearly a placeholder for reasoning that was waiting for the variant to exist. Rename `.output` → `.reasoning` throughout:

- `AgentEvent.swift:5-80` — rename the enum case from `output` to `reasoning`. Update label `"Output"` → `"Reasoning"`. Keep `icon: "text.quote"` and `color: .secondary` (both are already the right semantic choices for reasoning). Update the `isOverviewWorthy` switch at line 76 — replace `.output` with `.reasoning` (still not overview-worthy; reasoning is detail-view content).
- `MockEvents.swift:25, 80, 102` — update 3 mock event creations from `.output` to `.reasoning`. Labels in the mock text already read like reasoning ("The codebase doesn't have any OAuth implementation yet. I need to decide..."), so no copy changes needed.
- `LogStreamView.swift:104` — update the visible-events filter array. The line currently lists `.escalation, .plan, .progress, .error, .output, ...` — replace `.output` with `.reasoning`.

**CLI**: Add an explicit `case 'reasoning'` in the `ap pod watch` event switch at `packages/cli/src/commands/pod.ts:670`. Today reasoning falls through to the `default: console.log(${ts} ${chalk.dim(JSON.stringify(inner))})` at line 727 — a generic JSON dump. Render explicitly as:

```ts
case 'reasoning':
  console.log(`${ts} ${chalk.dim.italic(`[reasoning${inner.isRaw ? ' raw' : ''}]`)} ${chalk.dim(inner.text.slice(0, 500))}`);
  break;
```

Truncate to 500 chars for line-fit; the full text is available via `ap pod inspect` for users who want it.

## Touches

- `packages/desktop/Sources/AutopodUI/Models/AgentEvent.swift`
- `packages/desktop/Sources/AutopodUI/Models/MockEvents.swift`
- `packages/desktop/Sources/AutopodUI/Views/Logs/LogStreamView.swift`
- `packages/cli/src/commands/pod.ts`

## Does not touch

- `packages/daemon/` — runtime + parser changes are gated by briefs 02, 03, 05.
- `packages/shared/` — contracts are gated by brief 01.

## Constraints

- **Swift enum `rawValue`s must remain stable for wire-crossing cases.** The current `.output` case doesn't cross the wire (no daemon event has `type: "output"`), so the rename is wire-safe. The new `.reasoning` case must have `rawValue == "reasoning"` (the daemon emits exactly `type: 'reasoning'`). Use the Swift default rawValue convention (case name) — confirmed identical for `.reasoning`.
- **CLI: the `default` fallback already catches reasoning** via JSON dump. The explicit case is purely a UX improvement (dim + italic + truncated). It's worth doing, but reviewers can ignore-or-accept the AC theatre risk — there's no behavioural break if this is dropped.
- **Label change "Output" → "Reasoning"**: grep the rest of the desktop sources for any UI string referencing "Output" that depends on the canonical event name. Most "output" references in `AgentEvent.swift:30` and beyond are the enum label; PodConfig / Pod.swift / DetailPanelView references to `pod.pod.output` are a different concept (the pod's `OutputMode` — `pr`/`artifact`/`workspace`) and must not be touched.
- **MockEvents content is not part of the wire contract** — the mock data is purely for desktop development without a live daemon. Updating it keeps the dev experience accurate but doesn't need to be byte-perfect.

## Test expectations

- No new vitest for CLI — the `ap pod watch` command has no event-rendering test suite today. Test expectations is observational: pipe a fixture JSONL through `ap pod watch` and visually verify a `reasoning` line renders in dim italic.
- Desktop has no Swift unit tests for `AgentEventType` rendering. Verification is observational — open the desktop app on a Codex or Claude pod that emits reasoning (after briefs 02 and 03 land), confirm the reasoning entries render with the new `.reasoning` styling in `LogStreamView`. Reviewer judges via screenshot in the PR.
- The Swift build itself catches any compile error from the rename (`pnpm` doesn't build Swift, but Xcode does; reviewers run `xcodebuild` per `packages/desktop/CLAUDE.md` if it exists, or just open the project).

## Risks / pitfalls

- If brief 01 has not yet landed when this brief is dispatched (e.g. someone runs the series out of order), the CLI brief won't typecheck — `event.type === 'reasoning'` will be unreachable. The `depends_on: [01-establish-shared-contracts]` ordering prevents this in `ap series create`, but call it out for any manual workflow.
- Swift desktop build is NOT in the autopod pnpm pipeline. Don't rely on `pnpm build` to catch Swift errors — reviewers must check the desktop side separately. Reviewer screenshot is the real anchor.

## Wrap-up

Before finishing:
1. Run `/simplify` and address its findings.
2. Re-run build and tests; both must still pass.
3. Commit and push.
