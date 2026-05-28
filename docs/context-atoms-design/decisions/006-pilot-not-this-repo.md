# 006 — Pilot in a repo that is NOT autopod

## Claim
The first end-to-end validation runs in a repo OTHER THAN autopod.

## Context
Autopod is convenient: 30 ADRs, two CLAUDE.mds, PRACTICES.md, well-structured spec dirs — rich extraction substrate. But it's documentation-heavy AND the design author's eye is too trained on it. Bad results would be misread as "selector needs tuning" rather than "the design is broken." The premortem pre-launch checklist explicitly required this discipline.

## Decision
- Pilot repo is NOT autopod.
- **Preferred (A)**: a colleague's repo where they don't use autopod. Best for tool-neutrality test AND the "colleagues without autopod" scenario simultaneously.
- **Acceptable (B)**: one of the design author's other side projects.
- **Last resort (C)**: a public OSS repo with some ADRs — clean baseline but weaker ground-truth for benchmark scoring.

## Constraint
The pilot repo must have at minimum:
- Enough recent merged PRs to mine ~15 benchmark tasks.
- Some written rationale somewhere (READMEs count) for the extractor to ingest. If extraction yields <15 atoms, the pilot repo is too doc-sparse; pick another.

Lighter docs are a FEATURE for the pilot, not a bug — it tests the realistic doc-sparse case that the system has to serve.

## Rejected alternative
- **Pilot on autopod** — close-to-home failure: confounds "the design works" with "the selector is tuned to autopod's idioms." We'd misinterpret both green and red results.

## Open follow-up
- Which repo specifically? Tracked in `../open-questions.md` item 1. Esben to decide before the experiment starts.

## Provenance
Premortem pre-launch checklist + chat with Esben, 2026-05-28.
