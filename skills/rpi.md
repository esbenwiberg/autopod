---
name: rpi
description: >
  HumanLayer-inspired Research / Plan / Implement workflow for turning a task,
  ticket, or rough feature request into Autopod-compatible handoff artifacts.
  Use when the user wants an RPI-style workflow, HumanLayer-style staged
  research-plan-implement, or a research-first implementation handoff that
  defaults to one executor pod. Only split into multiple Autopod briefs when a
  real handoff, dependency gate, or blast-radius reason requires it.
allowed-tools: Read, Grep, Glob, Bash, Write, Edit, Agent, AskUserQuestion
---

# /rpi

Turn a rough task into a researched, reviewed, Autopod-ready implementation
handoff using the HumanLayer RPI rhythm:

```
research codebase -> plan with the human -> implement from approved handoff
```

This is **not** another `/plan-feature`. Use `/plan-feature` only as a reference
for the current Autopod file/schema requirements. Do not import its 15-dimension
coverage matrix, HTML show-back, ADR machinery, or default multi-brief shape.
RPI phases are review artifacts and brief checkpoints by default, **not pod
boundaries**. Split into a series only when the work genuinely needs separate
execution checkpoints.

## Lineage

This adapts HumanLayer's public workflow shape:

- RPI Guided: research-plan-implement.
- RPI Outline: skip detailed planning when a human-supplied outline is already
  good enough.
- QRSPI: Questions, Research, Design, Structure, Plan, Implement. Borrow the
  "questions before code" and "structure before implementation" checkpoints
  only when useful; do not inflate RPI into QRSPI unless the task demands it.
- Their open-source command set follows `/research_codebase`, `/create_plan`,
  `/implement_plan`: research documents what exists, planning is skeptical and
  interactive, and implementation follows an approved plan while pausing on
  mismatches.

## When to use

Use `/rpi` when:

- The user wants the HumanLayer RPI flow or says "research, plan, implement".
- A task deserves research and a plan before code, but usually one executor pod
  can perform it.
- The user wants Autopod compatibility without a formal feature-planning
  process.
- You need reviewable artifacts before implementation: `research.md`, `plan.md`,
  `brief.md`, and `contract.yaml`.

Route elsewhere when:

| Instead | Use when |
|---|---|
| `/prep` | The task is already small and clear; no separate research/plan artifacts needed. |
| `/plan-feature` | The user explicitly wants formal multi-pod feature planning, ADRs, or an architectural design package. |
| Fix directly | The bug/fix is obvious and the user asked for implementation, not planning. |
| `/investigate-bug` | The symptom/root cause is unknown and diagnosis is the main work. |

## Hard rules

- Scan before asking. If the codebase answers a question, cite it and move on.
- Read directly mentioned files fully before decomposing or delegating.
- Keep research descriptive: what exists, where, how it connects. Put judgement
  and recommendations in the plan, not in research.
- Do not write implementation code during Research or Plan.
- Do not split plan phases into pods by default. Use `## Checkpoints` inside a
  single `brief.md` unless a series trigger fires.
- Do not use `/plan-feature`'s interview matrix, HTML preview, or ADR gates for
  ordinary RPI work.
- Do not write final `specs/<slug>/` output until the plan and Autopod handoff
  are greenlit.
- Maintain a transient ledger at `.autopod/review/rpi/<slug>/state.md` for
  compaction recovery. This ledger is not a deliverable spec.
- Required facts are durable proof artifacts. Do not list broad build/test/lint
  commands as required facts.
- Facts must discriminate. Every required fact must fail against the obvious
  broken implementation. A fact that passes on broken, empty, or unchanged
  output is not a fact. For any feature whose value is *differentiation*
  (compare, diff, ranking, per-entity, before/after), at least one fact must
  assert that **different inputs produce different outputs** — not merely that
  output renders.
- Prove the default/fixture state, not just the configured happy path. If the
  feature renders against dev fixtures whose data shape differs from production
  (different ids, logical names, or seed config), add a fact that the
  **default/fixture state shows live behavior, not a degraded fallback**. A
  mockup or success-signal that assumes fully-configured data will hide a dead
  default state.
- Capture design artifacts. If the task references a mockup, screenshot, design
  doc, or artifact URL, record the link verbatim in `research.md` and
  `brief.md` so the executor and reviewer can compare the build against it. A
  static artifact pins layout intent only — it never substitutes for a
  discriminating fact.

## Runtime ledger

RPI often spans enough turns that context compaction can erase important
working memory. Persist runtime state in:

```
.autopod/review/rpi/<slug>/state.md
```

Create or update the ledger:

1. After the opening scan.
2. After every user answer.
3. After each research pass.
4. After each plan revision or approval.
5. Before writing final spec files.
6. Before stopping for user review or implementation handoff.

The ledger must include:

- Slug/title, current phase (`research`, `plan`, `handoff`, `implement`), and
  last-updated timestamp.
- Original task/ticket summary and directly read source files.
- User answers, approvals, and rejected options.
- Research findings with paths and short notes.
- Open questions and the reason each is still open.
- Approved plan outline, checkpoints, and non-goals.
- Candidate `touches` / `does_not_touch` paths.
- Candidate scenarios, required facts, and weak-proof risks.
- Whether the output is expected to be a single pod or a rare series, with the
  reason if series is chosen.
- Next action and why it is next.

Do not store secrets, credentials, huge logs, full source files, or draft final
spec files in the ledger. Store citations and compact summaries. On a resumed
turn, read the ledger before scanning or asking another question.

After final spec files are written and `ap spec check specs/<slug>/` passes,
remove `.autopod/review/rpi/<slug>/state.md` (and the empty slug directory if
applicable). The durable record is now `specs/<slug>/`; the ledger was only a
runtime recovery aid.

## Workflow

### 0. Opening move

Before asking anything:

1. Derive a provisional kebab-case slug from the task.
2. Look for `.autopod/review/rpi/<slug>/state.md`; read it if present.
3. Read any mentioned ticket, issue, doc, JSON, screenshot notes, or spec file
   fully. If the task references a mockup, screenshot, or artifact URL, open it
   (WebFetch for artifact URLs) and record the link verbatim for later capture
   in `research.md` and `brief.md`.
4. Scan code, tests, docs, ADRs, conventions, and existing skills relevant to
   the task.
5. Identify the likely blast radius, existing patterns, test surface, and any
   obvious non-goals.
6. Update the ledger with findings, open questions, candidate files, and the
   current R/P/I phase.
7. Present a concise research-start summary and ask only questions the scan
   cannot answer.

If the user gave no task at all, ask for the task/ticket first.

### 1. Research

Goal: build a factual map of the current system.

Research should answer:

- What currently exists?
- Which files/modules participate?
- How does data/control flow between them?
- Which tests already cover the area?
- Which patterns should a future implementation mimic?
- Which constraints come from docs, ADRs, conventions, or repo instructions?
- What is genuinely unknown after code search?

Use parallel subagents when available and useful:

- Locator: find relevant files and tests.
- Analyzer: explain how specific code works.
- Pattern finder: find similar implemented features.
- Web researcher: only when the user asks for web research or the task depends
  on external APIs/libraries whose current behavior matters.

The main agent must verify the important findings by reading the relevant files
itself before planning.

Do not recommend changes in the research section. A good research summary sounds
like documentation, not a proposal.

### 2. Plan

Goal: choose the smallest coherent implementation approach.

After research:

1. State the current understanding in 3-6 bullets with file/path evidence.
2. Ask for clarification only on unresolved product intent, tradeoffs, or
   external facts the repo cannot answer.
3. If there are real design choices, present 2-3 options with tradeoffs and ask
   the user to choose or approve the default.
4. For user-facing UI, draw a small ASCII wireframe before approval when layout
   or states are changing. Ask "Does this match?" after showing the proposal.
   If a design artifact/mockup exists, cite its link beside the wireframe — the
   artifact is the reference, the wireframe is your reconciliation of it with
   the codebase.
5. When reusing an existing computation, view, or behavior ("mirror X
   exactly"), name the inputs the new feature adds that X does *not* model, and
   say how they are reconciled. A reuse instruction that skips this silently
   ships X's behavior, not the new feature's.
6. Produce a plan outline:
   - Overview
   - Desired end state
   - What we are not doing
   - Implementation approach
   - Checkpoints
   - Test strategy — for each core behavior, name the discriminating fact: what
     input variation must change the output, and what the broken implementation
     would produce. Include a default/fixture-state check where the fixture
     differs from production data.
   - Risks / pitfalls
7. Ask for explicit plan approval before writing final spec files.

RPI Outline mode: if the user provides an already-approved outline and asks to
skip planning, verify the outline against the codebase, fill only missing
Autopod proof details, then proceed to handoff. Do not re-litigate settled
intent unless the code contradicts it.

### 3. Autopod handoff

Default to a single-pod spec:

```
specs/<slug>/
├── research.md
├── plan.md
├── brief.md
└── contract.yaml
```

`research.md` and `plan.md` are review artifacts and reference material.
`brief.md` and `contract.yaml` are the executable Autopod handoff. The brief
must contain enough context that the pod does not need to ask follow-up
questions even if it never opens the research/plan artifacts.

When launching from an RPI spec, recommend:

```bash
ap pod create <profile> --spec specs/<slug> --include-specs
```

`--include-specs` commits every file under `specs/<slug>/` onto the pod branch
before the agent starts, including `research.md` and `plan.md`. Still keep the
brief self-contained, and add an explicit instruction in `## Research summary`
or `## Plan` to read those two files before coding when they are present.

Collision rule: if `specs/<slug>/` already exists, stop and ask for a new slug.
Never auto-append a suffix.

#### Single-pod brief.md

Use this frontmatter:

```yaml
---
title: "Verb-led title matching the task"
touches:
  - path/to/file.ts
does_not_touch:
  - path/to/adjacent-file.ts
require_sidecars: []
---
```

Field rules:

- `title`: verb-led and specific.
- `touches`: exact files or directory shorthand ending in `/`.
- `does_not_touch`: adjacent paths that are tempting but out of scope.
- `require_sidecars`: omit or use `[]` unless a known sidecar is required.

Body sections, in order:

```markdown
## Task
What to build. What, not full source code.

## Why
Compressed motivation and desired outcome.

## Research summary
The current-state facts the executor needs, with paths.

## Artifacts
Links to any mockup, screenshot, or design artifact the build must match
(verbatim URLs). Note that the artifact pins layout/intent only — correctness
is proven by the contract facts, not by matching the picture. Omit if none.

## Plan
The approved approach.

## Checkpoints
Numbered implementation checkpoints. These are not separate pods unless a
series trigger fires.

## Touches
Repeat the YAML paths in prose.

## Does not touch
Repeat the YAML paths in prose.

## Constraints
Repo rules, ADRs, conventions, gotchas, and user-approved non-goals.

## Skills to reference
Any skills the executor should use, with one-line reasons. Omit if none.

## Test expectations
Named test files or proof artifacts to create/update and what each covers.

## Risks / pitfalls
Only when useful.

## Wrap-up
Before finishing:
1. Run the profile finish prompt if one is configured.
2. Re-run build and tests; both must still pass.
3. Commit and push.
```

#### Single-pod contract.yaml

Use this parser-compatible schema:

```yaml
contract_version: 1
title: "Verb-led title matching the task"
depends_on: []
scenarios:
  - id: main-behavior
    given:
      - "the relevant existing state"
    when:
      - "the user or system action happens"
    then:
      - "the observable behavior changes"
required_facts:
  - id: fact-main-behavior
    proves: [main-behavior]
    kind: unit-test
    artifact:
      path: path/to/test-file.test.ts
      change: create
    command: npm test -- test-file.test.ts
human_review: []
```

Rules:

- `contract_version` is number `1`, not string `"1"`.
- `scenarios` is required; each scenario has `id`, `given`, `when`, and `then`.
- Every `required_facts[].proves` value exactly matches a scenario id.
- `artifact` is an object with `path` and `change`.
- `artifact.change` is one of `create`, `update`, `touch`.
- `kind` is one of `unit-test`, `integration-test`, `contract-test`,
  `browser-test`, `typecheck`, `lint-rule`, `smoke-script`, `custom-command`.
- Web-visible outcomes need at least one `browser-test` fact when the repo has
  a runnable web UI and authentication can be handled.
- Use `human_review` only for judgment that honestly cannot become an
  executable fact. Always include it, even as `human_review: []`.
- Required facts must be narrow durable proof artifacts. The broad pipeline can
  still run build/test/lint, but those broad commands are not facts.
- Facts must discriminate (see Hard rules). Write each `then` so it is false
  under the obvious broken implementation. Banned for a feature's core
  behavior: shape-only assertions like "renders N rows", "markers ≥ 0", or
  "0-or-≥N markers" — these pass on empty/broken output.
  - Weak: "each scenario reports feasibility independently" → passes
    structurally even if every scenario shows identical numbers.
  - Strong: "two scenarios differing only in shortlist produce **different**
    peak utilization" → fails the moment the compute ignores the shortlist.
- For features that render against dev fixtures, add a fact that the
  **default/fixture state shows live behavior**, not the degraded fallback
  (e.g. "with the fixture's own metric keys, the scatter renders ≥2 markers" —
  not "0 markers is acceptable").

Before `ap spec check`, run the fact-strength pass: for every required fact,
state the obvious broken implementation in one line and confirm the fact would
fail against it. If a fact survives the broken version, it is not yet a fact —
rewrite it.

After writing the files, run:

```bash
ap spec check specs/<slug>/
```

Repair parser errors before finishing.

### 4. Series escape hatch

Split into multiple briefs only when one of these is true:

- One brief would touch more than about 8 files.
- A technical spike must produce a finding before implementation can be scoped.
- A migration, public API, protocol, or on-disk format change must land before
  dependent work.
- Two pieces can run independently and have no shared mutable files.
- There is a real handoff contract between modules that must be owned by one
  brief and consumed by another.
- The user explicitly asks for separate Autopod checkpoints.

Do **not** split because the plan has Phase 1/2/3. Phases usually become
`## Checkpoints` inside one brief.

If a series trigger fires, consult the local `/plan-feature` skill only for the
Autopod series schema that `ap spec check` currently expects. Keep the RPI
workflow intact:

- `research.md` remains the factual current-state map.
- `plan.md` remains the approved implementation plan.
- Each Autopod brief is a minimal executor handoff.
- The brief count stays as small as possible.
- ADRs are not part of RPI unless the user explicitly asks or the codebase
  already requires one for the change.

Run `ap spec check specs/<slug>/` before finishing.

### 5. Implement

If the user asked only for RPI planning, stop after the spec passes validation
and tell them the run command:

- Single pod: `ap pod create <profile> --spec specs/<slug> --include-specs`
- Series: `ap series create specs/<slug> --profile <profile> --include-specs`

If the user explicitly asked to continue through implementation:

1. Read `research.md`, `plan.md`, `brief.md`, and `contract.yaml` fully.
2. Implement checkpoint by checkpoint.
3. If reality contradicts the approved plan, stop and present:
   - Expected
   - Found
   - Why it matters
   - Proposed adjustment
4. Run each required fact command and the repo's normal validation.
5. Do not mark human-review items complete without user confirmation.

## Handover guarantee

When `/rpi` finishes planning:

- `ap spec check specs/<slug>/` passes.
- `ap pod create --spec specs/<slug>/` or `ap series create specs/<slug>/`
  can run without clarifying questions.
- A pod agent reading only the brief has enough context to execute.
- A human reviewer can inspect `research.md` and `plan.md` to see how the
  implementation handoff was derived.

## Anti-patterns

- Turning every plan phase into a separate pod.
- Asking "what files should I change?" before searching.
- Putting recommendations in `research.md`.
- Writing final spec files before plan approval.
- Leaving open questions in `plan.md`.
- Using generic `npm test`, `pnpm build`, `make test`, `cargo test`, or
  `dotnet test` as required facts.
- Creating weak facts that would pass if the feature were broken, empty, or
  unchanged — especially shape-only assertions ("renders rows", "0-or-≥N
  markers") for a feature whose value is differentiation.
- Accepting the degraded/fallback state as a passing fact (e.g. a contract that
  treats an empty chart or a "tied" verdict as acceptable).
- Telling the executor to "mirror existing behavior X" without naming what the
  new feature adds that X does not model — it ships X, not the new feature.
- Treating a mockup/artifact as proof of correctness. It pins layout; it hides
  default-state and differentiation bugs because it shows only the happy path.
- Writing code snippets so detailed that the brief becomes pre-written source.
- Creating ADRs or a multi-brief series for ordinary implementation choices.
- Skipping the Autopod parser check.
