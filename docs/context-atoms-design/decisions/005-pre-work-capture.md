# 005 — Pre-work capture in /prep; distill refines

## Claim
The primary mechanism for atom creation is the `/prep` interview skill (or equivalent), which produces atoms BEFORE the pod runs. Post-task distill refines existing atoms but does not originate canonical ones in virgin areas.

## Context
Premortem failure mode 3.8 (too-late paradox) was the most damaging failure mode after empirical disproof: if atoms are only captured via distill, they reflect what the agent did, not what humans intended. Reviewers can't distinguish "agent chose this arbitrarily" from "this was required." The corpus becomes an archaeology of agent improvisation, legitimized by tired PR reviewers. The system launders guesses into requirements.

## Decision
- `/prep` interview produces atoms as part of its output, alongside the brief and envelope.
- Atoms carry `source: human-prep | distill-approved | doc-import` provenance.
- Retrieval can weight or filter by provenance. Pods can be told "treat distill-only atoms as suggestions, not constraints."
- **Distill quarantine**: atoms from a pod working in a virgin area (no pre-existing atoms with overlapping anchors) enter a `provisional` tier; require a second pod or human design review to promote to canonical.

## Constraint
The interview must produce atoms within the existing `/prep` budget. If atom capture significantly lengthens `/prep`, adoption suffers. Atoms-during-interview must be a side effect of questions already being asked, not a new question category.

## Rejected alternatives
- **Distill-only** — creates the too-late paradox.
- **Hand-authored only** — depends on a discipline that premortem 3.2 (curation collapse) showed fails reliably.
- **LLM-extract from PR diffs only** — same too-late problem, worse because it sees only outputs.

## Open follow-up
- Pilot repo may not have `/prep`. Doc-import (the extractor) is the pre-work mechanism for v0; `/prep` integration comes after the experiment validates the bet. See `../open-questions.md` item 4.

## Provenance
Premortem deep-dive 3.8 (too-late paradox), 2026-05-28.
