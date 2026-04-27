---
name: plan-feature
description: >
  Decomposes a large feature into a series-ready spec folder for `ap series create`.
  Runs a continuous interview-plus-research loop with one question per turn,
  scanning the codebase between answers, until every coverage dimension is green.
  Then writes `specs/<name>/` with `purpose.md`, `design.md`, `briefs/`, and any
  new ADRs into the repo-level `docs/decisions/`.
  Use when the task spans 3+ modules or 4+ hours of work.
allowed-tools: Read, Grep, Glob, Bash, Write, Edit, Agent, AskUserQuestion
---

# /plan-feature

Turn a rough feature idea into a fully structured `specs/<name>/` folder that
`ap series create specs/<name>/` (or `ap series create specs/<name>/briefs/`)
can execute without any further clarification. Nothing is written until the
exit checklist is fully green and the user has confirmed.

## When to use

- Task touches 3+ modules or will take more than ~4 hours
- You need independent validation checkpoints between work phases
- You want the work split across parallel or sequential agent pods

If the task is clearly single-checkpoint (one module, a few files), recommend
`/prep` instead.

## How this works

A continuous interview-plus-research loop — not a fixed set of phases. The loop
runs until the exit test passes. Then and only then does it write output.

```
scan codebase → surface finding → ask ONE question → wait for answer →
scan codebase again → ask ONE question → wait → ... → exit test passes → write
```

### Rules (non-negotiable)

- **One question per turn. Full stop.** Never batch two questions.
- After every answer, search the codebase again before forming the next
  question. New answers open new search paths — always follow them.
- If the codebase already answers a question, don't ask — cite the finding
  and move on.
- Never draft `purpose.md`, `design.md`, briefs, or ADRs during the loop.
  Writing happens only after the exit test passes and the user has greenlit.
- **The coverage checklist is the only stop sign — not a question count.**
  A low question count is a symptom of skipping the interview, not a budget
  to spend.
- **Asymmetric signal:** if you're on question 3 of a 3+ module feature and
  feeling ready to write, you are almost certainly wrong — keep going. If
  you're on question 15 and the checklist is still red, keep going. There is
  no "enough" — only "checklist green, confirmed by user."
- **Bias toward more questions, not fewer.** Every ambiguous noun in the
  user's original prompt is a question waiting to happen. Pin them down one
  at a time.

### Opening move

Before asking anything, scan for 3–5 minutes:

1. What does existing code already handle in this area?
2. Where are the seams — places where one module hands off to another?
3. What shared types/interfaces cross module boundaries?
4. What's the test coverage like in the blast radius?
5. Are there existing ADRs in `docs/decisions/` (or `decisions/`,
   `docs/adrs/`) relevant here? Read every ADR before forming the first
   question — they are baseline knowledge.
6. Are there CLAUDE.md sections, READMEs, or pinned docs the executor will
   need? Note them; they go into `design.md` → Reference reading.

Present a 3–5 bullet summary of findings. Ask the first question. Stop.

### Asking questions: option-style vs prose

Use `AskUserQuestion` with mutually exclusive options + an automatic "Other
(specify)" fallback **when the realistic answer space is a small set of
discrete choices**:

- "Should events use SSE, WebSockets, or polling?"
- "Auto-merge on green, or human-gated approval?"
- "New top-level route or extend an existing one?"

Use **prose** when the answer is open-ended (a list, a name, a description, a
file pointer) — those are usually answered by the codebase anyway:

- "Which endpoints feed this view?"
- "What's the empty-state copy?"
- "What does 'match the backend' mean here?"

Anti-pattern: don't rephrase a prose question as fake options ("Which
endpoints feed this view? A) /api/orgs B) /api/users C) Other"). The planner
shouldn't be guessing the codebase's answer — search instead.

### What to clear during the loop (coverage dimensions)

Each scan+question round resolves one of these. Every dimension must end up
green (answered by user, answered by codebase, or explicit N/A with
justification) before writing.

1. **Problem framing** — What is broken or missing? Whose problem?
   → `purpose.md` → Problem
2. **Outcome** — One sentence, observable change after this ships.
   → `purpose.md` → Outcome
3. **Success signal** — How will we know it worked?
   → `purpose.md` → Success signal (must be tied to a brief AC, see #14)
4. **Users / actors** — Who is affected? Who benefits?
   → `purpose.md` → Users
5. **Non-goals** — Explicit fence. The most useful thing for keeping the
   executor from over-reaching.
   → `purpose.md` → Non-goals
6. **Glossary** — Every noun in the prompt that two readers might interpret
   differently. Every ambiguous noun gets pinned.
   → `purpose.md` → Glossary
7. **Reversibility** — Hard-to-reverse changes (DB migrations, public API
   changes, on-disk format, deletions)? Required only when applicable; if so,
   note the rollback strategy.
   → `purpose.md` → Reversibility (omit when fully reversible)
8. **Blast radius** — Files / modules touched. With paths, not gestures.
   → `design.md` → Blast radius
9. **Seams** — Where does one module hand off to the next? These are the
   pod boundaries.
   → `design.md` → Seams + briefs/ ordering
10. **Cross-pod contracts** — Types, interfaces, API shapes, DB columns that
    cross brief boundaries. Owner per contract.
    → `design.md` → Contracts
11. **UX flows** *(only when feature is user-facing)* — Entrypoint → states
    (loading / empty / error) → exits. Component list if a new screen.
    → `design.md` → UX flows
12. **Reference reading** — Existing ADRs, CLAUDE.md sections, READMEs, and
    code patterns the executor should consult. Capture what you read during
    the scan, not at write time.
    → `design.md` → Reference reading
13. **Pod sizing** — Is any brief's `Touches` list approaching 8 files? Then
    split. Rule of thumb: > 8 files = too big.
    → briefs/ structure
14. **Acceptance criteria** — Per brief, observable, no human judgment. The
    final brief (or one designated brief) MUST have an AC whose `pass`
    directly validates the success signal from #3 — otherwise the spec can
    finish "green" without shipping the actual outcome.
    → briefs/*.md frontmatter
15. **Hard-to-reverse decisions** — Anything surprising or with long-lived
    consequences. ADRs are written **per decision**, numbered globally in
    `docs/decisions/` (not per spec).
    → `docs/decisions/ADR-NNN-<slug>.md`

If any dimension is hand-waved ("probably fine", "we can figure it out",
"TBD"), that's red — ask another question.

### Per-turn discipline

After each user answer, before forming the next question:

1. **Name the dimensions touched.** Briefly note which previously-green
   dimensions this answer affects (often more than one). Re-validate them.
   If any are now red, mark them red and re-open them — do not let earlier
   coverage decay silently.
2. **Re-scan the codebase** for anything the new answer opens up.
3. Then form the next question.

#### When the user defers ("you decide" / "whatever you think")

Do **not** silently decide. Propose a specific answer with a one-line
rationale and ask for confirmation:

> "Defaulting to SSE because the existing event bus already streams over
> SSE in `event-bus.ts:42`. Confirm?"

If the user agrees, mark the dimension green and cite the proposal as the
answer. If they push back, treat their pushback as the new answer.

#### When the planner realizes "this is two features"

If the interview surfaces that the scope is genuinely two specs (two
separable outcomes, two independent success signals, no shared blast
radius), stop. Recommend splitting:

> "This looks like two features: (a) the events backend, (b) the events
> UI. They share no contracts and ship independently. I'd plan them as two
> specs. Continue with one of them, or stop and re-scope?"

Do not press on and produce an oversized spec to avoid the conversation.

### Handling genuinely unknown answers

Sometimes neither the user nor the codebase can answer a dimension. Distinguish:

- **Product / intent unknown** ("should it be SSO or password?", "should
  empty state show a CTA or stay blank?") — refuse to write. Ambiguity
  should never ship. Keep interviewing or escalate to a decision-maker.
- **Technical unknown** ("will this migration approach scale on the 50M-row
  table?", "does the ORM's bulk-insert support our type?") — make the
  first brief a **spike**: a research/exploration brief whose ACs are
  "produce a finding, commit it as a handover, gate the rest of the series
  on the finding." Subsequent briefs depend on it.

Ask explicitly when unsure: "is this a product unknown or a technical
unknown?"

### Exit test — the show-back

Before writing any output, produce a checklist covering all 15 dimensions
above. For each:

- ✅ Answered by the user (quote their answer, cite which question)
- 📂 Answered by the codebase (cite the file(s) and what they told you)
- ⚠️ Explicitly marked N/A with a one-line justification (e.g.
  "UX flows: N/A — feature is internal API only, no user-facing surface")

For every brief you're about to write, confirm you can name:

- The exact files it touches (the `touches` list)
- The files it must NOT touch (the `does_not_touch` list — both lists are
  advisory; reviewer adjudicates deviations)
- The interfaces it must respect (cite the contract section in design.md)
- The ACs it must satisfy (every brief has at least one `none` AC for
  build + tests passing)
- The dependency graph, without guessing

Verify the **outcome → AC link**: cite which brief's AC validates the
success signal in `purpose.md`. If you can't, the loop is not done.

**Show the checklist back to the user** with a clear "ready to write — green
light?" prompt. Do NOT start writing until the user confirms. This is the
only batched "question" allowed — it's a summary, not new interrogation.

If the user spots a gap, keep interviewing. Do not negotiate your way to
writing early.

---

## Output structure

```
specs/<feature-name>/
├── purpose.md       ← why, who, success signal, non-goals, glossary, reversibility
├── design.md        ← seams, contracts, UX flows, file map, reference reading, decisions list
├── briefs/
│   ├── 01-<verb>-<noun>.md
│   ├── 02-<verb>-<noun>.md
│   └── ...
└── handovers/       ← runtime artifact; pods write here, not /plan-feature

docs/decisions/      ← REPO-LEVEL, one file per ADR, numbered globally
├── ADR-001-<slug>.md
├── ADR-002-<slug>.md
└── ADR-NNN-<slug>.md
```

Run order: `ap series create specs/<feature-name>/` (or
`ap series create specs/<feature-name>/briefs/` — both work).

Both `purpose.md` and `design.md` are auto-loaded by the daemon and
rendered as `## Purpose` and `## Design` sections in every pod's CLAUDE.md.
Briefs do NOT need to list them via `context_files` — they're injected.

### purpose.md

Written for the agent (re-read every brief) and the future reviewer.
Daemon takes it verbatim as the PR "Why" section.

Required sections, in order:

```markdown
# <Feature name>

## Problem
One paragraph. The thing that is broken or missing today.

## Outcome
One sentence. The observable change after this feature ships.

## Users
Who is affected; who benefits. Useful when an agent has to pick between
two reasonable behaviours.

## Success signal
How we'll know it worked. Must be observable (a metric, a log line, a
screenshot, a passing test). At least one brief AC must directly validate
this — that linkage is part of the exit checklist.

## Non-goals
- Explicit fence item 1
- Explicit fence item 2
- ...

## Glossary
- **<Term>** — definition. Every noun in the feature description that two
  readers might interpret differently.

## Reversibility    ← OMIT this section when fully reversible
What back-out looks like if this lands and is wrong. Required when the
feature includes a hard-to-reverse change (DB migration, public API change,
on-disk format change, deletion of existing behavior).
```

Keep purpose.md tight — it's read by every brief-executing agent on every
pod. Density matters for THEIR reading load, not because of any PR-body
character limit.

### design.md

Written for the agent and the reviewer. Engineering reference.

Required sections, in order:

```markdown
# Design — <Feature name>

## Blast radius
Files / modules touched, with paths. The agent does not have to re-derive
this. Group by module if that aids reading.

## Seams
Where does one pod hand off to the next? Each seam is a brief boundary.
Name the seam, name the contract that crosses it, name which brief owns
each side.

## Contracts
Types, interfaces, API shapes, DB columns that more than one brief
produces or consumes. Owner per contract.

```ts
// Example contract block — copy what the agent will need to honor.
export interface PodEvent {
  podId: string;
  ts: string;
  kind: 'started' | 'finished' | 'failed';
}
```

## UX flows    ← OMIT when feature has no user-facing surface
Entrypoint → states → exits. Loading / empty / error states. Component list
if a new screen. Not mockups. One short flow per surface.

## Reference reading
Pointers into existing docs and code patterns the executor should consult
before starting. Captured during the planning scan, not regenerated at
write time. Each entry is a path + one line on why it matters.

- `packages/daemon/src/pods/event-bus.ts:42` — existing SSE plumbing this
  feature reuses.
- `docs/decisions/ADR-019-events-hmac.md` — events are HMAC-signed; new
  events must respect this.
- `CLAUDE.md` "Pod Lifecycle" section — state machine the new state
  transitions must fit into.

## Decisions
ADRs introduced or relied on by this feature. List IDs only — full text
lives in `docs/decisions/`.

- ADR-042: Use SSE not WebSockets for event stream (introduced)
- ADR-019: All events HMAC-signed (existing — events repo must respect)
```

### Repo-level `docs/decisions/`

ADRs are durable repo-wide artifacts. They live at `docs/decisions/` (or
`decisions/` / `docs/adrs/` — auto-detect the existing convention; default
to `docs/decisions/` when none exists). Numbered globally across the
codebase. Format:

```markdown
# ADR-NNN: <Title>

## Status
Proposed | Accepted | Superseded by ADR-MMM

## Context
What is the problem? What constraints exist?

## Decision
What we decided.

## Consequences
Easier: ...
Harder: ...
Committed to: ...
```

Only write an ADR for hard-to-reverse or surprising decisions — not for
every micro-choice. The existing `docs/decisions/` folder is read in the
opening scan so prior decisions inform every plan.

### briefs/ — per-pod tasks

Filenames: `NN-<verb>-<noun>.md` (e.g. `01-add-events-types.md`,
`02-wire-events-api.md`, `03-render-events-list.md`). Numeric prefix sets
default execution order; same number means the daemon may run them in
parallel.

#### Frontmatter (YAML)

```yaml
---
title: "Add events repository"
depends_on: [01-types]
acceptance_criteria:
  - { type: none, test: "npx pnpm build", pass: "exit 0", fail: "any TS error" }
  - { type: none, test: "npx pnpm test --filter @autopod/daemon", pass: "all tests pass", fail: "any failure" }
  - { type: api,  test: "GET /events?since=now", pass: "200, body.events array", fail: "non-200 or missing field" }
touches:
  - packages/daemon/src/pods/events-repository.ts
  - packages/daemon/src/db/migrations/    # directory shorthand — anything under here
does_not_touch:
  - packages/daemon/src/pods/pod-manager.ts
require_sidecars: [dagger]   # only when needed
---
```

Field rules:

- `title` — verb-led to match filename convention.
- `depends_on` — filenames or stems of earlier briefs.
- `acceptance_criteria` — at least one `none` AC must gate on build + tests
  passing. ACs are observable; "looks correct" is never a pass condition.
  Types: `none` (build/test/diff inspection), `api` (HTTP call), `web`
  (browser via `validate_in_browser`). Infer the type — only ask when
  genuinely ambiguous.
- `touches` / `does_not_touch` — **advisory, not enforced**. The reviewer
  flags deviations as discussion items, never as failures. Use directory
  shorthand (path ending in `/`) to mean "anything under this directory".
  Use explicit file paths otherwise — no globs.
- `require_sidecars` — only when a brief needs a specific sidecar.

#### Body

Required sections, in this order:

```markdown
## Task
What to build, in prose. *What*, not *how*.

## Touches
Same paths as the YAML `touches` list — repeat in prose so the agent reads
them in flow. (The YAML version is what the reviewer consumes.)

## Does not touch
Same paths as the YAML `does_not_touch` list — repeat for the same reason.

## Constraints
Patterns and rules from `design.md` this brief must honor. Quote 2–3
lines and link to design.md rather than restating.
```

Optional sections (include only when they add value):

```markdown
## Checkpoints
Fail-fast spine for larger briefs. Use only when the brief has natural
intermediate gates (e.g. types must compile before logic).

1. Types compile (`pnpm build` passes)
2. Logic implemented, types still compile
3. Tests added, full suite passes

## Risks / pitfalls
Things the planner suspects could go wrong. Migration prefix collisions,
known-fragile modules, race conditions, etc. Cite past landmines from the
codebase scan when relevant.

## Test expectations
Which test files to add and what they cover. Include only when
non-obvious from "Touches".
```

Required wrap-up section, always last:

```markdown
## Wrap-up
Before finishing:
1. Run `/simplify` and address its findings.
2. Re-run build and tests; both must still pass.
3. Commit and push.
```

`/simplify` is process, not an AC — that's why it's a wrap-up step. ACs
remain about observable outcomes only.

#### What briefs should NOT contain

- "Why" → already in `purpose.md` (auto-injected as `## Purpose`).
- Architecture, contracts, UX flows, reference reading → already in
  `design.md` (auto-injected as `## Design`).
- Full ADR text → cite the ADR ID; canonical text lives in
  `docs/decisions/`.
- Other briefs' work → that's what handovers are for.

### handovers/ — runtime, not authored

`/plan-feature` does NOT write any files in `handovers/`. The daemon's
system instructions tell each pod to read its parent(s)' handover files
from `specs/<feature>/handovers/<parentPodId>.md` before starting and to
write its own to `specs/<feature>/handovers/<thisPodId>.md` before
finishing. Filenames are pod-id-keyed, so parallel siblings produce
distinct files and the next pod reads each parent it depends on.

---

## Handover guarantee

When this skill finishes, the output must be complete enough that:

- `ap series create specs/<feature>/` runs with zero clarifying questions.
- Each pod agent executes its brief without asking the user anything.
- A reviewer reading only `purpose.md` plus one brief understands what
  that pod is doing and why.

If any brief would require a human to explain something at runtime, the
loop was not done.

---

## Anti-patterns

- Writing any output before the exit test passes.
- Asking a question the codebase already answers.
- Batching two questions in one turn.
- Stopping after 2–3 questions on a multi-module feature (e.g. "New
  scheduler UI" answered with "what screens?" + "what component library?"
  and then writing — that's a fail; you haven't pinned entities, state
  shape, interaction model, empty / error / loading states, success
  signal, or seams).
- Accepting vague nouns without pinning them in the glossary.
- Silently letting an earlier coverage dimension decay when a later answer
  contradicts it.
- Silently deciding when the user defers — always propose-and-confirm.
- Producing one oversized spec when the scope is genuinely two specs.
- Skipping the "ready to write — green light?" confirmation.
- ACs that require human judgment ("looks good", "feels right").
- A brief whose `touches` list exceeds 8 files and not splitting it.
- Writing ADRs in `specs/<feature>/decisions/` instead of repo-level
  `docs/decisions/` — they belong in the durable, globally-numbered home.
- Listing `purpose.md` or `design.md` in `context_files` — they're
  auto-injected; doing so is redundant.
- Skipping ADRs for surprising decisions (the next agent will make wrong
  assumptions).
- Mixing "what to build" with "how to build it" in the brief body.
- Forgetting to tie the success signal to a specific brief AC.

### Red-flag examples (what "not enough questions" looks like)

| User says | Bad (2 questions → write) | Good (keeps drilling) |
|-----------|--------------------------|----------------------|
| "New scheduler UI to match the new scheduler backend" | "What screens?" → "What library?" → write | + which endpoints/types exist? + what entities are scheduled? + list vs calendar view? + create/edit flows? + empty/error/loading states? + where does it live in nav? + reuse existing components or new? + what does "match the backend" mean — 1:1 fields, or curated? + success signal? |
| "Add auth to the admin panel" | "SSO or password?" → "Which routes?" → write | + which identity provider? + session storage? + role model? + logout flow? + redirect behavior? + existing auth middleware to reuse? + tests seam? + success signal? |
| "Refactor the pod manager" | "Split into what?" → "Keep the API?" → write | + what pain are we solving? + which seams are painful today? + what stays stable? + migration strategy? + test coverage before/after? + rollback plan (Reversibility)? + success signal? |

Rule of thumb: if you can summarize the feature in one sentence *after*
the interview and it sounds identical to the user's original prompt, you
didn't interview — you transcribed.

---

## Relationship to other skills

| Skill | Output | Use when |
|-------|--------|----------|
| `/prep` | single brief | 1 validation checkpoint, < 2 hrs |
| `/plan-feature` | `specs/<name>/` folder + ADRs in `docs/decisions/` | 2+ checkpoints, 4+ hrs |
| `/exec` | working code | executing a spec suite locally (not via pods) |
| `ap series create` | running pods | executing the spec via autopod |

