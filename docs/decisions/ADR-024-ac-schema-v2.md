# ADR-024: AC schema v2 — outcome + optional hint, drop pass/fail in favour of polarity enum

## Status

Accepted

## Context

The `AcDefinition` shape in `@autopod/shared` was
`{ type, test, pass, fail }`:

- `test` was overloaded between "criterion description" (daemon's
  interpretation) and "technical hint" (desktop form's interpretation).
- `pass` / `fail` were prose strings; `executeCmdChecks` regex-scanned the
  `pass:` value with a `NEGATIVE_HINTS` table to decide between
  expect-output and expect-no-output. Brittle and silently incorrect on
  small typos.
- A pre-pass in `classifyAcTypes` ran a banlist of regexes
  (`COMMAND_LIKE_AC_PATTERNS`) including `/^\/[a-z]/i` against every AC
  *regardless of declared type*. Any criterion starting with `/<lowercase>`
  was force-converted to `type: 'none'`, breaking declared web ACs.

The observed failure was pod `confidential-loon`: two ACs declared as
`type: web` with text `/pr-dashboard` were silently reclassified to
`'none'` and never fired.

## Decision

Adopt `AcDefinition` v2:

```ts
type AcType = 'none' | 'api' | 'web' | 'cmd';
type AcPolarity = 'expect-output' | 'expect-no-output' | 'exit-zero';

interface AcDefinition {
  type: AcType;
  outcome: string;          // user-visible criterion description
  hint?: string;            // optional URL / selector / endpoint / command
  polarity?: AcPolarity;    // cmd-only enum
}
```

The YAML frontmatter, the SQLite JSON blob, and the Swift mirror all share
this shape. `outcome` is required; `hint` and `polarity` are optional.
`polarity` is only valid when `type === 'cmd'`.

Concurrently:

- Tighten `COMMAND_LIKE_AC_PATTERNS`' slash-command regex to require
  single-token criteria (`/^\/[a-z][a-z0-9-]*\s*$/i`), so user outcomes
  like `/pr-dashboard renders with header` are not caught.
- Gate the banlist override in `classifyAcTypes` so it only fires when
  the declared type is `cmd` or absent. Declared `web` / `api` ACs are
  trusted.
- Replace `NEGATIVE_HINTS` regex-scanning with a direct `ac.polarity` read.
- Thread `ac.hint` into `generateAcInstructions` as a separate prompt line
  ("Page hint:" / "Endpoint hint:").

## Consequences

**Positive:**
- The bug exemplified by `confidential-loon` cannot recur — a declared
  type is now load-bearing.
- The form/validator vocabulary mismatch is gone — both sides now agree
  on outcome vs hint.
- Cmd polarity is explicit, not inferred from prose.

**Negative:**
- Hard cutover. Every existing brief in `specs/` and the repo-local
  `/plan-feature` skill must be migrated in the same change set
  (briefs 02 and 05 of `specs/ac-schema-v2/`).
- In-flight pods at the moment of cutover lose their AC results when the
  wrap-up SQL nulls legacy-shape `pods.acceptance_criteria` rows.
  Accepted: drain the queue before merging Gate 2 if you want to be safe.
- Two consumers we don't touch (the global `~/.claude/skills/plan-feature`
  install, and any out-of-tree spec branches) will continue to emit
  legacy shape until manually updated.

## Alternatives considered

1. **Keep `{test, pass, fail}` and just tighten the regex.** Rejected:
   fixes the immediate firing bug but leaves the overloaded `test` field
   and brittle `pass`-prose intact. The form/validator mismatch and the
   regex-scanning fragility would survive.
2. **Add `hint` as a fourth field while keeping `pass` / `fail`.**
   Rejected during the planning interview — the user pushed back that the
   field set was overstuffed. `polarity` as an enum is strictly more
   constrained than prose `pass:` strings.
3. **DB migration to columnar storage.** Rejected: ACs are nested
   collections, store cleanly as JSON, and a migration here costs more
   than it earns.
4. **Soft cutover with a back-compat reader.** Rejected: the failure
   modes of "schema v1 leaks into v2" (silent reclassification,
   regex-scanned polarity) are exactly what this ADR is undoing. A
   back-compat path keeps them alive.

## References

- Bug exemplar: pod `confidential-loon`, two `/pr-dashboard` ACs marked
  `decorative · web · none`.
- Spec: `specs/ac-schema-v2/`
- Hot path: `packages/daemon/src/validation/local-validation-engine.ts:1131-1297`
  (regex + classifier), `:1953-2023` (cmd executor), `:1563-1622` (LLM prompt).
- Form bug: `packages/desktop/Sources/AutopodUI/Views/Creation/CreatePodSheet.swift:545-594`
  (single-field row with misleading placeholder).
