# 004 — Symbol-based anchors via tree-sitter

## Claim
Atom anchors use `file.ts#symbolName` form, resolved via tree-sitter. Path-only anchors are deprecated for new atoms (path-only allowed for genuinely directory-scoped concerns).

## Context
Premortem failure mode 3.5 (anchor rot) showed that path-only anchors break on every rename, file split, and directory reorg. Glob anchors silence the lint but collapse retrieval signal-to-noise. Either way, anchor integrity decays faster than humans repair it.

## Decision
- Primary anchor form: `path/to/file.ts#functionName` or `path/to/file.ts#ClassName.method`.
- Tree-sitter resolves the anchor to the symbol's current location; the anchor survives renames and moves within and across files.
- Glob anchors allowed for genuinely directory-scoped concerns ("all of `pods/`") but flagged as coarser in the lint output.
- A git hook detects renames via `git log --follow -M` and auto-rewrites broken path components.
- Orphan anchors become CI errors after a 7-day grace period — no indefinite lint-disable accumulation.

## Open follow-ups
- Symbol-anchor schema for non-TypeScript languages. Tree-sitter supports many; needs per-language config.
- Cross-file symbol extractions (move function to another file) — does the hook follow? Tree-sitter can detect this by tracking the function signature.
- V0 experiment can ship path-only and add tree-sitter when the bet is proven; see `../open-questions.md` item 2.

## Rejected alternatives
- **Path-only anchors** — premortem-fatal at >5% orphan rate.
- **Free-text "applies to X" descriptions** — selector can't match on prose.
- **Embedding-based retrieval over code** — heavy infrastructure, fuzzy, can't audit which atom was matched and why.

## Provenance
Premortem deep-dive 3.5 (anchor rot), 2026-05-28.
