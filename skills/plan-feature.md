---
name: plan-feature
description: >
  Decomposes a large feature into a series-ready brief folder for `ap series create`.
  Interviews the user one question at a time while scanning the codebase continuously,
  until the feature is fully understood and ready for autonomous agent execution.
  Use when the task spans 3+ modules or 4+ hours of work.
  Outputs specs/<name>/ with context.md, contracts.md, decisions/, and briefs/.
allowed-tools: Read, Grep, Glob, Bash, Write, Edit, Agent
---

# /plan-feature

Turn a rough feature idea into a fully structured `specs/<name>/` folder that `ap series
create` can execute without any further clarification. Nothing is written until everything
is clear.

## When to use

- Task touches 3+ modules or will take more than ~4 hours
- You need independent validation checkpoints between work phases
- You want the work split across parallel or sequential agent pods

If the task is clearly single-checkpoint (one module, a few files), recommend `/prep` instead.

## How this works

This skill runs a continuous interview-plus-research loop — not a fixed set of phases.
The loop runs until the exit test passes. Then and only then does it write output.

```
scan codebase → surface finding → ask ONE question → wait for answer →
scan codebase again → ask ONE question → wait → ... → exit test passes → write output
```

### Rules (non-negotiable)

- **One question per turn. Full stop.** Never batch two questions.
- After every answer, search the codebase again before forming the next question.
  New answers open new search paths — always follow them.
- If the codebase already answers a question, don't ask — cite the finding and move on.
- Never draft briefs, contracts, or ADRs during the loop. Writing happens only after
  the exit test passes.
- **The coverage checklist is the only stop sign — not a question count.**
  Don't treat any number as a target to hit and stop. A low question count is
  a symptom of skipping the interview, not a budget to spend.
- **Asymmetric signal:** if you're on question 2 or 3 of a 3+ module feature
  and feeling ready to write, you are almost certainly wrong — keep going.
  If you're on question 15 and the checklist is still red, keep going.
  There is no "enough" — only "checklist green, confirmed by user."
- **Bias toward more questions, not fewer.** Every ambiguous noun in the user's
  original prompt (e.g. "scheduler UI", "auth flow", "the new backend") is a
  question waiting to happen. Pin them down one at a time.

### Opening move

Before asking anything, scan the codebase for 3–5 minutes:

1. What does existing code already handle in this area?
2. Where are the seams — places where one module hands off to another?
3. What shared types/interfaces cross module boundaries?
4. What's the test coverage like in the blast radius?
5. Are there any existing ADRs or CLAUDE.md sections relevant here?

Present a 3–5 bullet summary of findings. Ask the first question. Stop.

### What to clear during the loop

Each scan+question round should resolve one of these:

1. **Blast radius** — which files/modules change? Any unexpected dependents?
2. **Seams** — where does one module hand off to the next? Those are pod boundaries.
3. **Shared contracts** — what types/interfaces cross pod boundaries? Who owns them?
4. **Existing constraints** — patterns, naming conventions, ADRs agents must follow?
5. **Test coverage** — what's currently covered? What new coverage is expected?
6. **Ambiguity** — any word in the feature description that two people would interpret differently?
7. **Pod sizing** — is any brief getting too large? Rule of thumb: > 8 files → split it.
8. **Acceptance criteria** — how will we know each brief is done, without human judgment?

### Exit test — the coverage checklist (NOT silent)

Before writing any output, produce a checklist covering **all 8 dimensions above**.
For each dimension, one of these must be true:

- ✅ Answered by the user (quote their answer, cite which question)
- 📂 Answered by the codebase (cite the file(s) and what they told you)
- ⚠️ Explicitly marked N/A with a one-line justification

If any dimension is hand-waved ("probably fine", "we can figure that out", "TBD"),
that's a ❌ — ask another question.

Additionally, for every brief you're about to write, confirm you can name:

- The exact files it touches
- The interfaces it must respect
- The ACs it must satisfy
- The files it must NOT touch
- The dependency graph, without guessing

**Show the checklist back to the user** with a clear "ready to write — green light?"
prompt. Do NOT start writing `specs/<name>/` until the user confirms. This is the
only batched "question" allowed — because it's a summary, not new interrogation.

If the user spots a gap, keep interviewing. Do not negotiate your way to writing
early.

---

## Output structure

```
specs/<feature-name>/
├── context.md          ← auto-injected into every pod by `ap series create`
├── contracts.md        ← shared interfaces that cross pod boundaries
├── decisions/
│   └── 001-<name>.md  ← ADR for each hard-to-reverse architectural decision
└── briefs/
    ├── 01-<name>.md    ← numeric prefix = execution order; same number = parallel
    ├── 02-<name>.md
    └── ...
```

### context.md

Feature goal, non-goals, key constraints, pointers to relevant existing code.
Written for an agent that has never seen this codebase before.
Every pod reads this verbatim. Keep it under 300 words.

### contracts.md

Any interface, type, or API contract that more than one brief produces or consumes.
If brief A's output is brief B's input, the contract lives here — not in either brief.

### ADR format

Write only for hard-to-reverse or surprising decisions:

```markdown
# ADR-001: <Title>

## Status
Proposed

## Context
<What is the problem? What constraints exist?>

## Decision
<What we decided.>

## Consequences
<Easier: ... Harder: ... Committed to: ...>
```

### Brief frontmatter

```yaml
---
title: "Short descriptive name"
depends_on:
  - 01-types            # filename without .md; sets branch stacking order
acceptance_criteria:
  - type: none
    test: "run `npx pnpm build`"
    pass: "exit code 0, zero TypeScript errors"
    fail: "any build errors"
  - type: api
    test: "GET /pods/series/:id with a valid seriesId"
    pass: "200, body.pods is an array, body.tokenUsageSummary present"
    fail: "non-200 or missing fields"
  - type: web
    test: "navigate to /pods, click Series filter in sidebar"
    pass: "series count badge renders with correct number"
    fail: "no badge, wrong count, or JS error in console"
context_files:
  - specs/<feature>/contracts.md
handover_from:
  - 01-types            # agent reads specs/<feature>/handovers/01-types.md from stacked branch
---

Task instructions in plain prose. What to build, not how.
Constraints and non-goals. Exact file pointers.

Before finishing, run `/simplify` on all files you changed.
```

### Acceptance criteria types

| Type | Validated by | When to use |
|------|-------------|-------------|
| `none` | Code inspection, build, tests | Build passes, tests pass, column exists, function returns X |
| `api` | HTTP call against running daemon | Endpoint returns correct shape/status |
| `web` | Playwright browser (`validate_in_browser`) | UI element visible, interaction works |

**Infer the type** — don't ask unless genuinely ambiguous:
- Build/lint/test = `none`
- HTTP endpoint behavior = `api`
- UI element or interaction = `web`

**AC format rules:**
- `test`: a specific action ("run `npx pnpm build`", "GET /health", "click the Series filter")
- `pass`: observable success (exit code, HTTP status, UI element present)
- `fail`: observable failure (build error, non-200, element missing)
- No judgment calls — "looks correct" is not a pass condition
- Every brief must have at least one `none` AC gating on build + tests passing
- Every brief must have a `none` AC for `/simplify` passing (run it, address findings, build still passes)

---

## Handover guarantee

When this skill finishes, the output must be complete enough that:

- `ap series create specs/<feature>/briefs/` runs with zero clarifying questions
- Each pod agent executes its brief without asking the user anything
- A reviewer reading only `context.md` + one brief understands what that pod is doing and why

If any brief would require a human to explain something at runtime, the loop was not done.

---

## Anti-patterns

- Writing any output before the exit test passes
- Asking a question the codebase already answers
- Batching two questions in one turn
- Stopping the interview after 2–3 questions on a multi-module feature
  (e.g. "New scheduler UI" answered with "what screens?" + "what component
  library?" and then writing — that's a fail; you haven't pinned entities,
  state shape, interaction model, empty states, error states, or seams)
- Accepting vague nouns without pinning them ("the new scheduler backend" —
  which endpoints? which types? where do they live?)
- Rationalizing the exit test instead of running the coverage checklist
- Skipping the "ready to write — green light?" confirmation
- ACs that require human judgment ("looks good", "feels right")
- A brief touching > 8 files and not split
- Skipping ADRs for surprising decisions (next agent will make wrong assumptions)
- Mixing "what to build" with "how to build it" in the brief body

### Red-flag examples (what "not enough questions" looks like)

| User says | Bad (2 questions → write) | Good (keeps drilling) |
|-----------|--------------------------|----------------------|
| "New scheduler UI to match the new scheduler backend" | "What screens?" → "What library?" → write | + which endpoints/types exist? + what entities are scheduled? + list vs calendar view? + create/edit flows? + empty/error/loading states? + where does it live in nav? + reuse existing components or new? + what does "match the backend" mean — 1:1 fields, or curated? |
| "Add auth to the admin panel" | "SSO or password?" → "Which routes?" → write | + which identity provider? + session storage? + role model? + logout flow? + redirect behavior? + existing auth middleware to reuse? + tests seam? |
| "Refactor the pod manager" | "Split into what?" → "Keep the API?" → write | + what pain are we solving? + which seams are painful today? + what stays stable? + migration strategy? + test coverage before/after? + rollback plan? |

Rule of thumb: if you can summarize the feature in one sentence *after* the
interview and it sounds identical to the user's original prompt, you didn't
interview — you transcribed.

---

## Relationship to other skills

| Skill | Output | Use when |
|-------|--------|----------|
| `/prep` | single brief | 1 validation checkpoint, < 2 hrs |
| `/plan-feature` | `specs/<name>/briefs/` folder | 2+ checkpoints, 4+ hrs |
| `/exec` | working code | executing a spec suite locally (not via pods) |
| `ap series create` | running pods | executing the brief folder via autopod |
