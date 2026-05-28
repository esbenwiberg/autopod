# 003 — Launch with two kinds, defer intent

## Claim
Atoms have two kinds at launch: `rationale` and `constraint`. `intent` is explicitly deferred until the two-kind taxonomy is stable.

## Context
Original proposal had three kinds: `intent` (why a thing exists), `decision` (why X was chosen over Y), `constraint` (invariants). Premortem deep-dive 3.4 showed intent vs decision is the blurry boundary — every decision has embedded intent, every intent leaks decision-language. People write all three the same way; kind-ordering becomes meaningless; the selector's intent → decision → constraint ordering produces a scrambled narrative.

## Decision
Two kinds:
- **`rationale`** — covers both "why a thing exists" and "why X was chosen over Y." Includes rejected alternatives.
- **`constraint`** — invariants the code must maintain. Imperative-first ("MUST", "NEVER").

`constraint` vs everything-else is sharp. `intent` vs `decision` is fuzzy. Drop the fuzzy distinction.

## Trigger for revisiting
Once the corpus exceeds ~100 atoms in the pilot, audit: do rationale atoms cluster naturally into "why exists" vs "why chose"? If yes, introduce `intent` as a third kind with a sharp definition. If no, two-kind is the stable answer.

## Rejected alternatives
- **Three kinds (intent / decision / constraint)** — premortem disproved their separability under real authoring conditions.
- **One kind only** — loses the constraint distinction, which actually IS sharp and useful for ordering.
- **More than three** — no evidence anyone needs them; would compound the kind-collapse failure mode.

## Provenance
Premortem deep-dive 3.4 (kind collapse), 2026-05-28.
