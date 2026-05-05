---
name: scan-history
description: >
  Mines Claude Code session history for this project to extract questions
  asked during /plan-feature runs. Groups them by theme, identifies recurring
  ones, and outputs a list of candidate facts for docs/facts/.
  Use once to bootstrap the facts corpus for a repo, before running /seed-facts.
allowed-tools: Bash, Read, Write, AskUserQuestion
---

# /scan-history

Extract candidate facts by mining past `/plan-feature` sessions stored in
Claude Code's local history. The output feeds `/seed-facts`, which turns
candidates into real fact files after your review.

## What this does

Claude Code stores session transcripts as JSONL files under
`~/.claude/projects/<project-id>/`. Each file is one session. This skill:

1. Locates the session folder for this project
2. Scans sessions for `/plan-feature` invocations
3. Extracts every `AskUserQuestion` call made during those sessions
4. Groups questions by theme
5. Flags questions that recurred across multiple sessions — those are the
   highest-value fact candidates

## Steps

### 1 — Find the project session folder

```bash
ls ~/.claude/projects/
```

The project folder name is derived from the project path. Match it to the
current repo by checking what path is encoded in each folder name, or by
looking at recent session content:

```bash
for dir in ~/.claude/projects/*/; do
  # look for a session that references this repo's path
  grep -rl "$(pwd)" "$dir"*.jsonl 2>/dev/null | head -1 && echo "  → $dir" && break
done
```

If no match: the project has no saved history. Stop here and run `/seed-facts`
directly — it works from codebase analysis alone.

### 2 — Extract AskUserQuestion calls from plan-feature sessions

```bash
PROJECT_DIR="<matched dir from step 1>"

# Find sessions containing plan-feature invocations
grep -l '"plan-feature"\|/plan-feature' "$PROJECT_DIR"*.jsonl 2>/dev/null
```

For each matched session file, extract the questions:

```bash
# Each line in a .jsonl file is a JSON object representing a conversation turn.
# AskUserQuestion tool calls appear as tool_use blocks with name "AskUserQuestion".
# Extract the "question" field from each.
grep -h '"AskUserQuestion"' "$PROJECT_DIR"*.jsonl 2>/dev/null \
  | grep -o '"question":"[^"]*"' \
  | sed 's/"question":"//;s/"$//' \
  | sort | uniq -c | sort -rn
```

This gives you a frequency-sorted list of every question asked, with a count
of how many times it appeared across sessions.

### 3 — Categorise by coverage dimension

Map each question to one of the 15 coverage dimensions from `/plan-feature`:
Problem framing, Outcome, Success signal, Users/actors, Non-goals, Glossary,
Reversibility, Blast radius, Seams, Contracts, UX flows, Reference reading,
Pod sizing, Acceptance criteria, Hard-to-reverse decisions.

Questions that map to **Glossary**, **Non-goals**, or **Reference reading**
are usually feature-specific — skip them.

Questions that map to **UX flows**, **Blast radius**, or **Seams** are almost
always feature-specific — skip them.

Questions that map to conventions, policies, or preferences — those are
fact candidates.

### 4 — Build the candidate list

For each recurring question (appeared in 2+ sessions) that maps to a
convention/policy dimension:

- Write the question
- Write the answer(s) given across sessions (paraphrase if they were consistent)
- Assign a topic from `docs/facts/README.md`'s taxonomy
- Note confidence: `high` if all answers were consistent, `low` if they varied

Output format:

```
## Candidate Facts

### [topic] Title of the fact as a declarative statement
Question that surfaced it: "..."
Consistent answer across N sessions: "..."
Suggested fact body: "..."
---
```

### 5 — Write the candidate file

Write the candidate list to `docs/facts/_candidates.md` (prefixed with `_`
so the index script ignores it). Hand off to `/seed-facts`, which reviews
candidates with you and writes the approved ones as real fact files.

```bash
# _candidates.md is excluded from index generation (no fact-NNN prefix)
```

## If history is sparse or absent

Not every repo will have rich plan-feature history. In that case:

- Run with whatever sessions exist — even one session is useful
- If zero sessions found, note that and stop
- `/seed-facts` can bootstrap from codebase analysis alone; scan-history
  is an accelerator, not a prerequisite

## Output

`docs/facts/_candidates.md` — candidate list for `/seed-facts` to review.
Does not write any `fact-NNN-*.md` files. That step is `/seed-facts`.
