---
name: prep
description: >
  Plans a single-pod task by interviewing the user one question per turn,
  scanning the codebase between answers, until contract scenarios, required
  facts, skill references, and context+non-goals are all green. Then writes
  one autopod-compatible spec folder with `brief.md` and `contract.yaml`. Use when the work
  fits one pod (single concern, one or two packages, no architectural
  decisions). For 3+ modules or new contracts, use `/plan-feature` instead.
allowed-tools: Read, Grep, Glob, Bash, Write, Edit, AskUserQuestion
---

# /prep

Turn a rough single-pod task into one autopod-compatible spec folder at
`specs/<task>/` with `brief.md` and `contract.yaml`. The brief carries task
context; the contract carries scenarios and durable required facts, so
`ap pod create --spec specs/<task>/` runs it without further clarification.

Nothing is written until the coverage checklist is green and the user has
greenlit.

## When to use

- Task fits one pod: single concern, one or two packages, no new contracts
  between modules.
- The "what" is clear-ish; the "exactly which files / which checks" still
  needs grounding.
- You're about to spawn a single autopod and want a brief plus executable
  contract, not a paragraph of vibes.

If the task touches **3+ modules**, introduces **new contracts** between
packages, or needs **ADRs**, use `/plan-feature` instead. If you start `/prep`
and the scan or the answers reveal one of those, see *Upgrade in place* below.

## How this works

Same engine as `/plan-feature` — a continuous interview-plus-research loop
with one question per turn, just with a smaller coverage matrix and a single
brief output.

```
scan codebase → surface finding → ask ONE question → wait for answer →
scan codebase again → ask ONE question → wait → ... → coverage green → write
```

### Rules (non-negotiable)

- **One question per turn. Full stop.** Never batch two questions.
- After every answer, search the codebase again before forming the next
  question. New answers open new search paths.
- If the codebase already answers a question, don't ask — cite the finding
  (e.g. `📋 packages/daemon/src/pods/state-machine.ts:42`) and move on.
- Never draft the brief during the loop. Writing happens only after coverage
  is green and the user has greenlit.
- **The coverage checklist is the only stop sign — not a question count.**
- **Bias toward more questions, not fewer.** Every ambiguous noun in the
  user's prompt is a question waiting to happen.

### Opening move

Before asking anything, scan for 1–2 minutes:

1. What does existing code in this area already handle?
2. Which files would this task plausibly touch?
3. Are there obvious skill matches (`/add-profile-field`, `/add-pod-state`,
   etc.) based on the files in scope?
4. Does the scan suggest 3+ packages? If so, this is a `/plan-feature` task —
   raise it now (see *Upgrade in place*).

Then surface what you found in 3–6 bullets and ask the first question.

### Coverage matrix (the only stop sign)

The brief is held until **all four** dimensions are green. The task statement
itself is implicit from the user's prompt — don't re-ask it, just confirm
your understanding inline.

1. **Contract** — concrete scenarios plus required facts in
   `contract.yaml`. A scenario describes behavior in Given/When/Then form.
   A required fact names the durable artifact that must be created/updated and
   the narrow command the validator will run after the agent finishes.

   **Core principle: a required fact survives merge.** It must be a test,
   contract test, type-level check, fixture, smoke script, or equivalent repo
   artifact that future CI can keep running. Do not use generic pipeline
   commands (`pnpm test`, `pnpm build`, `npx pnpm lint`) as facts; facts prove
   specific behavior, while the pipeline proves the repo still builds.

   Use `human_review` only for judgement that cannot honestly become a command
   yet, and keep it narrow.

2. **Skill references** — auto-detect from the files in scope and **ask the
   user to confirm** before writing.

   Detection table (extend this as new skills appear):

   | File pattern in `touches`                             | Suggest        |
   |-------------------------------------------------------|----------------|
   | `packages/shared/src/types/profile.ts`                | `/add-profile-field` |
   | `packages/shared/src/types/pod.ts` (PodStatus)        | `/add-pod-state` |
   | `packages/daemon/src/pods/state-machine.ts`           | `/add-pod-state` |

   Confirmation question shape: *"This touches `profile.ts` — `/add-profile-field`
   walks the 11 layers a profile field needs. Reference it in the brief?"*
   Mark green only after the user confirms (or explicitly waves it off).

3. **Non-obvious context + non-goals** — the gotchas, constraints, and prior
   decisions the agent won't grep its way to, plus explicit out-of-scope
   fences. The guardrails. Examples:

   - Migration prefix collision danger (AGENTS.md note about
     `migration-prefix-check.sh`).
   - "This used to be done in pod-manager but moved to event-bus in the
     last refactor — don't follow stale grep hits."
   - Non-goals: "Don't refactor the surrounding profile-store class — out of
     scope, separate ticket."

4. **Touches / does-not-touch** — exact file paths the brief will modify
   (`touches`) and adjacent paths the agent must NOT edit (`does_not_touch`).
   This anchors blast radius. Directory-shorthand (`path/`) is fine for
   "anything under here" cases. **Advisory, not enforced** — the reviewer
   flags deviations as discussion items.

If any dimension is hand-waved ("probably fine", "we can figure it out",
"TBD"), it's red — ask another question.

### Per-turn discipline

After each user answer, before forming the next question:

1. **Name the dimensions touched.** Briefly note which previously-green
   dimensions this answer affects. Re-validate them. If any are now red,
   mark them red and re-open them — do not let earlier coverage decay
   silently.
2. **Re-scan the codebase** for anything the new answer opens up.
3. Then form the next question.

#### When the user defers ("you decide" / "whatever you think")

Do **not** silently decide. Propose a specific answer with a one-line
rationale and ask for confirmation:

> "Defaulting to required fact `fact-old-emitter-removed` with command
> `test -z "$(rg -l 'OldEmitter' packages/daemon/src)"` because we're removing
> the symbol entirely. Confirm?"

If the user agrees, mark the dimension green and cite the proposal as the
answer. If they push back, treat their pushback as the new answer.

### Upgrade in place

If during the loop you see signals that this is bigger than one pod, **stop
and offer to switch to `/plan-feature`**, carrying the answers gathered so
far. The two triggers:

1. **Module count** — codebase scan or user's answer reveals 3+ packages
   need to change.
2. **Architectural smell** — answers introduce new types/interfaces that
   cross package boundaries, schema changes with rollout questions, or
   "we need to decide between X and Y" choices that warrant an ADR.

Either trigger fires the offer:

> "This is shaping up bigger than a single brief: it touches `packages/shared`,
> `packages/daemon`, and `packages/desktop`, and we still need to decide the
> wire format. That's `/plan-feature` territory. Want to upgrade — I'll carry
> the answers we've gathered into the bigger coverage matrix?"

If the user agrees, hand off to `/plan-feature` with the answers as a head
start. If they decline, keep going in `/prep` but note the risk in the
brief's "Risks / pitfalls" section.

### Handling genuinely unknown answers

- **Product / intent unknown** ("should this validate strictly or be
  permissive?") — refuse to write. Keep interviewing.
- **Technical unknown** ("will this query plan be fast enough?") — write
  the brief with a `Risks / pitfalls` note and a fallback in case the
  unknown materializes badly.

### Exit test (before writing)

Both must be true:

1. All four coverage dimensions green.
2. User has confirmed: *"Coverage looks complete — should I write the brief?"*
   — explicit yes, not silence.

Only then proceed to write.

---

## Output structure

```
specs/<task-slug>/
├── brief.md
└── contract.yaml
```

`<task-slug>` is short kebab-case derived from the task (e.g.
`specs/add-pod-tags/brief.md`, `specs/fix-validator-timeout/brief.md`).

**Collision rule**: if `specs/<task-slug>/` already exists when you're about
to write, **refuse and ask for a new slug**. Never overwrite. Don't
auto-append a suffix — the user gets to name their work.

If the existing folder was produced by `/plan-feature` (has `purpose.md` /
`design.md` / `briefs/`), say so explicitly so the user understands it's not
just a stale `/prep` artifact.

### brief.md

Brief frontmatter carries scope only. Do not write `acceptance_criteria`;
contract behavior lives in `contract.yaml`.

#### Frontmatter

```yaml
---
title: "Verb-led title matching the task"
touches:
  - packages/daemon/src/pods/foo-repository.ts
  - packages/daemon/src/db/migrations/    # directory shorthand — anything under here
does_not_touch:
  - packages/daemon/src/pods/pod-manager.ts
require_sidecars: [dagger]   # only when needed
---
```

Field rules:

- `title` — verb-led to match the filename / task slug.
- `touches` / `does_not_touch` — advisory, not enforced. Directory shorthand
  (path ending in `/`) means "anything under this directory". Use explicit
  file paths otherwise — no globs.
- `require_sidecars` — only when a brief needs a specific sidecar.

Note: no `depends_on` field. `/prep` produces a single brief; series
ordering is `/plan-feature`'s job.

### contract.yaml

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
      path: packages/example/src/example.test.ts
      change: create
    command: npx pnpm --filter @autopod/example test -- example.test.ts
human_review: []
```

Allowed `kind` values: `unit-test`, `integration-test`, `contract-test`,
`browser-test`, `typecheck`, `lint-rule`, `smoke-script`, `custom-command`.
Allowed `artifact.change` values: `create`, `update`, `touch`. Use only those
exact values; never use `edit`, `modify`, or `write`.
For web-visible behavior, prefer `browser-test` with a durable Playwright or
equivalent browser test artifact. The worker creates/updates the proof artifact;
Autopod runs the command and writes attempt-scoped `evidence.yaml`. Never ask the
worker to author evidence directly.
Browser/report facts may write attachments under
`.autopod/evidence/<fact-id>/`; Autopod records those paths as screenshots,
traces, videos, reports, logs, or generic artifacts in `evidence.yaml`.

#### Body

Required sections, in this order:

```markdown
## Task
What to build, in prose. *What*, not *how*. Two or three sentences.

## Why
Two or three sentences on the motivation — the user's `purpose.md` lives
here in compressed form, since `/prep` doesn't generate a separate
purpose.md file.

## Touches
Same paths as the YAML `touches` list — repeat in prose so the agent reads
them in flow.

## Does not touch
Same paths as the YAML `does_not_touch` list — repeat for the same reason.

## Constraints
The non-obvious context and gotchas captured during the interview. Quote
2–3 lines from AGENTS.md / ADRs / code where relevant; don't restate the
whole document.

## Skills to reference
The skills the user confirmed during the interview. Each as a one-liner
naming the skill and why it applies. Example:

- `/add-profile-field` — this brief adds a new field to `Profile`; the skill
  enumerates the 11 layers (shared types, daemon migration, profile-store,
  validator, 6 desktop layers, CLI).

## Test expectations
Which test files to add and what each covers, per behaviour (happy path,
edge cases, error paths). Required for any brief that adds new code — this
supports the required facts and keeps the proof artifact meaningful. Skip
only when the brief is pure config / docs / dependency bumps with no logic
to test.
```

Optional sections (include only when they add value):

```markdown
## Risks / pitfalls
Things you suspect could go wrong. Migration prefix collisions, known-fragile
modules, race conditions, etc. Cite past landmines from the codebase scan
when relevant. Also: any unknowns the user explicitly accepted instead of
upgrading to `/plan-feature`.
```

Required wrap-up section, always last:

```markdown
## Wrap-up
Before finishing:
1. Run `/simplify` and address its findings.
2. Re-run build and tests; both must still pass.
3. Commit and push.
```

`/simplify` is process, not a required fact — that's why it's a wrap-up step.
Required facts remain about observable outcomes only.

#### What briefs should NOT contain

- "Files I'll create with full source" — the brief specifies *what* and
  *where*, not pre-written code.
- Generic build/test/lint commands as required facts — the pipeline runs them
  anyway. Facts prove specific behavior.
- ADR-length text — `/prep` briefs don't generate ADRs. If a decision feels
  ADR-worthy, that's an *Upgrade in place* signal.

---

## Handover guarantee

When this skill finishes, the output must be complete enough that:

- `ap pod create specs/<task>/brief.md` runs without clarifying questions.
- The pod agent executes the brief without asking the user anything.
- A reviewer reading only the brief understands what's being changed and why.

If the agent would need a human to explain something at runtime, the loop
was not done.

---

## Anti-patterns

- Writing the brief before the coverage checklist is green.
- Writing the brief before the user has explicitly greenlit ("yes, write it").
- Asking a question the codebase already answers — cite and move on.
- Batching two questions in one turn.
- Stopping after 2–3 questions on a layered task. If the change touches a
  Profile field and you wrote the brief without confirming all 11 layers
  via `/add-profile-field`, you skipped the loop.
- Producing a `/prep` brief when the answers revealed it should be
  `/plan-feature`. The *Upgrade in place* offer is mandatory when the
  triggers fire — not optional.
- Auto-appending a suffix when `specs/<task-slug>/` exists. Refuse and ask.
- Writing generic build/test/lint as required facts.
- Creating `human_review` entries for checks that could be executable facts.
- Writing command facts against surfaces the harness cannot authenticate;
  use a lower-level unit/integration/contract test artifact.
- Treating the user's first concrete answer as a green light to draft.
  Each answer is a thread to pull, not a stop signal.
- Silently deciding when the user defers — always propose-and-confirm.
- Skipping skill auto-detection because "the agent will figure it out".
  Pods often miss the right skill at runtime; the brief is where you
  point them at it.
