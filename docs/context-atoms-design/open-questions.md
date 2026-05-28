# Open questions

Things unresolved as of 2026-05-28 handoff. Each one is named with a recommendation but needs an explicit decision before the experiment runs.

## 1. Which pilot repo?

Decision 006 says NOT autopod. Three candidate categories:
- **A**: a colleague's repo where they don't use autopod. Best for tool-neutrality test.
- **B**: one of Esben's other side projects. Lower coordination cost.
- **C**: a public OSS repo with some ADRs. Clean baseline; weaker ground-truth on benchmark scoring.

**Recommendation**: A → C → B. Esben to decide on a specific repo before Stage 1 of the experiment.

## 2. Symbol-based anchors at v0 — or path-only first?

Decision 004 calls for tree-sitter symbol anchors. But for the v0 experiment, path-only anchors might be enough (anchor rot is a 6-month problem; the experiment is 2 weeks).

**Recommendation**: path-only for the experiment. Add tree-sitter when the bet is proven and the system has a future. Don't gold-plate before proving the foundation.

## 3. Injection mechanism for the experiment

Decision 007 implies a selector. But the experiment uses flat anchor-match injection — no selector, no graph walk, no kind ordering.

**Recommendation**: confirm experiment intentionally tests the simplest possible thing. The selector is built only if the experiment goes green. (This is correct as written; flagged for visibility.)

## 4. /prep integration

Decision 005 makes `/prep` the primary capture mechanism. But the pilot repo doesn't have `/prep` (autopod-specific skill).

**Recommendation**: doc-import only for the pilot. Validates extraction without coupling to autopod's skill system. Port `/prep` to the standalone CLI later, once the bet is proven and a tool home exists.

## 5. Standalone repo name

If the experiment goes green, what's the standalone repo called?
- `context-atoms` — descriptive but bland.
- `atoms` — short, too generic.
- `intent-graph` — overpromises (it's not really a graph at user-facing level).
- `lodestar` — evocative but obscure.

**Recommendation**: defer. Pick the name when the repo is being created, not before.

## 6. Whether autopod's existing memory subsystem stays or migrates

Autopod has SQLite-backed `memory_entries` (migration 107). If atoms-as-files prove out, do we:
- Migrate existing entries to atom files?
- Keep both, with autopod's SQLite as a cache?
- Deprecate the SQLite layer entirely?

**Recommendation**: defer until the standalone tool exists and at least one autopod release uses it. Then audit existing entries for atom-eligibility. Premature migration burns capital before the foundation is laid.

## 7. How to score "exploration" precisely

`files_opened_in_first_5_tool_calls` is the proposed metric, but:
- What counts as "opening"? A Read tool call? A grep? A glob?
- First 5 tool calls vs first N% of tool calls?
- Should it be normalized by task complexity?

**Recommendation**: keep it simple at v0 — count any tool call that reveals file contents (Read, Grep, Glob), first 5 only, no normalization. Refine if signal is ambiguous.
