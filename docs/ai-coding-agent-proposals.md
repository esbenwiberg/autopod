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

## Proposal 2: Tiered Validation (Fast Pre-Checks During Coding)

### Problem

Validation in autopod is a single phase that runs **after** the agent finishes coding. If the agent introduced a lint error on line 5, it doesn't find out until the entire implementation is "done" and the full validation pipeline runs. This wastes the agent's coding time and makes correction harder (more changes to untangle).

### Industry Pattern

**Stripe's three-tier feedback**:
- Tier 1: Pre-push hooks in <1 second, local linters in <5 seconds (catches issues immediately)
- Tier 2: Selective CI -- only relevant tests (catches integration issues)
- Tier 3: Full CI with a hard 2-round retry cap (catches everything else)

**Logic Inc's "short leash"**: Make a small change, check it, fix it, repeat. Quality checks must be cheap enough to run constantly.

**OpenAI**: Every milestone is verified before proceeding to the next. Verification commands run after each phase of work, not just at the end.

### Proposed Change

Add lightweight, fast checks that run **during** the `running` state, triggered by agent activity (e.g., after each commit, or periodically). These don't replace the full validation phase -- they supplement it with early feedback.

### Implementation

**Approach A -- Profile-level pre-check commands**:

Add a `preChecks` field to profiles:
```typescript
preChecks?: {
  /** Commands to run after each agent commit during the running phase */
  onCommit?: string[];  // e.g., ["npm run lint", "npm run typecheck"]
  /** How often to run checks (in seconds) during running phase */  
  intervalSeconds?: number;  // e.g., 60
  /** Commands to run on interval */
  onInterval?: string[];
}
```

When the session manager detects a new commit (via the existing commit tracking), it runs the pre-check commands in the container. If any fail, it injects a correction message to the agent's stream (similar to how validation failures are fed back today, but lighter weight).

**Approach B -- Nudge-based mid-session checks**:

Less invasive: leverage the existing nudge/message system. When the daemon detects a commit, it runs a fast check and if it fails, sends the result as a nudge message to the agent. No new infrastructure -- just wiring commit detection to a check-and-nudge flow.

**Files affected**:
- `packages/shared/src/types/profile.ts` -- add `preChecks` to Profile type
- `packages/daemon/src/sessions/session-manager.ts` -- add commit-triggered check logic in the event consumption loop
- `packages/daemon/src/containers/docker-container-manager.ts` -- run pre-check commands via existing `execInContainer()`

**Effort**: Medium. The building blocks exist (commit tracking, container exec, nudge messages). The new part is wiring them together and handling the timing/concurrency.

---

## Proposal 3: Blueprint/Workflow System

### Problem

`processSession()` is a ~3500-line monolith that hardcodes one workflow: provision -> code -> validate -> merge. Every session follows the same flow regardless of task type. There's no way to insert deterministic checkpoints between agentic phases, and the agent has full autonomy during the `running` phase with no structured gates.

### Industry Pattern

**Stripe's Blueprints**: Configurable workflow templates that wire **deterministic nodes** (git, lint, test -- executed by the harness, never by the AI) with **agentic nodes** (coding, reasoning -- executed by the AI model). The harness enforces the sequence. The agent can't skip linting or ignore test failures because the harness controls the flow.

Key Stripe finding: deterministic gates between agentic steps are the **single biggest reliability improvement**. "Git operations, linting, test execution, and pushing should never be left to vibes -- hardcode them."

### Proposed Design

A blueprint is a profile-level configuration defining a sequence of steps:

```yaml
# Each step is either deterministic (harness runs it) or agentic (agent runs it)
blueprint:
  steps:
    - type: agentic
      prompt: "Implement the feature described in the task"
    - type: deterministic
      command: "{profile.buildCommand}"
      name: "Build"
    - type: deterministic
      command: "npm run lint"
      name: "Lint"
    - type: agentic
      prompt: "Fix any build or lint errors from the previous steps"
      condition: "previous_failed"
    - type: deterministic
      command: "{profile.testCommand}"
      name: "Tests"
    - type: agentic
      prompt: "Fix failing tests"
      condition: "previous_failed"
```

**Step types**:
- `deterministic` -- daemon runs `execInContainer(command)` directly. Captures stdout/stderr. Success = exit code 0.
- `agentic` -- daemon starts/resumes the agent runtime with the given prompt. Agent runs until completion signal.
- `condition: "previous_failed"` -- step only runs if the previous deterministic step failed. Allows "fix loop" patterns.

**Example blueprints for different use cases**:

```yaml
# Default (matches today's behavior -- backward compatible)
blueprint:
  steps:
    - type: agentic
      prompt: "Implement the task"

# Frontend with incremental checks
blueprint:
  steps:
    - type: agentic
      prompt: "Implement the feature"
    - type: deterministic
      command: "npm run lint"
    - type: agentic
      prompt: "Fix lint errors"
      condition: "previous_failed"
    - type: deterministic
      command: "npm run build"
    - type: agentic
      prompt: "Fix build errors"
      condition: "previous_failed"
    - type: deterministic
      command: "npm test"
    - type: agentic
      prompt: "Fix failing tests"
      condition: "previous_failed"

# Database migration
blueprint:
  steps:
    - type: agentic
      prompt: "Write the database migration SQL and update the schema types"
    - type: deterministic
      command: "npm run migrate"
    - type: agentic
      prompt: "Write integration tests for the migration"
    - type: deterministic
      command: "npm test -- --grep migration"

# Security audit (read-only, no coding)
blueprint:
  steps:
    - type: agentic
      prompt: "Review the codebase for OWASP top 10 vulnerabilities. Produce a detailed report."

# Code review
blueprint:
  steps:
    - type: agentic
      prompt: "Review the diff on this branch. Check for bugs, security issues, and code quality."
```

### Implementation Phases

**Phase 1 -- Refactor (no new features)**:
Extract `processSession()` phases into named step functions. Each phase becomes a function: `runProvisionStep()`, `runAgentStep()`, `runValidationStep()`, `runMergeStep()`. The main loop calls them in sequence. This is a pure refactor -- behavior doesn't change.

**Phase 2 -- Blueprint type**:
Add `blueprint` to Profile type in `packages/shared/src/types/profile.ts`. Add DB migration for the new field. When no blueprint is specified, use the default (matching today's behavior).

**Phase 3 -- Blueprint walker**:
Replace the `processSession()` main loop with a step walker that reads the blueprint and executes steps in sequence. Deterministic steps use `execInContainer()`. Agentic steps use the existing runtime spawn/resume. Step results are stored and the condition system controls flow.

**Phase 4 -- Conditional steps and retry logic**:
Add the `condition` system. Add `maxRetries` per step. Add step-level progress events for WebSocket streaming.

**Files affected**:
- `packages/shared/src/types/profile.ts` -- Blueprint type definition
- `packages/daemon/src/sessions/session-manager.ts` -- major refactor into step functions + blueprint walker
- `packages/daemon/src/db/migrations/` -- new migration for blueprint column
- `packages/daemon/src/profiles/profile-validator.ts` -- Zod schema for blueprint validation

**Effort**: High. Phase 1 (refactor) is the most work but also the most valuable -- it makes the session manager maintainable regardless of whether full blueprints ship.

---

## Proposal 4: Context Relevance Scoring

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

## Proposal 5: /prep and /exec Skill Improvements

### Based on OpenAI ExecPlan research

Three specific enhancements to the existing `/prep` and `/exec` skills based on patterns from OpenAI's ExecPlan methodology:

### 5a. Living Document Updates

**Current state**: `/prep` creates static specs. `/exec` tracks progress via handovers but the plan itself doesn't update.

**ExecPlan pattern**: Plans are living documents with mandatory sections that get updated as work progresses:
- **Progress** -- timestamped checkboxes (`[x] (2026-04-12 14:30Z) Completed step 1`)
- **Surprises & Discoveries** -- unexpected behaviors, performance notes, bugs with evidence
- **Decision Log** -- each decision with rationale and date

**Proposed change**: Update `/exec` to maintain a `progress.md` file in the spec directory that gets updated after each brief completes. Include timestamps, deviations, and decisions. This creates a living audit trail of the execution.

### 5b. Idempotence & Recovery Section

**Current state**: Briefs don't document how to retry or roll back safely.

**ExecPlan pattern**: Every plan must describe "how to retry or roll back safely; ensures steps can be rerun without harm."

**Proposed change**: Add an optional `## Idempotence & Recovery` section to the brief template in `/prep`. For briefs that touch databases, external services, or stateful systems, this section documents: what happens if you run this brief twice? How do you undo it?

### 5c. Context & Orientation for Novice Agents

**Current state**: Briefs assume the executing subagent has some familiarity with the codebase.

**ExecPlan pattern**: "Treat the reader as a complete beginner to the repository who has only the current working tree and the single plan file."

**Proposed change**: Add a `## Context & Orientation` section to briefs that briefly explains the relevant parts of the codebase: key file paths, module purposes, how things connect. This makes subagents more effective, especially for complex briefs that touch unfamiliar areas.

### Files affected
- `skills/prep.md` -- update brief template with new optional sections
- `skills/exec.md` -- add progress.md maintenance to the orchestration loop
