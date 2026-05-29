# Claude Opus 4.8 canonical models

## Problem

Autopod does not know about Claude Opus 4.8 as the current Opus model, and the
existing short aliases `opus`, `sonnet`, and `haiku` are leaking into profile
defaults, docs, Desktop UI, and analytics-facing model identity. Accepting
`opus` as new input is now ambiguous: new profiles should move to
`claude-opus-4-8`, while historical `pods.model = 'opus'` rows describe work
that ran under the old Opus 4.7 alias mapping.

## Outcome

New Claude profile and pod writes use canonical model IDs with
`claude-opus-4-8` as the curated Opus default, while legacy profile aliases are
migrated and historical pod analytics remains anchored to Opus 4.7.

## Users

Autopod operators creating profiles or pods through CLI, API, Desktop, issue
watcher, or series workflows benefit from a single visible model spelling.
Reviewers and future pod agents benefit from explicit model identity contracts
that keep current defaults separate from historical analytics truth.

## Success signal

A new Claude profile or pod path resolves to `claude-opus-4-8` without accepting
short aliases as new input, and historical model analytics still coalesces old
`opus` pod rows to `claude-opus-4-7`.

## Non-goals

- Do not add Claude fast mode, effort controls, or mid-conversation
  system-message support.
- Do not rewrite historical `pods.model` rows.
- Do not remove short alias price rows from `model-pricing.json`; that follow-up
  is tracked as GitHub issue #139.
- Do not redesign the Desktop profile editor layout beyond model picker/default
  cleanup and stale `askAi.model` control removal.
- Do not add a network auto-fetch for provider prices.

## Glossary

- **Canonical model ID** - The full provider model identifier persisted for new
  writes, for example `claude-opus-4-8`.
- **Short alias** - Autopod's historical convenience names `opus`, `sonnet`, and
  `haiku`.
- **Current Opus** - The curated Opus choice for new Claude work after this
  feature: `claude-opus-4-8`.
- **Historical pod analytics** - Analytics over existing `pods.model` rows,
  where old short alias rows must continue to describe what actually ran.
- **Legacy pricing shim** - Short alias rows in `model-pricing.json` retained so
  raw historical cost lookup paths keep working until issue #139 is addressed.
- **Reviewer model** - `profile.reviewerModel`, the user-facing model used by
  AI review and the `ask_ai` escalation tool.
- **Legacy askAi model field** - `escalation.askAi.model`, a stored/wire field
  kept for compatibility but no longer the visible user-facing reviewer control.

## Reversibility

The schema/default/docs changes are reversible in code, but the profile
migration is a persistent data change. Back-out means applying a follow-up
migration that maps `claude-opus-4-8` profile defaults back to the prior desired
canonical ID, without touching `pods.model`. Because short aliases are rejected
for new writes after this feature, rollback must also decide whether to reopen
that public input contract.
