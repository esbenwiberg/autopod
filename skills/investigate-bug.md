---
name: investigate-bug
description: >
  Diagnoses a bug through a short interview-plus-codescan loop, then writes
  `investigations/<slug>/bug.md` (gitignored) with symptom, root cause, blast
  radius, and fix proposal. Ends by offering to promote the workspace pod to
  auto mode to execute the fix.
allowed-tools: Read, Grep, Glob, Bash, Write, Edit, Agent, AskUserQuestion
---

# /investigate-bug

Turn a bug report into a structured diagnosis in `investigations/<slug>/bug.md`,
then hand off to an auto pod for the fix via `ap complete <id> --pr`.

## When to use

- Something is broken and you need to pin the root cause before touching code
- You want a structured handoff doc before promoting to a fix pod
- The bug is non-obvious and you need to narrow blast radius before acting

If the bug location is already obvious and the fix is trivial, just fix it directly.

## How this works

A short scan-then-interview loop — not a fixed set of phases. Scan first,
ask only what the codebase can't answer, write when all dimensions are green.

```
scan codebase → surface finding → ask ONE question → wait →
scan again → ask ONE question → wait → ... → dimensions green → write
```

### Rules (non-negotiable)

- **One question per turn. Full stop.**
- Scan the codebase before asking anything. If the codebase answers a dimension,
  cite the finding and don't ask.
- After every answer, grep/blame/log-search again before forming the next question.
- Never draft the investigation doc during the loop. Write only after all dimensions
  are green and the user has confirmed.
- Prefer `git log --oneline -20 -- <file>` and `git blame` over assumptions about
  when something broke.

### Opening move

Before asking anything, scan for 2–3 minutes:

1. Grep for the error message or symptom string across the codebase
2. Identify the most likely module(s) involved
3. Check recent commits touching that area: `git log --oneline -10 -- <path>`
4. Look for existing tests that cover the area — are they passing? Do they even exist?
5. Check for TODOs, FIXMEs, or known-fragile comments in the blast radius

Present a 2–4 bullet summary of what you found. Ask the first question. Stop.

### Coverage dimensions

All 7 must be green before writing. Green = answered by user, answered by codebase,
or explicitly N/A with justification.

1. **Symptom** — exact observable failure. Error message, wrong output, crash, hang.
   If the user gives a vague description ("it's broken"), ask for the exact error.
2. **Repro** — steps to reproduce. Frequency (always / sometimes / once).
   Environment (local / CI / prod). Without this, root cause is a guess.
3. **Regression** — when did it start? Can it be linked to a specific commit or PR?
   `git log` is your friend here — check before asking.
4. **Location** — exact file(s) and line(s) where the fault originates.
   Not where it surfaces — where it is caused. These are often different.
5. **Root cause** — why it happens. What invariant is violated, what assumption
   is wrong, what race condition exists. "The null check is missing" is a root
   cause. "It crashes" is not.
6. **Blast radius** — what else could be affected by this bug or its fix.
   Other callers, downstream state, related tests.
7. **Fix hypothesis** — the minimal change that addresses the root cause.
   Include: risk level (low / medium / high), alternatives considered, and
   anything that could go wrong with the proposed fix.

### Per-turn discipline

After each user answer:

1. Name which dimensions the answer touches.
2. Re-scan the codebase for what the answer opens up.
3. Form the next question.

If the user defers ("you decide"), propose a specific answer with a one-line
rationale and ask for confirmation. Do not silently decide.

### Exit test — the show-back

Before writing, produce a checklist of all 7 dimensions:

- ✅ Answered by the user (quote their answer)
- 📂 Answered by the codebase (cite file + line)
- ⚠️ Explicitly N/A with justification

Show it back with "ready to write — green light?" and wait for confirmation.
Do NOT write until confirmed.

---

## Output

### File location

```
investigations/<slug>/bug.md
```

`investigations/` is gitignored — it lives on disk but never hits the repo.
`<slug>` is kebab-case from the symptom: e.g. `pod-status-stuck-provisioning`,
`auth-token-null-crash`, `migration-033-skipped`.

### bug.md format

```markdown
---
slug: <kebab-slug>
reported_at: <YYYY-MM-DD>
severity: low | medium | high | critical
status: investigating | fix-ready | resolved | wont-fix
affected_packages:
  - @autopod/daemon
  - @autopod/shared
---

## Symptom

Exact observable failure. What the user sees.

Steps to reproduce:
1. ...
2. ...

Frequency: always / sometimes / once
Environment: local / CI / prod / all

## Regression

When it started, and what commit or PR introduced it (if known).
`git log` findings here.

## Location

`packages/daemon/src/pods/pod-manager.ts:412` — the specific line(s) where
the fault originates (not just where it surfaces).

## Root Cause

Why it happens. What invariant is violated. Be precise.

## Blast Radius

What else is affected by this bug or could break if the fix is wrong.
- Other callers of the affected function
- Downstream state / DB entries
- Tests that will need updating

## Fix

**Proposed:** one paragraph describing the minimal change.

**Risk:** low / medium / high — and why.

**Alternatives considered:**
- Option B: ... (rejected because ...)

**Watch out for:**
- Edge case or fragile thing to not break
```

### severity guide

| Severity | Meaning |
|----------|---------|
| `critical` | Data loss, security breach, complete feature broken for all users |
| `high` | Major feature broken, no workaround |
| `medium` | Feature degraded, workaround exists |
| `low` | Minor UX issue, cosmetic, edge case |

---

## Handoff

After writing `bug.md`, offer to promote the pod:

> "Investigation written to `investigations/<slug>/bug.md`.
> Ready to fix? Run `ap complete <pod-id> --pr` to hand off to an auto agent
> with this context, or `ap complete <pod-id> --artifact` if you want a
> branch without a PR."

The fix agent will have the full worktree including `investigations/<slug>/bug.md`
as context. It should read the doc before touching any code.

Do NOT promote automatically. Always surface the command and let the user pull
the trigger.

---

## Anti-patterns

- Asking a question the codebase already answers via grep or git log.
- Batching two questions in one turn.
- Writing before all 7 dimensions are green.
- Locating the bug at the surface (where the error appears) rather than the source
  (where the fault originates).
- Proposing a fix before establishing root cause.
- Skipping the "ready to write — green light?" confirmation.
- Auto-promoting the pod without user confirmation.
- Treating "I think it might be in X" as a green dimension — that's still a hypothesis,
  not a root cause.
