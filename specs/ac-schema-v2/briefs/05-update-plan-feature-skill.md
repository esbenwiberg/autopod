---
name: update-plan-feature-skill
depends_on: [update-ac-schema]
touches:
  - .claude/skills/plan-feature/SKILL.md
does_not_touch:
  - packages/**
  - specs/**
acceptance_criteria:
  - type: cmd
    outcome: skill teaches the new outcome / hint / polarity shape
    hint: grep -nE 'outcome:|hint:|polarity:' .claude/skills/plan-feature/SKILL.md
    polarity: expect-output
  - type: cmd
    outcome: skill no longer teaches the legacy test / pass / fail shape in AC examples
    hint: grep -nE '\{ type: (api|web|cmd), test:|pass:|fail:' .claude/skills/plan-feature/SKILL.md
    polarity: expect-no-output
---

## Task

Update the repo-local `/plan-feature` skill at
`.claude/skills/plan-feature/SKILL.md` so subsequent runs produce briefs in
the new AC shape. The skill is consumed by Claude Code agents during the
plan-feature interview loop and rendered into brief YAML at write time —
if the example block still teaches `{ test, pass, fail }`, every new spec
will arrive in the wrong shape.

### Concrete edits

1. **AC example block (~line 727–731)** — replace:

   ```yaml
   acceptance_criteria:
     - { type: api, test: "POST /api/v2/events with valid body", pass: "201 with body.id (uuid)", fail: "non-201 or missing id" }
     - { type: api, test: "GET /api/v2/events?since=now", pass: "200 with body.events array", fail: "non-200 or missing field" }
     - { type: web, test: "navigate /events and click first row", pass: "detail panel renders with event title", fail: "no panel or no title" }
     - { type: cmd, test: "rg -l 'OldEventEmitter' packages/daemon/src", pass: "no matches", fail: "any match means a caller still uses the deleted symbol" }
   ```

   with the v2 shape:

   ```yaml
   acceptance_criteria:
     - type: api
       outcome: POST /api/v2/events with a valid body returns 201 with body.id (uuid)
       hint: POST /api/v2/events
     - type: api
       outcome: GET /api/v2/events?since=now returns 200 with body.events array
       hint: GET /api/v2/events?since=now
     - type: web
       outcome: navigating /events and clicking the first row shows a detail panel with the event title
       hint: /events
     - type: cmd
       outcome: no caller still uses the deleted OldEventEmitter symbol
       hint: rg -l 'OldEventEmitter' packages/daemon/src
       polarity: expect-no-output
   ```

2. **Decompose-fuzzy-claims example (~line 870–890)** — anywhere the
   decompose-fuzzy-claims walkthrough shows ACs with `test:` / `pass:` /
   `fail:`, rewrite them in the new shape. Outcome is the human-readable
   line; hint is the technical pointer; polarity is the cmd enum.

3. **Coverage dimension #14 prose** — ensure the body uses
   `outcome` consistently when describing what an AC asserts. Replace any
   surviving occurrences of "the `test` field" with "the `outcome` field".

4. **Padding warning (~line 939)** — the surrounding paragraph already
   warns against padding `acceptance_criteria` with `none`-typed entries;
   no schema change there, just confirm the surrounding example uses the
   new shape if one is present.

## Touches

- `.claude/skills/plan-feature/SKILL.md` — single file.

## Does not touch

- `packages/**` — code is owned by briefs 01, 03, 04.
- `specs/**` — spec migration is owned by brief 02.
- The global `~/.claude/skills/plan-feature/SKILL.md` is **out of scope**.
  The repo-local skill wins when running plan-feature inside autopod, so
  it's the only one that has to be right for this codebase. If the user
  wants the global one updated, that's a separate manual edit.

## Constraints

- Don't restructure the skill body — only rewrite AC examples and the
  field-name references. The interview loop, exit-test, coverage
  dimensions etc. are out of scope.
- Keep example readability — block form (`- type: api\n  outcome: ...`)
  is preferred over inline `{ ... }` because it lines up with how authors
  actually write briefs.

## Test expectations

- After the edits, a fresh plan-feature run produces briefs in the new
  shape on first generation (no manual fixup).
- The two grep ACs above pass:
  - `outcome:` / `hint:` / `polarity:` appear in the skill.
  - No `{ type: api|web|cmd, test:` patterns and no `pass:` / `fail:`
    YAML keys remain.

## Wrap-up

Spot-check: re-render the skill mentally as a plan-feature execution. The
example block is what the model looks at when deciding "what does an AC
look like?" — if that block is right, the rest follows.
