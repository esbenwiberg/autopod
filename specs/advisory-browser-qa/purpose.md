# Advisory Browser QA

## Problem
Autopod contracts can describe web UI behavior with scenarios and judgment-only
human review items, but validation currently has no bounded way to collect
browser-visible evidence for that behavior unless the planner authors explicit
browser-test facts. Narrow facts can pass while the running app still looks
wrong, confusing, or visibly incomplete.

## Outcome
Web UI pods can collect bounded, guided scenario browser observations without
changing validation pass/fail.

## Users
Pod authors and reviewers benefit from screenshot-backed advisory evidence.
Desktop users benefit from a neutral Validation tab surface that shows what the
browser QA observed without implying another merge gate.

## Success signal
After a green validation run on a web UI pod with scenarios or human review
items, the Validation tab can show advisory browser observations and screenshots,
and the validation result remains pass even when an advisory concern is recorded.

## Non-goals
- Replacing required facts or browser-test facts.
- Adding a new blocking validation phase.
- Running advisory browser QA on non-web profiles.
- Running unbounded natural-language browser suites.
- Making advisory concerns block merge or retry logic.

## Glossary
- **Advisory browser QA** - a guided browser pass that records observations and
  screenshots but cannot fail validation.
- **Checklist target** - one scenario or human_review item selected for the
  advisory run.
- **Scenario** - a Given/When/Then behavior item in `contract.yaml`.
- **Human review item** - a judgment-only contract item that cannot honestly be
  reduced to a deterministic required fact yet.
- **Observation** - the advisory result for one checklist target, with verdict,
  notes, and optional screenshots.
- **Neutral chip** - a Validation tab selector that opens advisory details but
  is excluded from validation phase counts and pass/fail status.

## Reversibility
This feature adds a profile column and public validation result fields. To back
out, leave the DB column in place, stop setting `advisoryBrowserQa` on new
validation results, and keep clients tolerant of the optional field. Existing
stored advisory results remain historical evidence.
