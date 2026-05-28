# Context-Atoms Design

A proposal for a tool-neutral, repo-local context-persistence system for AI coding agents. Replaces heavy SDD-style specs with atomic, anchored, kind-typed memory.

This folder holds the design as it stands after a multi-session exploration with Esben on 2026-05-28. It is **NOT the implementation**. The intended next step is a two-week experiment in a pilot repo (NOT this one) to validate the central bet before any tooling is built.

## What to read first

1. `design.md` — the architecture as it stands
2. `experiment/plan.md` — the two-week measurement experiment
3. `open-questions.md` — what's unresolved
4. `../premortem/context-atoms.md` — the failure-mode analysis that shaped current decisions

## Index

**Decisions (what we chose)**
- `decisions/001-storage-repo-markdown.md` — storage is repo-local markdown
- `decisions/002-tool-neutral-cli.md` — tool-neutral CLI, autopod is a consumer
- `decisions/003-two-kinds-not-three.md` — launch with two kinds, defer intent
- `decisions/004-symbol-based-anchors.md` — symbol-based anchors via tree-sitter
- `decisions/005-pre-work-capture.md` — pre-work atom capture in /prep, distill refines
- `decisions/006-pilot-not-this-repo.md` — pilot in a repo that is NOT autopod
- `decisions/007-deterministic-selector-with-fuzzy-boundary.md` — deterministic selector with one fuzzy boundary

**Rejected (what we ruled out)**
- `rejected/a-graph-database.md` — graph database
- `rejected/b-runtime-memory-framework.md` — runtime memory framework (Letta/Mem0/Zep/Cognee)
- `rejected/c-flat-aggregate-spec.md` — flat aggregate spec docs

**Experiment**
- `experiment/plan.md` — two-week ablation experiment
- `experiment/extractor.md` — auto-extract atoms from existing docs

## Provenance

Design conversation: Esben + Claude, 2026-05-28, autopod web session.
Branch: `claude/agent-context-persistence-IaxQW`.

This whole folder is itself a dogfood of the design — small atomic files, one decision per file, anchored where applicable, with rejected-alternatives captured rather than discarded.
