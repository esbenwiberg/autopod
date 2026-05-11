---
name: migrate-existing-briefs
depends_on: [update-ac-schema]
touches:
  - specs/analytics-safety/briefs/01-detection-store-and-api.md
  - specs/analytics-safety/briefs/02-detection-engine.md
  - specs/analytics-safety/briefs/03-safety-dashboard.md
  - specs/analytics-safety/briefs/04-safety-correlation.md
  - specs/analytics-throughput/briefs/01-throughput-dashboard.md
  - specs/analytics-escalations/briefs/01-escalations-dashboard.md
  - specs/analytics-quality/briefs/01-quality-aggregator.md
  - specs/analytics-quality/briefs/02-quality-dashboard.md
  - specs/analytics-models/briefs/01-model-rollups.md
  - specs/analytics-reliability-funnel/briefs/01-funnel-dashboard.md
  - specs/analytics-cost/briefs/01-cost-dashboard.md
  - specs/proof-of-work-screenshots/briefs/01-screenshot-disk-store.md
  - specs/proof-of-work-screenshots/briefs/02-expose-screenshots-api.md
  - specs/proof-of-work-screenshots/briefs/03-render-screenshots-desktop.md
  - specs/proof-of-work-screenshots/briefs/04-retention-and-cleanup.md
does_not_touch:
  - packages/**
  - specs/ac-schema-v2/**
acceptance_criteria:
  - type: cmd
    outcome: no legacy AC keys remain anywhere under specs/
    hint: grep -rnE '^\s*(test|pass|fail):' specs/
    polarity: expect-no-output
---

## Task

Mechanically rewrite every existing brief frontmatter to the new AC shape
from brief 01:

1. `test:` → `outcome:` (verbatim string).
2. Lift any embedded technical hint into `hint:` (the path / selector /
   endpoint / shell command part of the old `test` string).
3. For `cmd` ACs, read the old `pass:` field and pick a polarity:
   - `pass: "..."` describing expected stdout → `polarity: expect-output`
   - `pass: "no output"` or `fail: "any match"` → `polarity: expect-no-output`
   - exit-code-only check → `polarity: exit-zero`
4. Delete `pass:` and `fail:`.

Don't change any other field. Don't edit the body. If a brief doesn't fit
cleanly into one of the three polarities, escalate with `report_blocker` —
don't invent a shape.

## Touches

See frontmatter. 15 brief files across 8 specs.

## Does not touch

- `packages/**` — code changes are owned by briefs 01, 03, 04.
- `specs/ac-schema-v2/**` — this spec already ships in the new shape.

## Constraints

- One commit per brief file. Makes review trivial and lets a partial
  rollback target a single file.
- Preserve every other frontmatter field (`name`, `depends_on`, `touches`,
  `does_not_touch`) exactly.
- If a brief has a `cmd` AC where the polarity isn't obvious from `pass:`,
  read the original `## Task` body for context before guessing.

## Test expectations

- After all 15 files are rewritten, `ap series create specs/<spec>/` parses
  each migrated spec without error (this implicitly requires brief 01 to be
  merged first — which `depends_on` enforces).
- The single AC on this brief (`grep -rnE '^\s*(test|pass|fail):' specs/`)
  must produce zero matches.

## Wrap-up

The PR body should list any briefs that needed manual polarity judgement —
i.e. where `pass:` was ambiguous and the executor had to read the body to
decide. That's a maintainability signal for the next person rewriting these.
