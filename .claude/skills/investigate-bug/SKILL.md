---
name: investigate-bug
description: Diagnose non-trivial Autopod bugs through a short scan-and-interview loop, then write a fix-ready investigation with `bug.md` and `contract.yaml`. Use when something is broken, the root cause or blast radius is not yet obvious, or a fix pod needs repro steps, root cause, and durable required facts before implementation. If the bug is obvious and trivial, fix it directly.
---

# /investigate-bug

Turn a bug report into `investigations/<slug>/bug.md` plus `contract.yaml`.
The bug doc carries symptom, root cause, blast radius, and fix hypothesis. The
contract carries scenarios and durable required facts so the eventual fix can be
validated like a `/prep` task.

Nothing is written until all coverage dimensions are green and the user has
greenlit.

## When to Use

- Something is broken and root cause is not yet pinned.
- Repro, regression point, or blast radius needs codebase archaeology.
- A fix pod needs an investigation handoff before implementation.

If the bug location and fix are obvious, fix it directly.

## How This Works

Scan first, ask only what the codebase cannot answer, then write once the
diagnosis and fix contract are both green.

```
scan codebase -> surface finding -> ask ONE question -> wait ->
scan again -> ask ONE question -> wait -> ... -> coverage green -> write
```

### Rules

- Ask one question per turn. Full stop.
- Scan the codebase before asking anything. If code, git history, ADRs,
  conventions, or memory answer a dimension, cite the source and do not ask.
- After every answer, grep/blame/log-search again before forming the next
  question.
- Prefer `git log --oneline -20 -- <file>` and `git blame` over guesses about
  when something broke.
- Never draft files during the loop. Write only after all dimensions are green
  and the user confirms.

### Opening Move

Before asking anything, scan for 2-3 minutes:

1. Grep for the error message, symptom string, route, type, or UI label.
2. Identify likely modules and exact files involved.
3. Check recent commits touching those files.
4. Find existing tests and validation scripts in the blast radius.
5. Search `docs/decisions/index.md`, `docs/conventions/index.md`, and approved
   memories via `memory_search`/`memory_list` when those tools are available.
6. Check for TODOs, FIXMEs, or fragile comments in the likely fault path.

Present a 2-4 bullet summary of findings and ask the first question.

## Coverage Matrix

All dimensions must be green before writing. Green means answered by the user,
answered by code/git/knowledge sources, or explicitly N/A with justification.

1. **Symptom** - exact observable failure: error, wrong output, crash, hang,
   missing state, or rejected PR feedback.
2. **Repro** - steps, frequency, and environment. Without this, root cause is a
   guess.
3. **Regression** - when it started and whether a commit, PR, or migration
   likely introduced it.
4. **Location** - exact originating file(s)/line(s), not just where the failure
   surfaces.
5. **Root cause** - violated invariant, wrong assumption, race, stale schema, or
   contract mismatch. "It crashes" is not a root cause.
6. **Blast radius** - other callers, state, DB rows, UI views, tests, and
   adjacent workflows that could be affected.
7. **Fix hypothesis** - minimal change, risk level, alternatives considered, and
   what could go wrong.
8. **Fix contract** - concrete scenarios plus required facts for the eventual
   fix.

### Fix Contract Rules

- A scenario describes the fixed behavior in Given/When/Then form.
- A required fact names the durable artifact the fix must create or update and
  the narrow command that proves it.
- A required fact must survive merge: unit test, integration test, contract
  test, browser smoke, type-level check, fixture assertion, or small
  deterministic script.
- Do not use generic pipeline commands (`npx pnpm test`, `npx pnpm build`,
  `npx pnpm lint`) as facts. The pipeline proves the repo; facts prove this bug.
- If no honest executable proof exists yet, use `human_review`, but keep it
  narrow and explain why it cannot be automated.

## Exit Test

Before writing, show back the eight dimensions:

- user answers, quoted briefly
- code/git/knowledge answers, cited with paths or IDs
- explicit N/A items with justification
- proposed required facts and their commands

Ask: "Ready to write the investigation?" Wait for an explicit yes.

## Output

Write:

```
investigations/<slug>/
|-- bug.md
`-- contract.yaml
```

`investigations/` is gitignored. It is for local diagnosis and handoff, not a
repo artifact. If the fix will be launched as a fresh pod from git, promote the
contract into `specs/<slug>/` or create a `/prep` brief from it first.

### bug.md

```markdown
---
slug: <kebab-slug>
reported_at: <YYYY-MM-DD>
severity: low | medium | high | critical
status: investigating | fix-ready | resolved | wont-fix
affected_packages:
  - @autopod/daemon
---

## Symptom

Exact observable failure.

Steps to reproduce:
1. ...
2. ...

Frequency: always / sometimes / once
Environment: local / CI / prod / all

## Regression

When it started, and what commit or PR introduced it if known.

## Location

`path/to/file.ts:123` - where the fault originates.

## Root Cause

Why it happens. Name the violated invariant or wrong assumption.

## Blast Radius

What else is affected or could break if the fix is wrong.

## Fix

**Proposed:** minimal change.

**Risk:** low / medium / high - and why.

**Alternatives considered:**
- Option B: rejected because ...

**Watch out for:**
- Edge case or fragile behavior to preserve.
```

### contract.yaml

```yaml
contract_version: 1
title: <short bug-fix title>
depends_on: []
scenarios:
  - id: reproduces-fixed-behavior
    given:
      - <precondition>
    when:
      - <action>
    then:
      - <expected fixed behavior>
required_facts:
  - id: fact-regression-covered
    proves:
      - <specific bug cannot regress>
    kind: unit-test
    artifact:
      path: packages/.../<test-file>.test.ts
      change: update
    command: npx pnpm --filter <package> test -- <test-file>
human_review: []
```

Use the same contract semantics as `/prep`: proof data belongs in
`contract.yaml`; diagnosis and rationale belong in `bug.md`.

## Handoff

After writing, say where the investigation lives and what the next execution
path is:

- For the current workspace pod: run `ap complete <pod-id> --pr` to hand off
  with the local investigation context.
- For a fresh pod from git: create or promote a `specs/<slug>/` brief first,
  because `investigations/` is gitignored.

Do not promote automatically.
