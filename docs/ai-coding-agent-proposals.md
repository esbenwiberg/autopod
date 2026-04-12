# Detailed Proposals: Improvements Derived from Industry Research

These proposals come from analyzing how OpenAI (Codex/Harness Engineering), Stripe (Minions), Logic Inc, and matklad's ARCHITECTURE.md patterns apply to autopod. Each is something autopod doesn't already have.

---

## Proposal 1: Linter-as-Teacher Pattern

### Problem

When validation fails, `buildCorrectionMessage()` in `local-validation-engine.ts` tells the agent **what** failed but not **how to fix it**. The agent must figure out remediation on its own, burning tokens and sometimes failing to understand the root cause.

### Industry Pattern

OpenAI's custom linters inject **remediation instructions directly into the error message**. When a linter blocks a violation, the error text includes specific guidance: "This violates X. To fix it, do Y in file Z." The error message becomes a teaching moment -- the agent reads the failure and knows exactly what to do.

Stripe applies the same principle with their tiered feedback: known failure patterns have **auto-fix rules** that either fix the issue automatically or provide explicit remediation steps.

### Proposed Change

Enhance the validation correction message pipeline to include remediation context:

**Build failures**: Parse common error patterns (missing imports, type errors, undefined variables) and append remediation hints. E.g., instead of just forwarding the raw compiler error, add: "This is likely caused by [pattern]. Check [file] for the correct import path."

**Test failures**: Include the test name, assertion that failed, and the expected vs. actual values in a structured format the agent can act on directly.

**Smoke test failures**: Include the page URL, expected behavior, and screenshot diff description.

**AI task review failures**: The reviewer already produces issues -- ensure each issue includes a concrete suggestion, not just a description of the problem.

### Implementation

**Files affected**: `packages/daemon/src/validation/local-validation-engine.ts` (the `buildCorrectionMessage` area and validation result processing)

**Approach**:
1. Add a `remediation` field to validation phase results alongside existing `stdout`/`stderr`
2. For build failures: pattern-match common error types (TypeScript, ESLint, Jest) and generate remediation hints
3. For test failures: extract structured test results (test name, assertion, expected/actual) and format as actionable items
4. For AI review: ensure the review prompt asks for concrete fix suggestions, not just problem descriptions
5. Inject all remediation context into the correction message sent back to the agent

**Effort**: Lower -- mostly enriching existing messages, no architectural changes.

---

## Proposal 2: Blueprint/Workflow System (subsumes Tiered Validation)

### Problem

`processSession()` is a ~3500-line monolith that hardcodes one workflow: provision -> code -> validate -> merge. Every session follows the same flow regardless of task type. There's no way to insert deterministic checkpoints between agentic phases, and the agent has full autonomy during the `running` phase with no structured gates.

**This proposal also eliminates the need for a separate "tiered validation" feature.** Instead of bolting on pre-checks during the running phase, blueprints let profiles define deterministic validation steps (lint, typecheck, test) between agentic steps. The blueprint IS the tiered validation -- it's just more general and more powerful. Industry evidence (Stripe, OpenAI, Logic Inc) all converge on the same finding: fast feedback during coding, not just after, is the single biggest quality lever.

### Industry Pattern

**Stripe's Blueprints**: Configurable workflow templates that wire **deterministic nodes** (git, lint, test -- executed by the harness, never by the AI) with **agentic nodes** (coding, reasoning -- executed by the AI model). The harness enforces the sequence. The agent can't skip linting or ignore test failures because the harness controls the flow.

Key Stripe finding: deterministic gates between agentic steps are the **single biggest reliability improvement**. "Git operations, linting, test execution, and pushing should never be left to vibes -- hardcode them."

### Proposed Design

Many autopod repos are multi-stack (e.g., dotnet + node in one repo), so a blueprint that hardcodes `npm run lint` is useless. The design splits concerns into two profile fields:

1. **`stacks`** -- declared explicitly on the profile. Each entry names a kind, a working directory, and the canonical commands for that stack's `lint` / `build` / `test` / `typecheck`.
2. **`blueprint`** -- a stack-agnostic sequence of steps. Deterministic steps reference a typed check (`check: lint`) which the harness fans out across every declared stack.

```yaml
# Profile-level stack declaration
stacks:
  - kind: node
    cwd: packages/web
    commands:
      lint: "npm run lint"
      typecheck: "npm run typecheck"
      build: "npm run build"
      test: "npm test"
  - kind: dotnet
    cwd: src/Api
    commands:
      lint: "dotnet format --verify-no-changes"
      build: "dotnet build --no-restore"
      test: "dotnet test --no-build"

# Profile-level blueprint (stack-agnostic)
blueprint:
  steps:
    - type: agentic
      prompt: "Implement the feature described in the task"
    - type: check
      check: lint
    - type: agentic
      prompt: "Fix lint errors"
      condition: previous_failed
    - type: check
      check: build
    - type: agentic
      prompt: "Fix build errors"
      condition: previous_failed
    - type: check
      check: test
    - type: agentic
      prompt: "Fix failing tests"
      condition: previous_failed
```

**Step types**:
- `check` -- typed check (`lint` / `build` / `test` / `typecheck`). Harness fans out to every declared stack. Each fanout uses the stack's `cwd` and `commands.<check>`.
- `deterministic` -- literal command escape hatch. Harness runs `execInContainer(command)` directly. Use only when `check` can't express what's needed.
- `parallel` -- block containing explicit sub-steps that run concurrently. Escape hatch for cross-stack coordination the `check` abstraction doesn't cover.
- `agentic` -- daemon starts/resumes the agent runtime with the given prompt.
- `condition: previous_failed` -- step only runs if the previous check/deterministic step failed.

**Fanout semantics**: `check` runs **all stacks in parallel, no short-circuiting**. The agent sees the complete failure surface in one round-trip rather than fixing node lint, re-running, then discovering dotnet lint also fails. Failures are reported per-stack so error messages stay attributable (e.g., `dotnet lint failed at src/Api/Foo.cs:42`).

**Changed-files gating (v1)**: Before a `check` step executes, the walker diffs the session's branch against its base. If no files under a stack's `cwd` changed, that stack is skipped. Motivation: when the agent only touched TypeScript, re-running dotnet lint/build/test is pure latency. The walker logs skipped stacks so the agent can see what was bypassed.

**Blueprint inheritance**: Profiles already support `extends`. Blueprints and stacks compose the same way -- a child profile inherits the parent's stack list and blueprint, and can override individual entries by key. A child profile that only needs to swap a lint command doesn't copy-paste the whole blueprint.

**Mid-step escalations**: If the agent escalates (`ask_human`, `report_blocker`, etc.) during an agentic step, the walker pauses on that step -- same behavior as today. When the escalation resolves, the agentic step resumes and the walker continues.

**Example blueprints**:

```yaml
# Default (matches today's single-agent-phase behavior)
blueprint:
  steps:
    - type: agentic
      prompt: "Implement the task"

# Database migration
blueprint:
  steps:
    - type: agentic
      prompt: "Write the migration SQL and update schema types"
    - type: deterministic
      command: "npm run migrate"
    - type: agentic
      prompt: "Write integration tests for the migration"
    - type: check
      check: test

# Security audit (read-only, no coding)
blueprint:
  steps:
    - type: agentic
      prompt: "Review the codebase for OWASP top 10 vulnerabilities. Produce a report."

# Code review (diff-only)
blueprint:
  steps:
    - type: agentic
      prompt: "Review the diff on this branch. Flag bugs, security issues, and code quality."
```

### Implementation Phases

**Phase 1 -- Refactor (no new features)**:
Extract `processSession()` phases into named step functions (`runProvisionStep()`, `runAgentStep()`, `runValidationStep()`, `runMergeStep()`). Pure refactor -- behavior unchanged.

**Phase 2 -- Types + migration**:
Add `stacks` and `blueprint` to the Profile type in `packages/shared/src/types/profile.ts`. DB migration for new columns. Since we're dropping `buildCommand` / `testCommand` entirely (no backward compat needed), the migration can just remove them.

**Phase 3 -- Blueprint walker**:
Replace the `processSession()` main loop with a step walker that reads the blueprint. `check` steps resolve against the stack list and fan out in parallel. `agentic` steps use the existing runtime spawn/resume. Step results are persisted so the `condition` system can key off them.

**Phase 4 -- Changed-files gating + progress events**:
Walker computes the changed-file set once per check step and skips stacks whose `cwd` is untouched. Emit step-level progress events over the WebSocket stream so the CLI/desktop can show which step is running and which stack fanouts failed.

**Files affected**:
- `packages/shared/src/types/profile.ts` -- `Stack`, `Blueprint`, `Step` type definitions
- `packages/daemon/src/sessions/session-manager.ts` -- major refactor into step functions + walker
- `packages/daemon/src/db/migrations/` -- new migration: add `stacks` + `blueprint` columns, drop `build_command` + `test_command`
- `packages/daemon/src/profiles/profile-validator.ts` -- Zod schema for stacks + blueprint
- `packages/daemon/src/profiles/inheritance.ts` -- extend `extends` resolution to merge stacks/blueprint by key
- CLI profile commands -- surface stack declaration in profile create/edit flows

**Effort**: High. Phase 1 (refactor) is the most work but also the most valuable -- it makes the session manager maintainable regardless of whether full blueprints ship.

---

## Proposal 3: Context Relevance Scoring

### Problem

`system-instructions-generator.ts` injects all configured sections into the container CLAUDE.md regardless of task relevance. A session working on a database migration still gets frontend smoke test instructions, MCP tool descriptions it won't use, etc. This wastes context window tokens and can dilute the agent's focus.

### Industry Pattern

**Stripe**: ~500 tools available via Toolshed, but only ~15 curated per task. A context assembly pipeline gathers data, scores each piece for relevance, and prunes to fit within the token budget.

**OpenAI**: "Context is a scarce resource. When everything is important, nothing is." Progressive disclosure -- short map in context, deeper docs available on demand.

### Proposed Change

Score each injected section and MCP tool against the task description for relevance. Prune low-relevance content. Keep a token budget and prioritize high-relevance sections.

### Implementation

**Approach -- Keyword/Embedding Scoring**:

1. At section injection time, compute a relevance score between the section content and the task description
2. Simple approach: keyword overlap (count shared significant words between task and section heading/content)
3. Advanced approach: embedding similarity (if a model is available)
4. Sort sections by relevance score, inject highest-relevance first, stop when token budget is reached
5. For sections that don't make the cut, add a one-line summary to a "Additional context available via memory_read" section

**Files affected**:
- `packages/daemon/src/sessions/system-instructions-generator.ts` -- add scoring and budget logic

**Effort**: Medium for keyword approach, higher for embedding approach. The keyword approach gives 80% of the value.

---

## Proposal 4: /prep and /exec Skill Improvements

### Based on OpenAI ExecPlan research

Two enhancements to the existing `/prep` and `/exec` skills, based on patterns from OpenAI's ExecPlan methodology. Handovers stay as-is -- they're how subagents get briefed without the orchestrator's full context, and nothing here replaces them. These additions sit alongside handovers (handovers are forward-looking; progress.md is backward-looking).

### 4a. Living Document Updates

**Current state**: `/prep` creates static specs. `/exec` tracks progress via handovers but the plan itself doesn't update.

**ExecPlan pattern**: Plans are living documents with mandatory sections that get updated as work progresses:
- **Progress** -- timestamped checkboxes (`[x] (2026-04-12 14:30Z) Completed step 1`)
- **Surprises & Discoveries** -- unexpected behaviors, performance notes, bugs with evidence
- **Decision Log** -- each decision with rationale and date

**Proposed change**: Update `/exec` to maintain a `progress.md` file in the spec directory that gets updated after each brief completes. Include timestamps, deviations, and decisions. This creates a living audit trail of the execution.

### 4b. Context & Orientation for Novice Agents

**Current state**: Briefs assume the executing subagent has some familiarity with the codebase.

**ExecPlan pattern**: "Treat the reader as a complete beginner to the repository who has only the current working tree and the single plan file."

**Proposed change**: Add a `## Context & Orientation` section to briefs that briefly explains the relevant parts of the codebase: key file paths, module purposes, how things connect. This makes subagents more effective, especially for complex briefs that touch unfamiliar areas.

### Files affected
- `skills/prep.md` -- add `## Context & Orientation` section to brief template
- `skills/exec.md` -- add progress.md maintenance to the orchestration loop

---

## Proposal 5: `run_checks` MCP Tool + Self-Validating Briefs

### Problem

The blueprint system (Proposal 2) enforces deterministic gates between agentic steps in a single session. But long-running sessions driven by `/exec` are a single giant agentic step from the harness's POV -- the agent may burn through many briefs over hours without ever hitting a deterministic check. Worse, `/exec` can dispatch briefs concurrently, so there is no coherent "between briefs" window for the harness to gate on: a brief completing while another is in flight would see lint errors caused by work that isn't even its own.

The fix has to live with the agent, not the harness. Each brief needs to run its own checks before declaring itself complete.

### Industry Pattern

Stripe's finding again: "linting, test execution, pushing should never be left to vibes." The blueprint walker handles that for top-level sessions. Within a brief (which is effectively its own nested agentic flow), the equivalent is a first-class tool the agent calls -- not a shell command it might forget to run.

### Proposed Design

**New MCP tool** exposed by `@autopod/escalation-mcp`:

```
run_checks({
  checks: ["lint", "typecheck", "build", "test"],  // subset of declared stack checks
  stacks?: ["node", "dotnet"]                       // optional: restrict fanout to named stacks
}) -> {
  results: [
    { stack: "node", check: "lint", passed: true, stdout: "...", stderr: "..." },
    { stack: "dotnet", check: "lint", passed: false, ... },
    ...
  ],
  skipped: [ { stack: "dotnet", reason: "no changed files under src/Api" } ]
}
```

The tool reuses the same stack-aware dispatcher the blueprint walker uses (Proposal 2). Same command resolution, same per-stack `cwd`, same changed-files gating. One implementation, two entry points (walker and MCP tool).

**`/exec` skill rule**: each brief must call `run_checks` before signaling completion, and fix any failures before handing back control. Framed as a non-negotiable in the skill text, same energy as the existing "always push before handover" rules.

**Tiering**: the skill recommends `lint` + `typecheck` per brief as the default (fast, cheap, catches 80%). Full `build` + `test` runs at the end of `/exec`, not after every brief. Briefs can opt into heavier checks via their own logic.

### Concurrent Briefs

If two briefs run concurrently and both call `run_checks`, they'll see each other's in-flight changes. Two mitigations:

1. **Decomposition discipline**: `/prep` should produce concurrent briefs only when they operate on non-overlapping surfaces. This is already a correctness requirement for concurrent briefs -- checks just make the existing constraint visible earlier.
2. **Scoped reporting**: `run_checks` results include the stack and file path of each failure. The brief's subagent can filter "errors under files I own" from "errors caused by a sibling brief." If all the agent's own files pass, it can complete even if the workspace has unrelated failures.

Full workspace isolation per brief (separate worktrees) is out of scope -- that's a different, much bigger change.

### Why This Lives Alongside Blueprints, Not Inside Them

`run_checks` is useful beyond `/exec`: any long agentic step (exploratory refactor, investigation, one-shot session without a blueprint) gets access to the same tool. Blueprints enforce gates at the session level; `run_checks` enforces them at the brief/sub-task level. Both share the same check dispatcher, so there's no duplication.

### Implementation

**Files affected**:
- `packages/escalation-mcp/src/tools/run-checks.ts` -- new tool implementation
- `packages/escalation-mcp/src/server.ts` -- register tool
- `packages/escalation-mcp/src/session-bridge.ts` -- add `runChecks()` method to the bridge interface
- `packages/daemon/src/sessions/session-bridge-impl.ts` -- wire bridge to the shared stack check dispatcher (extracted from the blueprint walker)
- `packages/daemon/src/sessions/stack-dispatcher.ts` -- new module: the shared dispatcher used by both walker and MCP tool
- `skills/exec.md` -- mandate calling `run_checks` at the end of each brief

**Dependency**: Proposal 2's stack declaration must land first. `run_checks` has nothing to dispatch against without profile-level stacks. If Prop 2 Phase 1-2 are shipping, this can piggyback on the same stack types.

**Effort**: Low-to-medium. The hard part (stack-aware dispatch + changed-files gating) already has to be built for Proposal 2. This proposal is just a second entry point into it.

---

## Proposal 6: Scheduled & Event-Triggered Sessions

### Problem

Every autopod session today is triggered by a human POSTing to the REST API. The daemon has no way to kick off work on a schedule (nightly dep upgrades, morning CVE scans, daily docs refresh) or in response to external events (PR opened, GitHub issue labelled, webhook from an external tool). The existing fix-session spawning on CI failure / `CHANGES_REQUESTED` review comments is the only non-human trigger, and it's hardcoded into the merge-polling loop rather than a general mechanism.

### Industry Pattern

Every serious background-agent platform (Ona, Stripe, Ramp) treats triggers as a first-class primitive. Webhooks fire agents on PR events. Cron schedules run nightly maintenance sweeps. Entry points exist from Slack, editors, CLIs. The insight from the Ona "docs automation" post: batching work into scheduled runs (daily digest rather than per-commit) produces better signal-to-noise than reacting to every change.

This is the capability gap that converts autopod from "I ask it to do a thing" into "it shows up in the morning with the thing already done."

### Proposed Design

Two trigger types, both creating regular sessions with the same state machine and lifecycle as manually-created ones:

**Cron-triggered sessions**: a new `session_triggers` table with:
- `id`, `profile_id`, `prompt_template`, `schedule` (cron expression), `enabled`, `last_fired_at`, `next_fire_at`
- A daemon-side scheduler loop wakes on `next_fire_at`, creates a session from the profile + template, updates `next_fire_at` to the next cron occurrence.
- Typical uses: nightly `npm audit fix`, weekly Biome lint sweep across a profile's repo set, daily docs digest.

**Event-triggered sessions**: a new `/api/triggers/webhook/:triggerId` endpoint that accepts inbound POSTs (with HMAC-verified signatures) and matches them against configured trigger definitions:
- GitHub webhook on `pull_request.opened` -> spawn a review session with a review-focused blueprint
- GitHub webhook on `issues.labeled` (with label `autopod:fix`) -> spawn a session to address the issue
- Generic webhook with JSON body -> template-interpolate into a prompt

The existing fix-session-on-CI-failure logic in `startMergePolling()` collapses into an event trigger: "on check_run.completed with conclusion=failure, spawn fix session." Less hardcoded, same behaviour.

### Why this matters for autopod specifically

This is what enables the scheduled-migration and automated-PR-review use cases. Without it:
- Every CVE patch is "I remembered to run autopod today"
- Every PR review is post-hoc
- Docs drift forever because nothing prompts the refresh

With it, autopod becomes a resident capability rather than a pull-based tool.

### Implementation

**Files affected**:
- `packages/daemon/src/db/migrations/0NN_session_triggers.sql` -- new table
- `packages/daemon/src/triggers/trigger-repository.ts` -- CRUD
- `packages/daemon/src/triggers/cron-scheduler.ts` -- background loop (setInterval or node-cron)
- `packages/daemon/src/triggers/webhook-handler.ts` -- HMAC verification + payload matching
- `packages/daemon/src/api/routes/triggers.ts` -- REST endpoints for trigger CRUD + inbound webhook
- `packages/daemon/src/sessions/session-manager.ts` -- refactor `maybeSpawnFixSession` to be a consumer of the generic trigger system
- `packages/cli/src/commands/trigger.ts` -- CLI commands to create/list/disable triggers

**Effort**: Medium. Scheduler is ~200 lines. Webhook handling is mostly HMAC + routing. The bigger work is carving out `maybeSpawnFixSession` into a trigger consumer without regressing the existing fix flow.

---

## Proposal 7: Drop `NET_ADMIN` After Firewall Setup

### Problem

`packages/daemon/src/containers/docker-container-manager.ts:68` grants `CapAdd: ['NET_ADMIN']` to every session container and never drops it. The firewall script (`docker-network-manager.ts`) is generated daemon-side but **executed inside the container** as root via `refreshFirewall()` -- which writes `/tmp/firewall.sh` and execs it with `User: 'root'`. The capability stays live for the entire session lifetime.

The agent process runs as the non-root `autopod:1000` user, so direct exploitation requires the agent to reach root first. But the attack surface is bigger than it looks:
- If `sudo` is configured for `autopod` in any base image (common for dev containers that need `apt install`), one `sudo iptables -F OUTPUT` flushes egress restrictions entirely
- Any setuid binary in the image that's exploitable becomes a path to `iptables`
- Container-escape CVEs that gain in-container root also gain `NET_ADMIN`

Ona's Veto writeup made this concrete: Claude Code disabled its own sandbox when a task required it. Not a jailbreak, not a special prompt -- the agent just wanted to finish the work. Treating the container as if it won't try to escape its own restrictions is the wrong posture.

### Proposed Change

Drop the `NET_ADMIN` capability from the container's **capability bounding set** after the firewall script finishes. Once dropped from the bounding set, no process in the container (including root) can ever use it again -- the kernel blocks the syscall regardless of UID.

The firewall configures iptables as today, then appends a final step:

```sh
# After all iptables rules are set, permanently drop NET_ADMIN from the bounding set.
# Even a root process inside the container can no longer modify iptables from this point.
capsh --drop=cap_net_admin -- -c "exit 0" 2>/dev/null || true
```

Or equivalently via `prctl(PR_CAPBSET_DROP)` from a small helper. The container has had the capability for roughly 500ms during provisioning, then loses it forever.

### Why this works

The Linux capability bounding set is a per-process inherited mask. Dropping from the bounding set is irreversible for that process and all its descendants. Because the firewall script is the ancestor of every process the agent will later spawn, dropping there means no descendant can ever regain `NET_ADMIN` -- not via sudo, not via setuid, not via a direct syscall.

This is meaningfully different from just running the agent as non-root: that relies on "agent can't reach root." This removes the capability from the kernel-enforced bounding set regardless of UID.

### Secondary hardening (recommended alongside)

- **Audit base images for passwordless sudo on the `autopod` user**. If any base image allows `sudo` without password, the agent can trivially escalate to root. Remove or password-gate. Even with the capability drop this is the right hygiene.
- **Consider applying rules host-side** (nsenter into the container's netns) as a follow-up. The capability drop closes the immediate vulnerability; host-side rules would mean the container never has `NET_ADMIN` even for 500ms. Higher effort -- the current `dnsmasq+ipset` mode uses `-m owner --uid-owner nobody` which is process-scoped and needs the container's process table. Defer unless threat model demands it.

### Implementation

**Files affected**:
- `packages/daemon/src/containers/docker-network-manager.ts` -- append the `capsh` drop to every generated firewall script (all three modes: allow-all, deny-all, restricted)
- Base container images -- verify `capsh` (from `libcap`) is installed; add if missing. Alternative: use a tiny C helper or the `setpriv` tool which is more commonly preinstalled.
- `packages/daemon/src/containers/docker-container-manager.test.ts` -- add coverage verifying the script includes the drop and that an attempted post-drop `iptables -F` would be rejected

**Effort**: Low. One-line addition to the firewall script + image check for `capsh`/`setpriv`. Biggest risk is a base image missing the tool -- falls back to a no-op with `|| true`, meaning it's silent-fail rather than blocking.

---

## Proposal 8: Question-Surfacing Heuristic

### Problem

Agents regularly ask questions in plain prose ("should I use X or Y?", "do you prefer A or B?") instead of invoking the `ask_human` MCP tool. When this happens inside a running session:
- The question never triggers the `awaiting_input` state
- It gets buried in the event stream alongside tool-use noise
- The CLI/desktop has no visible signal that the agent is blocked on you
- The agent either sits idle waiting for a response it has no way to receive, or picks arbitrarily and moves on

This is dead time at best, wrong decisions at worst. Ona's team identified and fixed exactly this in their todo-tool overhaul -- the equivalent failure mode was questions buried inside todo items instead of surfaced as pending user input.

### Proposed Change

A lightweight heuristic that inspects agent text messages for likely questions and surfaces them as a soft-pending state in the CLI/desktop UI. Not a state transition -- the session stays `running` -- but a UI hint that the user may be holding up work.

**Detection rules** (pattern-matched on streamed assistant text, not requiring an LLM):
- Message ends with `?` and has no accompanying tool call in the same turn
- Contains phrases: `should I`, `would you like`, `do you prefer`, `which would`, `or would you rather`, `let me know`, `please confirm`, `should we`, `is that correct`
- Agent's next action is not a tool call within N seconds (idle detection)

When matched, emit a new `SystemEvent` type `AGENT_LIKELY_WAITING` with the snippet and confidence. CLI renders a `⚠ agent may be waiting on input` banner. Desktop shows a notification badge. The session itself doesn't change state -- this is purely a UX signal.

**Reinforcement via skill**: update the Claude system instructions to strongly prefer `ask_human` over inline questions, and cite the heuristic ("if you ask inline, the user may not see it"). Two-layer defense: the heuristic catches drift, the skill text prevents it.

### Why not just make the agent do it right

Per Ona's finding (and every agent framework operator's experience): agents drift. No amount of system prompt rigor eliminates this failure mode over long sessions. You need a runtime detector, not just a better instruction.

### Implementation

**Files affected**:
- `packages/shared/src/types/events.ts` -- new `AGENT_LIKELY_WAITING` event type
- `packages/daemon/src/sessions/session-manager.ts` -- inject heuristic into the assistant-text event path; emit the new event when matched
- `packages/daemon/src/sessions/question-detector.ts` -- new module with the pattern rules + idle timer
- `packages/cli/src/commands/session.ts` -- render the banner on the live session view
- `packages/desktop/` -- badge + notification on `AGENT_LIKELY_WAITING`
- Claude skill / system-instructions-generator -- add the "prefer `ask_human`" reinforcement text

**Effort**: Low. Pattern matching is straightforward. Desktop integration is the fiddliest piece; CLI is a one-liner.
