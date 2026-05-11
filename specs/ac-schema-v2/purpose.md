# Purpose — AC schema v2

## Problem

The `AcDefinition` shape (`{ type, test, pass, fail }`) confuses both humans
and the validator:

1. **`test` is overloaded.** In the daemon's validation engine it means "the
   criterion description". In the desktop create-pod form it means "the
   technical hint" (URL / selector / shell command). The form's placeholder
   even reads "page path or selector to check" — so users like `ewi` enter
   `/pr-dashboard` as the *entire criterion*, with no outcome to validate
   against.
2. **The slash-command banlist over-matches.** `COMMAND_LIKE_AC_PATTERNS`
   includes the regex `/^\/[a-z]/i`, which catches any criterion starting
   with a lowercase slash. `classifyAcTypes` then force-converts those ACs
   to `type: none` *regardless of declared type*. The bug observed in pod
   `confidential-loon` (two `/pr-dashboard` ACs marked "decorative · web ·
   none") is the direct consequence.
3. **`pass` / `fail` are regex-scanned.** `executeCmdChecks` reads the
   `pass:` string with `NEGATIVE_HINTS` to decide expect-output-vs-no-output.
   That's clever and brittle. A small typo flips the polarity silently.

## Outcome

A manually-created AC with `type: web` and outcome
`/pr-dashboard renders with header` survives `classifyAcTypes` as `web`
(not `none`), is rendered in the macOS app with a clear outcome + hint
distinction, and fires through the LLM-driven browser path during
validation. Cmd polarity is set by an enum, not inferred from prose.

## Success signal

1. The `confidential-loon`-style failure cannot recur: a `type: web` AC
   whose outcome begins with `/<word>` is preserved by `classifyAcTypes`
   and dispatched to `generateAcInstructions` for browser execution.
2. Users opening the AC editor in the macOS desktop app see a stacked
   two-row layout: an "outcome" field on top (always required) and a
   type-aware "hint" field underneath. A `cmd` row also exposes a polarity
   picker.

Both signals are tied to acceptance criteria in briefs 03 and 04
respectively.

## Users

- **Pod creators (humans, via the desktop app)** — currently misled by the
  single-field form into entering technical hints as full criteria.
- **The plan-feature skill (executing on Claude Code instances)** — emits
  brief frontmatter. Currently teaches the old `{test, pass, fail}` shape.
- **The autopod daemon (during validation)** — consumes ACs from DB JSON
  and brief frontmatter; needs to read the new fields without back-compat
  cruft.
- **Spec authors writing briefs by hand** — fewer than the above two, but
  worth keeping in mind: the YAML key rename is the only thing they have to
  internalise.

## Non-goals

- **No DB schema migration.** ACs live as a JSON TEXT blob in
  `pods.acceptance_criteria`. We rewrite the parser, not the schema.
- **No back-compat parser path.** Hard cutover. Brief 02 migrates every
  existing spec; brief 01's parser throws loudly on legacy keys.
- **No new AC types.** `none | api | web | cmd` still spans the space.
- **No change to validation phases.** Build / health / smoke / AI-review
  remain. We're changing how individual ACs are parsed and dispatched, not
  the surrounding engine.
- **No retroactive backfill of completed pods.** Existing
  `pods.acceptance_criteria` rows with the legacy shape get nulled at
  cutover (accepted risk — see Reversibility).

## Glossary

- **AC / Acceptance criterion** — a single rule the validation engine
  checks after the agent finishes. One pod has zero or more.
- **Outcome** (new) — the user-visible string that names what should be
  true. Was called `test` in v1. Always required.
- **Hint** (new) — an optional technical pointer the LLM and executors
  consume: a URL path, a CSS selector, an HTTP endpoint, or a shell
  command. Type-aware semantics.
- **Polarity** (new) — `cmd`-only enum: `expect-output` |
  `expect-no-output` | `exit-zero`. Replaces the regex-scanned `pass:` /
  `fail:` strings.
- **Type** — `none | api | web | cmd`. Unchanged.
- **Decorative** — the desktop tag rendered when an AC was reclassified to
  `none`. Will continue to exist; we just stop force-routing declared
  `web/api` ACs through it.

## Reversibility

Hard-to-reverse: yes — the cutover removes `pass:` / `fail:` from the YAML
contract. Any branch still using the v1 shape will fail to parse against
trunk.

Rollback strategy: revert briefs 01–05 (atomic commits per brief). The
nulled `pods.acceptance_criteria` rows from in-flight pods at cutover
**cannot be recovered** — accepted risk per the greenlight decision
(`in-flight-pods: null-ok`). The wrap-up SQL one-liner only nulls rows
matching the legacy JSON shape; new-shape rows are untouched.
