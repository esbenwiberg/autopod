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
