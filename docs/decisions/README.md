# Architecture Decision Records

This folder holds the durable record of architectural decisions that affect
the codebase across features. ADRs are numbered globally — `ADR-NNN` —
and live forever once accepted, so future planners can reference them
without hunting through old spec folders.

## Conventions

- One file per ADR: `ADR-NNN-<short-slug>.md`.
- Numbered globally and monotonically. Never reuse a number.
- Status one of: `Proposed`, `Accepted`, `Superseded by ADR-MMM`.
- Standard sections: **Context**, **Decision**, **Consequences**.

## Producing new ADRs

`/plan-feature` writes new ADRs here when the planning interview surfaces
a hard-to-reverse or surprising decision. The spec folder
(`specs/<feature>/`) only references ADR IDs in `design.md` — full text
lives here.

The opening codebase scan in every plan reads this entire folder so prior
decisions are baseline knowledge for the next plan.
