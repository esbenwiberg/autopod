---
name: seed-facts
description: >
  Seeds docs/facts/ for a repo by synthesising three sources: scan-history
  candidates (if available), existing ADRs, and codebase conventions visible
  in CLAUDE.md and source patterns. Proposes each candidate to the user one
  at a time, then writes approved ones as fact-NNN-*.md files and regenerates
  the index. Use when setting up the facts corpus for the first time, or to
  fill gaps after /scan-history.
allowed-tools: Read, Bash, Glob, Grep, Write, AskUserQuestion
---

# /seed-facts

Populate `docs/facts/` from real signals in this repo rather than guessing.
Works from three sources in order of reliability:

1. **`docs/facts/_candidates.md`** — output of `/scan-history` (highest signal:
   real questions from real sessions)
2. **`docs/decisions/`** — existing ADRs often contain soft conventions buried
   in their Consequences sections that never warranted their own ADR
3. **CLAUDE.md + codebase patterns** — recurring conventions visible in the
   source tree (package manager, migration numbering, route prefixes, etc.)

## Steps

### 1 — Gather raw material

Read in parallel:

- `docs/facts/_candidates.md` if it exists (from `/scan-history`)
- Every file in `docs/decisions/` — specifically the **Consequences** and
  **Decision** sections, looking for soft conventions, not just the headline
  decision
- `CLAUDE.md` — sections like "Environment Gotchas", "Code Style", any
  numbered checklists (e.g. "Adding New Profile Fields")
- A quick grep for recurring patterns:
  ```bash
  # Convention signals: route prefixes, migration prefixes, test patterns
  grep -r "always\|never\|must\|prefer\|convention\|pattern" CLAUDE.md \
    docs/decisions/ 2>/dev/null | grep -v '^Binary' | head -60
  ```

### 2 — Derive candidates

From everything gathered, build a candidate list. For each candidate:

- State it as a declarative sentence ("We use X", "New Y always go in Z")
- Assign a topic from `docs/facts/README.md`'s taxonomy
- Note the source (ADR ID, CLAUDE.md section, codebase pattern, scan-history)
- Decide: fact or not?
  - Skip if it's already obvious from the code structure
  - Skip if it's covered by an ADR (ADRs outrank facts)
  - Skip if it's feature-specific (not recurring)
  - Keep if a planning agent would otherwise have to ask about it

Aim for 5–15 facts on a first seeding. Quality over quantity.

### 3 — Review with user, one at a time

For each candidate, present it using `AskUserQuestion` with these options:

```
Candidate fact:
  Title: <declarative statement>
  Topics: <topics>
  Body: "<rule>. <rationale in one sentence>."
  Source: <where this came from>

→ Accept / Reword / Skip
```

If the user chooses **Reword**, ask for their preferred wording, then confirm
the reworded version before writing.

Do not batch candidates — one per turn.

### 4 — Write approved facts

For each accepted or reworded candidate:

1. Determine the next available fact number:
   ```bash
   ls docs/facts/fact-*.md 2>/dev/null | grep -oE 'fact-[0-9]+' | \
     sort -t- -k2 -n | tail -1 | grep -oE '[0-9]+' || echo "000"
   ```
   Increment by one. Never reuse a number.

2. Derive a short slug from the title (lowercase, hyphens, max 5 words).

3. Write `docs/facts/fact-NNN-<slug>.md`:

   ```markdown
   ---
   topics: [topic1, topic2]
   ---

   # <Title>

   <Rule sentence>. <Rationale sentence>.
   ```

4. After writing each file, immediately run:
   ```bash
   ./scripts/generate-knowledge-index.sh
   ```
   Confirm the new entry appears in `docs/facts/index.md` before moving to
   the next candidate.

### 5 — Final summary

After all candidates are processed, show:
- Facts written: N (list their filenames)
- Candidates skipped: N (brief reason for each)
- Run `./scripts/generate-knowledge-index.sh` one final time
- Show the resulting `docs/facts/index.md` to the user

## What makes a good fact

**Good** — would save the planning agent from asking:
- "We use `npx pnpm` — pnpm is not globally installed"
- "Migration files use a numeric prefix; never reuse a prefix"
- "New daemon routes go in `src/api/routes/`, registered in `server.ts`"
- "All credential storage uses AES-256 via `credentials-cipher.ts`"

**Bad** — skip these:
- Architectural decisions already in an ADR (redundant)
- Things any agent would discover in 30 seconds of grepping
- Feature-specific choices ("for this feature we used SSE")
- Vague policy ("write good tests")

## After seeding

Run `/plan-feature` on a real feature. Watch which questions get auto-answered
from facts vs which still go to the user. Any question that goes to the user
and gets a policy-type answer is a gap — add a fact for it after the session.

The corpus grows organically from real planning sessions. `/scan-history` +
`/seed-facts` are the bootstrap; plan-feature usage is the steady-state
growth mechanism.
