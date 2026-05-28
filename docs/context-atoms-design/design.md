# Architecture

## The problem

AI coding agents need context, but specs rot, pollute the context window, and make the agent's work feel "strict" instead of being guided by intent and constraints. Empirical evidence (ETH Zurich + LogicStar.ai AGENTS.md study, arXiv 2602.11988) shows repo-level context files often REDUCE task success by encouraging broader exploration.

We want intent and guardrails for the agent, not specs.

See `rejected/c-flat-aggregate-spec.md` for what this design is reacting against.

## The shape

### Atoms

Small, anchored, kind-typed markdown files committed to the repo.

```
docs/context/
  rationale/    # why a thing exists or was chosen (incl. rejected alternatives)
  constraint/   # an invariant the code must maintain
```

Each atom: YAML frontmatter (`kind`, `anchors`, `tags`, `links`, `claim`, `source`, `status`) + short markdown body. One claim per atom. ≤30 lines.

### Envelope

Structured artifact describing the work in play:

```yaml
files: [...]            # mechanically derived from worktree diff
subsystems: [...]       # closed-vocabulary, path-mapped
tags: [...]             # closed-vocabulary
```

The envelope is the **boundary** between fuzzy text (task description, interview) and pure functions (everything downstream). Tests live on both sides but use different methods. See `decisions/007-deterministic-selector-with-fuzzy-boundary.md`.

### Selector

Pure function:

1. `anchor ∩ envelope.files`
2. `tag ∩ envelope.tags`
3. Per-link-type graph traversal: `refines / supersedes / implements` walk to fixpoint; `related / contradicts` zero hops unless tag-matched.
4. Dedupe, then relevance-score within a token budget.

No LLM in the loop. Unit-testable. Golden-regression-testable.

### Lifecycle

- **Pre-work capture** — `/prep` interview produces atoms BEFORE the pod runs. Distill refines later, doesn't originate.
- **Provenance** — every atom carries `source: human-prep | distill-approved | doc-import`. Retrieval can weight or filter by provenance.
- **Staleness** — AST-symbol drift detection via tree-sitter; surfaces in PR comments. Churn-based fallback for non-symbol files.

### Packaging

- Standalone CLI (`init`, `lint`, `stale`, `coverage`, `select`, `walk`, `distill`).
- MCP server exposing `context.select`, `context.walk`, `context.search`.
- Autopod and other tools become consumers — they spawn the CLI/MCP, layer their own UX on top.

## The single bet

**Selective, scoped, kind-ordered injection produces fundamentally different agent behavior than flat always-on injection.**

If true → design has a path. If false → no architecture saves it.

This bet is unverified. The experiment in `experiment/plan.md` exists to test it before any selector or CLI is built.

## What we explicitly do NOT promise yet

- That this works in doc-sparse repos (most repos).
- That distill-extracted atoms reflect intent rather than agent improvisation. See `decisions/005-pre-work-capture.md` for the mitigation.
- That the selector tunes cleanly without becoming a knob factory.

The premortem (`../premortem/context-atoms.md`) covers these as 6-month failure modes with mitigations baked into the pre-launch checklist.
