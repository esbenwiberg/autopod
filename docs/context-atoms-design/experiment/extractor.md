# Atom extractor

## Purpose
Auto-generate atoms from existing repo documents. **No hand-authoring at v0.**

## Inputs (in order of expected yield)
- `docs/decisions/*.md` (ADRs) or equivalent.
- `CLAUDE.md`, `README.md`, `CONTRIBUTING.md`.
- Per-package convention docs (e.g., `packages/*/README.md`, `packages/*/CLAUDE.md`).
- Existing spec briefs / RFC docs (if present).
- `PRACTICES.md` or similar discipline docs.

## Pipeline

```
source/file.md
       │
       ▼
  LLM call (extractor prompt)
       │
       ▼  0–3 atoms in YAML+MD
  validator (shape, anchor resolution, claim uniqueness)
       │
       ▼
  docs/context/{rationale|constraint}/<id>.md
```

## Extractor prompt skeleton

```
You are extracting atomic context for AI coding agents.

Given the source document below, propose 0–3 atoms.

Each atom MUST:
- State ONE claim in the first sentence of the body.
- Declare anchors (file paths or globs from the source's context section).
- Be ≤30 lines including frontmatter.
- Be kind=rationale (why a thing exists or was chosen, including rejected alternatives) OR
       kind=constraint (an invariant the code must maintain; imperative-first).

Return 0 atoms if the source is:
- Procedural (how to run X).
- Status (current state of work).
- Recoverable from code (the agent could grep for it).

Output strict YAML+markdown. No commentary, no preamble.
```

## Validator rejects
- Missing required frontmatter fields.
- Anchors that don't resolve to a real file or symbol.
- More than 1 H2 heading in the body (multi-fact tell).
- Body > 30 lines.
- Same `claim` as an existing atom.

**Reject = skip, not abort.** Extraction is best-effort per source.

## Worked example

**Input**: autopod's `docs/decisions/ADR-007-local-recovery-requeue-not-resume.md` (re-queue recovery instead of dedicated resume path).

**Output**:

```markdown
---
kind: rationale
claim: Local session recovery re-queues sessions instead of using a dedicated resume path
anchors:
  - packages/daemon/src/pods/pod-manager.ts#processSession
  - packages/daemon/src/recovery/**
tags: [subsystem:recovery, lifecycle]
source: doc-import:ADR-007
status: active
---
Recovery re-queues orphaned sessions with a `recoveryWorktreePath` field rather
than building a separate `resumeSession()` path. This keeps container setup in a
single code path, avoiding duplication between fresh and recovered sessions.
Recovery is not instant (waits for queue slot), but post-crash latency is not
user-visible.
```

18 lines. One claim. Concrete anchors. Provenance preserved.

## Implementation sketch
- Single TypeScript file, ~150 LOC.
- Anthropic SDK call per source (Sonnet for extraction is plenty).
- YAML schema validation via `yaml` + `zod`.
- Anchor resolution: walk the repo, check paths exist; for `#symbol`, parse with tree-sitter — OR skip the symbol check at v0 and just verify the path resolves (see `../open-questions.md` item 2).
- Write outputs to `docs/context/{rationale|constraint}/`.

## What we deliberately do NOT build at this stage
- The selector. Stage 1 just produces atoms; the experiment injects them via flat anchor-match.
- The link graph between atoms (no `links` field populated by v0 extractor).
- Telemetry hooks (come in Stage 3 of the experiment).
- Distill or pre-work capture in `/prep` — doc-import is the only source at v0.
