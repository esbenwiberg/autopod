# Review Council Robustness and Lifecycle Presentation

## Problem

Autopod's frozen five-axis review council currently relies primarily on prompt-level JSON instructions. The axis parser uses strict `JSON.parse()`, retries the same request without validation feedback, and classifies every exhausted axis as `unavailable`. In a real full validation, four of five reviewers returned unparseable output twice. Desktop then described all four as "Infrastructure unavailable", even though the provider and runner had executed and the actual failure was an invalid response protocol.

The council also persists first-gate findings directly into the active ledger even when a healthy council has produced structured canonical findings. Desktop therefore shows a raw "Initial Review" section alongside council findings, often duplicating the same defect. Raw first-gate findings should be provenance in a healthy council and visible fallback evidence only when the council is degraded.

Finally, fixed findings are visually easy to mistake for active defects. A red historical severity badge dominates a small gray `Fixed` badge, fixed cards are mixed with open findings in the All view, and closure evidence is hidden. The UI does not make the successful repair proof sufficiently obvious.

## Outcome

Deliver one fail-closed review protocol and presentation model that:

- constrains reviewer output with provider-native structured output where supported;
- validates all output locally against strict bounded contracts;
- safely accepts known CLI envelopes and harmless JSON fences;
- retries invalid output once with a stable validation error, never by echoing malformed output;
- records typed failure reasons for invalid response, timeout, provider unavailability, runner failure, and HEAD drift;
- declares a council healthy only when all five axes and synthesis are valid and every first-gate finding has a structured canonical representation;
- treats first-gate findings as provenance in healthy councils and fallback blockers in degraded councils;
- reconciles raw-to-canonical findings across attempts without duplicate lifecycle entries;
- gives verified fixed findings prominent green success treatment and separates them from findings needing attention.

## Users

The primary user is the Autopod operator reviewing validation in the macOS Desktop app. Daemon operators also benefit from typed bounded diagnostics and reliable reviewer protocol telemetry. Agents are affected only through clearer fail-closed rework feedback.

## Success Signal

A full review using the supported Claude or Codex container reviewer either produces five schema-valid axis results and a schema-valid synthesis, or fails closed with an accurate typed reason. Malformed output can never become a completed axis or a passing review.

A healthy council shows only canonical structured findings. A degraded council clearly says why it is degraded and includes unmatched first-gate findings under `First-gate fallback`.

In Desktop, a fixed finding is immediately recognizable as verified and resolved: green check treatment, historical severity wording, visible verification metadata, and a separate fixed section in the All view.

## Non-Goals

- No claim that JSON schema can guarantee the factual correctness of an AI conclusion. The feature guarantees protocol correctness, boundedness, provenance, and fail-closed handling.
- No change to deterministic lint, SAST, build, test, health, pages, or required-fact semantics.
- No database migration or validation-history rewrite. Stored validation results remain JSON snapshots with backward-compatible optional fields.
- No raw malformed model output in validation history, Desktop, events, or retry prompts.
- No broad redesign of advisory browser QA, memory ranking, or unrelated LLM response protocols.
- No weakening of frozen packet, changed-file filtering, source-backed synthesis, closure evidence, or reviewed-HEAD protections.
- No conflation of `fixed`, `rejected`, and human `dismissed` findings.

## Glossary

- **First gate** — the broad task review run before the five-axis council.
- **Healthy council** — all required axes and synthesis completed with valid output, stable HEAD, and every first-gate blocker canonicalized into a structured finding.
- **Degraded council** — any required axis, synthesis, HEAD check, or first-gate canonicalization requirement failed.
- **Canonical finding** — the structured source-backed finding shown to the user and tracked by semantic identity.
- **First-gate fallback** — a raw first-gate finding retained visibly because the council could not canonicalize it safely.
- **Closure verification** — source-backed proof that a prior semantic finding was fixed by the frozen repair delta.

## Reversibility

The protocol and UI changes are code-only. New wire fields are optional, and old validation snapshots remain readable. Provider-native schema flags can be disabled independently while retaining strict local validation and fail-closed behavior. No schema migration needs rollback.
