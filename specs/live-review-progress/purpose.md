# Live Review Progress

## Problem

Full validation can spend several minutes in the frozen five-axis Review Council while the
desktop only shows a generic validating state. Operators cannot distinguish active reviewer
work, retries, synthesis, and closure from a stalled pod.

## Outcome

Desktop operators can see truthful structured progress for the currently running Review phase
on the pod card, in Validation → Review, and as grouped expandable activity evidence.

## Success signal

A full-suite review emits and hydrates independently renderable snapshots across axes,
synthesis, optional closure, and finalization; the desktop contract consumes the same snapshot
for all approved surfaces without calling unavailable axes completed.

## Users

- macOS desktop operators monitoring full-suite pod validation.

## Non-goals

- Changing review authority, findings, fail-closed behavior, retries, concurrency, timeout, or cost.
- Redesigning completed Review Council findings and provenance.
- Redesigning other validation phases or adding the feature to mobile web.
- Adding a database migration or a second event-persistence mechanism.
- Showing synthetic percentage completion or ETA.

## Glossary

- **Live Review progress** — non-authoritative operational telemetry for the running Review phase.
- **Axis** — one of the five frozen council concerns from ADR-036.
- **Settled axis** — an axis that completed or exhausted its attempts and became unavailable.
- **Stage** — `axes`, `synthesis`, `closure`, or `finalizing`.
- **Guardrail** — the configured wall-clock review budget, not an ETA.
- **Grouped activity** — one compact council row backed by expandable safe snapshot evidence.
