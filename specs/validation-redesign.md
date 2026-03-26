# Spec: Validation System Redesign — Smart Validation, Reports & Previews

## Goal

Replace the static, profile-coupled validation page system with a smart, task-aware validation pipeline. Agents self-validate during development (inner loop), an independent reviewer generates task-specific browser checks from acceptance criteria (outer loop), and the user gets a visual validation report with on-demand app preview — all layered on top of lightweight profile-level smoke tests.

## Background & Vision

### The problem

Autopod's current validation system has a fundamental coupling issue: **validation pages are defined on profiles, but profiles are reused across tasks.** A profile for a React app might assert that `/` has an `h1` containing "Welcome" — but if the task is "add a settings page," that assertion is irrelevant noise. Meanwhile, the thing that actually matters (does `/settings` work?) isn't checked at all.

The validation system is also a black box to the user. When a session completes, you get a pass/fail status and a PR link. There's no way to *see* what the agent built without pulling the branch and running it yourself. Screenshots exist in the pipeline but are thrown away after validation.

### The vision

**A two-loop validation system with full visibility.**

**Inner loop (agent self-validates):** While developing, the agent can open a browser, navigate its own app, and verify its work against the acceptance criteria. This catches obvious issues early and reduces wasted validation cycles. The agent is expected to use this — like a developer checking their work before pushing.

**Outer loop (independent AI reviewer):** After the agent commits, a separate reviewer model reads the acceptance criteria and independently decides what to verify in the browser. It has never seen the agent's self-validation results. It generates natural language instructions ("navigate to /settings, verify there's a dark mode toggle") that are executed via Playwright. This is the independent verification — the agent can't grade its own homework here.

**Profile-level smoke tests** remain as baseline sanity checks: does the app build? Does it boot? Does `/` render? These are infrastructure concerns, not task concerns, so they belong on the profile.

**The validation report** closes the feedback loop. A single HTML page served by the daemon shows everything: screenshots, assertions, build output, reviewer reasoning, diff — across all validation attempts. The user can see exactly what happened without touching the code.

**Preview environments** take it one step further: instead of just *seeing* screenshots, the user can *interact* with the actual running app. The container stays alive after validation, and a "Launch Preview" button on the report spins it up on demand.

### The flow

```
Session created with task + acceptance criteria
  -> Agent develops feature
  -> Agent self-validates against ACs via MCP browser tool (inner loop)
  -> Agent commits when satisfied
  -> Validation engine runs:
      1. Build (existing)
      2. Tests (existing)
      3. Health check (existing)
      4. Smoke pages from profile (renamed from validationPages)
      5. AC validation — reviewer generates checks from ACs (NEW, outer loop)
      6. AI code review (existing)
  -> Results stored per attempt (validation history)
  -> User opens validation report — sees everything
  -> User clicks "Launch Preview" — browses the actual app
  -> User approves or rejects
```

## Constraints

- Ship in 6 layers (each builds on the last), but all layers are in scope
- No DB migrations needed — rip and replace, single user
- `task` remains free-text; new optional `acceptanceCriteria: string[]` field on `CreateSessionRequest`
- Agent browser MCP tool scoped to `localhost` only — no external URLs, no side-channel around network isolation
- AI-derived validation uses natural language intent (not CSS selector guessing) — reviewer describes *what to verify*, a Playwright-capable executor carries it out
- Reviewer validation is fully blind — no access to agent's self-validation results
- Preview environments reuse existing container + port mapping — stop (not remove) after validation, restart on demand
- Preview only available for sessions with a stopped container — no re-provisioning from branch
- Container auto-stops after 10 minutes post-validation (configurable)
- Validation report uses Tailwind CDN, served as HTML from daemon
- All existing validation phases (build -> test -> health -> smoke -> AI review) remain; new phases are additive
- Follow existing code patterns: Biome, strict TypeScript, co-located tests, Zod schemas

## Non-goals

- Multi-page interactive flows (fill form -> submit -> verify redirect) — phase 2
- Visual regression / screenshot diffing between attempts — phase 2
- Performance budgets (load time thresholds) — phase 2
- Remote tunneling / sharing preview URLs outside localhost — not needed while running locally
- Structured AC schema enforcement — `acceptanceCriteria` is optional, free-text strings

## Failure Conditions

- If renaming `validationPages` -> `smokePages` leaves any dangling references in code, types, or tests
- If the agent MCP browser tool allows navigation outside `localhost`
- If the reviewer can see or is influenced by the agent's self-validation results
- If preview environments leak containers (no auto-stop, no cleanup)
- If the validation report crashes or returns 500 when validation data is missing/partial
- If AI-derived validation blocks on sessions that have no `acceptanceCriteria` — it should gracefully skip
- If TUI crashes when displaying sessions with new validation data structures (AC results, attempt history)

## Acceptance Criteria

### Layer 1: Rename validationPages -> smokePages
- [ ] `ValidationPage` type renamed to `SmokePage`, `validationPages` field renamed to `smokePages` on `Profile` type and Zod schema
- [ ] All references updated across all packages (daemon, cli, validator, shared, escalation-mcp)
- [ ] System instructions generator outputs "Smoke Pages" section instead of "Validation Pages"
- [ ] Profile CLI template uses `smokePages` key
- [ ] Existing tests pass with renamed types

### Layer 2: Validation history
- [ ] New `ValidationRepository` wired to existing `validations` table
- [ ] Every validation attempt is inserted (not just latest overwritten on session)
- [ ] `GET /sessions/:sessionId/validations` endpoint returns all attempts ordered by attempt number
- [ ] `lastValidationResult` on session still works as before (points to latest)
- [ ] Screenshots (base64) stored per attempt in the validations table

### Layer 3: Validation report
- [ ] `GET /sessions/:sessionId/report` returns self-contained HTML page
- [ ] Report header shows: session ID, task, profile, status, PR link, timestamps
- [ ] Attempt timeline: clickable tabs/sections for each validation attempt
- [ ] Per attempt: build output, test output, health check result, smoke page results with inline screenshots, AI review reasoning + issues
- [ ] Diff viewer section showing the agent's changes
- [ ] Pass/fail visual indicators (green/red) per phase and per assertion
- [ ] Styled with Tailwind CDN
- [ ] Handles partial data gracefully (e.g., no screenshots, no task review)

### Layer 4: Preview environments
- [ ] New `stop()` method on `ContainerManager` interface — stops without removing
- [ ] `DockerContainerManager.stop()` implementation using Dockerode
- [ ] After validation completes (pass or fail), container is stopped (not killed/removed)
- [ ] Auto-stop timer: configurable timeout (default 10 min), stops container after validation if still running
- [ ] `POST /sessions/:sessionId/preview` endpoint: restarts stopped container, runs start command, waits for health check, returns preview URL
- [ ] `DELETE /sessions/:sessionId/preview` endpoint: stops the container
- [ ] Preview URL returned in session API response when container is running
- [ ] "Launch Preview" / "Stop Preview" buttons on validation report page (JS calls the API)
- [ ] Returns 409 if container is removed or session is in terminal state without a container
- [ ] Container cleanup: containers are removed when session is killed or deleted (existing `kill()` behavior)

### Layer 5: AI-derived validation from ACs
- [ ] `acceptanceCriteria: string[]` added to `CreateSessionRequest` type and Zod schema
- [ ] `acceptance_criteria` column added to sessions table
- [ ] ACs passed through to system instructions (agent sees them)
- [ ] New validation phase after smoke pages: "AC validation"
- [ ] Reviewer model receives ACs + diff and generates natural language validation instructions (e.g., "navigate to /settings, verify there is a toggle labeled 'Dark Mode', verify it is visible and not disabled")
- [ ] Validation instructions executed in container via Playwright — a script that interprets natural language steps using an LLM to drive the browser
- [ ] Results include: per-AC pass/fail, screenshot of relevant page state, reasoning
- [ ] Phase is skipped gracefully when no `acceptanceCriteria` provided
- [ ] AC validation results included in `ValidationResult` type and shown in report

### Layer 6: Agent self-validation MCP tool
- [ ] New `validate_in_browser` tool registered on escalation MCP server
- [ ] Tool params: `{ url: string, checks: string[] }` — URL must be localhost, checks are natural language
- [ ] Tool executes Playwright in the container, navigates to URL, performs checks
- [ ] Returns: `{ passed: boolean, results: { check: string, passed: boolean, screenshot?: string, reasoning: string }[] }`
- [ ] URL validation: rejects any URL not matching `localhost` or `127.0.0.1`
- [ ] System instructions updated to inform agent about the tool and when to use it (verify work against ACs before committing)
- [ ] Agent's self-validation results are NOT stored or passed to the reviewer
- [ ] Tool available in all templates that have Playwright installed (`node22-pw`)

### TUI Updates (across all layers)
- [ ] `[w]` hotkey opens validation report in default browser (`http://localhost:{daemonPort}/sessions/{id}/report`) — available when session has validation results
- [ ] DetailPanel shows validation attempt navigation: "Attempt 2/3" with `[<]` `[>]` to cycle through historical attempts
- [ ] DetailPanel shows new "AC Validation" section between smoke pages and task review — per-AC pass/fail with reviewer reasoning
- [ ] DetailPanel shows preview status: active URL when container is running, "stopped (press [o] to launch)" when stopped
- [ ] `[o]` hotkey behavior: launches preview when container is stopped, opens preview URL when running, falls back to PR URL
- [ ] HotkeyBar updated: `[w]` "report" visible when validation results exist, `[o]` label is context-aware

## Context

Key files the implementing agent needs to understand:

- `packages/shared/src/types/profile.ts` — `ValidationPage`, `PageAssertion` types to rename to `SmokePage`
- `packages/shared/src/schemas/profile.schema.ts` — Zod schema for profile, `validationPageSchema` to rename
- `packages/shared/src/types/session.ts` — add `acceptanceCriteria` field to `CreateSessionRequest` and `Session`
- `packages/shared/src/types/validation.ts` — extend `ValidationResult` with AC validation phase results
- `packages/daemon/src/validation/local-validation-engine.ts` — add AC validation phase between smoke and task review
- `packages/validator/src/playwright-script.ts` — existing Playwright script generation pattern to follow
- `packages/daemon/src/interfaces/container-manager.ts` — add `stop()` method to interface
- `packages/daemon/src/containers/docker-container-manager.ts` — implement `stop()`, currently `kill()` stops AND removes
- `packages/daemon/src/sessions/session-manager.ts:processSession()` — main orchestration loop, post-validation container lifecycle
- `packages/escalation-mcp/src/server.ts` — add `validate_in_browser` tool following existing tool registration pattern
- `packages/daemon/src/sessions/system-instructions-generator.ts` — update "Validation Pages" section, add AC section, document browser tool
- `packages/daemon/src/api/routes/sessions.ts` — add `/report`, `/preview`, `/validations` endpoints
- `packages/daemon/src/db/migrations/001_initial.sql` — `validations` table already exists but is unwired
- `packages/daemon/src/sessions/correction-context.ts` — include AC validation failures in agent feedback
- `packages/cli/src/tui/components/DetailPanel.tsx` — add AC validation section, attempt navigation, preview status
- `packages/cli/src/tui/hooks/useKeyboard.ts` — add `[w]` hotkey, update `[o]` behavior
- `packages/cli/src/tui/components/HotkeyBar.tsx` — update labels for new/changed hotkeys
- `packages/daemon/src/validation/screenshot-collector.ts` — screenshots collected from container, stored as base64

## Decomposition

This spec is too large for a single agent session. Decompose into 6 briefs with explicit dependencies:

| Brief | Layers | Scope | Depends on |
|-------|--------|-------|------------|
| **01-foundation** | 1 + 2 | Rename `validationPages` -> `smokePages` across all packages. Wire up `validations` table with `ValidationRepository`, store every attempt, add `GET /sessions/:id/validations` endpoint. | — |
| **02-report** | 3 | Add `GET /sessions/:id/report` HTML endpoint. Tailwind CDN. Attempt timeline, screenshots, assertions, build output, diff, task review. Handles partial data gracefully. | 01 |
| **03-preview** | 4 | Add `stop()` to `ContainerManager`. Post-validation container lifecycle (stop, don't remove). Auto-stop timer (default 10 min). `POST/DELETE /sessions/:id/preview` endpoints. "Launch Preview" button on report page. | 01, 02 |
| **04-ac-validation** | 5 | Add `acceptanceCriteria: string[]` to `CreateSessionRequest`. New "AC validation" phase in validation engine — reviewer generates natural language checks from ACs, executed via LLM-driven Playwright. Results in `ValidationResult`. Graceful skip when no ACs. Include AC failures in correction context. **Context from prior briefs:** Report generator signature is still `generateValidationReport(session, validations)` — add AC section to `renderAttempt()` between smoke pages and task review. Container is now stopped post-validation (brief 03) so validation engine runs while container is still alive, before the stop. `createMockContainerManager()` in `mock-helpers.ts` already includes `stop`/`start` mocks. `startPreview()` reads `profile.startCommand`/`healthPath`/`healthTimeout` — if you change how profiles supply these, preview could break. 5 pre-existing test failures (copilot-runtime × 4, correction-context × 1) — not yours, earmarked for brief 06. | 01 |
| **05-agent-browser** | 6 | Add `validate_in_browser` MCP tool to escalation server. Scoped to localhost. Natural language checks executed via Playwright. Update system instructions. Results NOT passed to reviewer. | 04 (shares LLM+Playwright pattern) |
| **06-tui** | TUI | `[w]` hotkey for report. Validation attempt navigation in DetailPanel. AC validation section. Preview status indicator. Context-aware `[o]` hotkey. HotkeyBar updates. | 01, 02, 03, 04 |

### Execution order

```
01-foundation ──→ 02-report ──→ 03-preview
      │                              │
      └──→ 04-ac-validation ──→ 05-agent-browser
                    │
                    └──────────→ 06-tui (after 01-04)
```

Briefs 02 and 04 can run in parallel after 01 completes. Brief 06 should run last as it integrates all prior work into the TUI.

### Notes from Brief 01

Things the implementing agent for subsequent briefs should know:

- **`ValidationPage` alias still exported** — `packages/shared/src/types/profile.ts` has `export type ValidationPage = SmokePage` as a deprecated alias, re-exported from the shared index. Safe to remove in brief 06 cleanup if nothing external depends on it.
- **DB column name diverges from TS field** — The SQLite column is still `validation_pages` while the TypeScript field is `smokePages`. `profile-store.ts` handles the mapping. Anyone writing raw SQL against the profiles table needs to use `validation_pages`, not `smokePages`. Same pattern as `escalation_config` → `escalation`.
- **`validationRepo` is optional on `SessionManagerDependencies`** — Declared as `validationRepo?: ValidationRepository` so existing tests don't break. The daemon's `index.ts` wires it. The shared `createTestContext()` in `mock-helpers.ts` does NOT include it yet — brief 02 should add it if tests need to assert on validation history.
- **5 pre-existing test failures** — `copilot-runtime.test.ts` (4) and `correction-context.test.ts` (1). Path expectation mismatches from a container user/cwd change (`/root/` → `/home/node/`, worktree cwd → `/workspace/`). Not caused by brief 01. Brief 06 is a good place to clean them up.

### Notes from Brief 02

- **Report generator is a pure function** — `generateValidationReport(session, validations)` in `packages/daemon/src/validation/report-generator.ts` takes `Session` + `StoredValidation[]` and returns a self-contained HTML string. No side effects, no I/O, easy to extend.
- **Brief 03 must add preview controls to the report** — The report currently has no preview section. The "Launch Preview" / "Stop Preview" buttons need adding to the HTML. The generator's function signature may need a `daemonBaseUrl` or `daemonPort` parameter so the embedded JS knows where to `POST /sessions/:id/preview`.
- **Brief 04 must add AC validation section to the report** — `renderAttempt()` currently renders: build → test → health → smoke pages → task review. The AC validation phase should slot between smoke pages and task review. Once `ValidationResult` gains the AC results field, add a `renderAcValidation()` call in that function.
- **No shared types or DB schema changes** — Brief 02 only touched daemon-internal code. `ValidationResult`, `StoredValidation`, and the DB schema are untouched from brief 01.
- **`createTestContext()` still doesn't include `validationRepo`** — The integration test for the report endpoint works because it goes through the full server setup (which wires `validationRepo` via `index.ts`). Unit tests using `createTestContext()` from `mock-helpers.ts` still won't have it. Add it there if future briefs need to assert on validation history in session manager unit tests.
- **5 pre-existing test failures unchanged** — Same 5 as brief 01. Still earmarked for brief 06.

### Notes from Brief 03

- **`ContainerManager` now has `stop()` and `start()`** — Interface at `packages/daemon/src/interfaces/container-manager.ts`. Docker implementation is idempotent (swallows 304). ACI implementation throws 501 `NOT_SUPPORTED`.
- **Post-validation containers are stopped, not left running** — After `transition(s2, 'validated')` and `transition(s2, 'failed')` (max attempts), the container is stopped via `cm.stop()`. This means preview requires an explicit `startPreview()` call.
- **Auto-stop timer** — `previewTimers` Map inside session manager tracks `setTimeout` handles per session. Default 10 min (`PREVIEW_AUTO_STOP_MS`). Timers are `.unref()`'d so they don't block process exit. Cleared on kill, delete, manual stop, or timer reset on new preview start.
- **Preview API** — `POST /sessions/:id/preview` starts container + re-runs start command + polls health check. Returns `{ previewUrl }`. `DELETE /sessions/:id/preview` stops container. Both return 409 if no container.
- **Report preview section** — `renderPreviewSection()` in report-generator.ts. Uses `window.location.origin` for same-origin `fetch()` calls — no daemon URL plumbing needed. Only shown for post-validation sessions with a container.
- **`createMockContainerManager()` updated** — `mock-helpers.ts` now includes `stop` and `start` mocks. Integration test containerManager mock also updated.
- **No shared types or DB schema changes** — `Session.previewUrl` already existed from brief 01. No new types needed.
- **5 pre-existing test failures unchanged** — Same 5 as briefs 01-02. Still earmarked for brief 06.

#### Handover: what downstream briefs should know

- **Report generator signature unchanged** — Still `generateValidationReport(session, validations)`. Preview JS uses `window.location.origin` so no `daemonBaseUrl` param was needed. Brief 04 can add its AC validation section to `renderAttempt()` without touching the signature.
- **Container stopped in 3 code paths** — after `validated`, after `failed` (max attempts), and in the `catch` block of `triggerValidation()`. Brief 04 shouldn't need to touch these — the stop happens after state transitions.
- **`startPreview()` reads profile fields** — Uses `profile.startCommand`, `profile.healthPath`, and `profile.healthTimeout` from `profileStore.get()`. If brief 04 changes how profiles are fetched or how validation uses these fields, preview could be affected.
- **`previewTimers` is not exposed on the SessionManager interface** — It's module-scoped inside `createSessionManager()`. If brief 06 TUI wants to show "auto-stop in X minutes", there's no API for that yet — would need a `getPreviewStatus()` method.
- **Mock helpers are current** — `createMockContainerManager()` in `mock-helpers.ts` includes `stop` and `start`. Integration test mock also updated. Briefs 04/05 get these for free via `createTestContext()`.

### Notes from Brief 04

- **`acceptanceCriteria: string[] | null`** on `Session` type, `acceptance_criteria TEXT` column in sessions table, stored as JSON. `CreateSessionRequest` has optional `acceptanceCriteria?: string[]` with Zod schema max 50 items, 2000 chars each.
- **AC validation is phase 5** — runs between smoke pages (phase 4) and AI task review (phase 6) in `local-validation-engine.ts`. Only runs when `healthResult.status === 'pass'` AND `config.acceptanceCriteria` has entries AND `config.reviewerModel` is set.
- **Two-step LLM flow** — `generateAcInstructions()` calls reviewer LLM to produce natural language browser checks from ACs + diff + task. `executeAcChecks()` calls executor LLM to translate instructions into a Playwright script, writes to container, executes, parses results from `__AUTOPOD_AC_RESULTS_START__`/`__AUTOPOD_AC_RESULTS_END__` markers.
- **Brief 05 should reuse patterns** — The LLM→Playwright flow (`generateAcInstructions` + `executeAcChecks`) is the same pattern the agent browser MCP tool needs. Key functions to study: `executeAcChecks()` for script generation prompt structure, `parseAcResults()` for stdout marker parsing, screenshot collection via `base64 -w0` exec.
- **`AcValidationResult` and `AcCheckResult`** exported from `@autopod/shared`. `ValidationResult.acValidation` is optional (`AcValidationResult | null | undefined`).
- **Report generator unchanged signature** — Still `generateValidationReport(session, validations)`. Added `renderAcValidation()` between smoke pages and task review in `renderAttempt()`.
- **Correction context updated** — `failedStep` union now includes `'ac_validation'`. AC failures included in `screenshotDescriptions`. Feedback formatter has new "Acceptance Criteria Failures" section.
- **System instructions** — Adds `## Acceptance Criteria` section when `session.acceptanceCriteria` has entries, before custom instructions. Tells agent the system will independently verify each criterion.
- **Parser functions exported** — `parseAcInstructionsJson`, `parseAcResults`, `stripMarkdownFences` exported from `local-validation-engine.ts` for testing. Brief 05 can import these if needed.
- **5 pre-existing test failures unchanged** — Same 5 as briefs 01-03. Still earmarked for brief 06.

#### Handover: what downstream briefs should know

- **Brief 05 — the LLM→Playwright pattern is similar but the wrapper is different.** In brief 04, the LLM generates a *complete standalone Playwright script* (written to file, executed as `node /tmp/autopod-ac-validation.mjs`). The agent browser MCP tool is a different interaction model — it's a tool call with `{ url, checks }` params returning structured results. The *prompting pattern* (natural language → Playwright code) is reusable, but the execution wrapper (MCP tool handler vs. standalone script) will be different. Study `executeAcChecks()` for the prompt structure, not for the execution flow.
- **Brief 05 — parser functions are importable but may not fit.** `parseAcResults()` expects `__AUTOPOD_AC_RESULTS_START__`/`__AUTOPOD_AC_RESULTS_END__` stdout markers. If brief 05 uses a different output format, write a new parser. `stripMarkdownFences()` is generic and always useful.
- **Brief 06 — `Session` type now has `acceptanceCriteria: string[] | null`.** Any `Session` mock in TUI tests needs this field. It's non-optional on the type (always present, nullable). `ValidationResult.acValidation` is optional though (`AcValidationResult | null | undefined`), so existing TUI code reading `lastValidationResult` won't break — it just won't show AC data until the UI is added.
- **Brief 06 — AC failures are mixed into `screenshotDescriptions` in correction context.** This works fine for the correction message (it's just "what went wrong" text), but if the TUI wants to display AC failures separately, read from `validationResult.acValidation.results` directly — don't parse `screenshotDescriptions`.
- **No backwards-incompatible changes.** `acValidation` is optional on `ValidationResult`, `acceptanceCriteria` is nullable on `Session`. All pre-existing code keeps working without changes.
