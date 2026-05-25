# ADR-027: Advisory Browser QA Is Evidence, Not Validation

## Status
Accepted

## Context
Autopod contracts now separate behavior descriptions (`scenarios`), executable
proof (`required_facts`), and judgment-only review (`human_review`). For web UI
work, a deterministic fact can pass while the rendered app is still visibly
wrong or confusing. A guided browser pass can collect useful screenshots and
observations, but model-driven browser judgment is not durable enough to become
a merge gate.

## Decision
Advisory browser QA records bounded, scenario-guided browser observations as
evidence only. It is not a validation phase, does not participate in
`ValidationPhase`, and cannot change `ValidationResult.overall`.

The runner may record `complete`, `skip`, or `error`; concerns and errors remain
advisory. Required facts remain the blocking proof layer. If an advisory concern
should block future merges, it should be converted into a required fact or a
narrow human review item in a later contract.

## Consequences
Easier: Reviewers get screenshot-backed UI observations without adding another
blocking proof layer.

Harder: Every API and UI consumer must keep advisory result display visually and
semantically separate from validation status.

Committed to: Advisory browser QA must stay bounded, optional, and nonblocking
unless a future ADR explicitly changes the contract model.
