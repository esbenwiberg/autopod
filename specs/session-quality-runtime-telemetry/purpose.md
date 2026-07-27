# Trustworthy session quality telemetry

## Problem

Session Quality assumes Claude-specific `Read` events. Codex inspects files through shell commands and Pi emits native RPC tool-execution records, so affected pods report zero reads, classify every modification as blind, and persist artificially low scores. Those false values propagate into desktop review, readiness, memory extraction, series summaries, and fleet analytics.

## Outcome

Claude, Codex, and Pi quality telemetry is comparable when trustworthy evidence exists and explicitly unavailable when it does not.

## Users

Operators and reviewers deciding whether a pod worked carefully, plus analytics consumers comparing runtimes and models.

## Success signal

A Codex or Pi session that inspects a file before editing it no longer reports that edit as blind, while sessions lacking recoverable inspection evidence show a neutral unavailable state instead of a measured zero or red penalty.

## Non-goals

- Retune unrelated quality-score weights or desktop health thresholds.
- Count every shell command as repository inspection.
- Infer reads from unknown or mutating shell syntax.
- Fabricate historical Pi activity that was discarded before persistence.
- Redesign the Session Quality card or fleet analytics screens.
- Change provider-attempt lifecycle or accounting semantics.

## Glossary

- **Normalized activity** — runtime-neutral evidence that an agent inspected or mutated a repository file.
- **Recognized inspection** — conservative evidence from a native read tool or a known content-reading command form.
- **Blind edit** — a distinct existing file modified before any recognized inspection in the logical pod session.
- **Inspection availability** — whether the retained event stream can support inspection-dependent judgments honestly.
- **Algorithm version** — the persisted identifier separating incompatible quality-score semantics.

## Reversibility

The database change is additive: retain an explicit algorithm version and availability state rather than destructively rewriting schema meaning. Backfill is idempotent and derived from retained events. If the new algorithm must be rolled back, old-version rows remain distinguishable and can be excluded without pretending they use current semantics.
