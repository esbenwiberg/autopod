# ADR-019: `action_audit.pii_categories` lives outside the hash-chain payload

## Status
Accepted

## Context

`action_audit` carries an HMAC-style hash chain, introduced in
migration 064. Every row stores
`entry_hash = SHA-256(prev_hash || pod_id || action_name || params ||
response_summary || quarantine_score || created_at)`. The chain is
load-bearing for the operator-grade Safety story: the drill's
audit-chain integrity widget claims "every action call's audit row is
linked to its predecessor and the chain has not been tampered with."

Phase 4 needs PII pattern names per action-engine detection so the
drill can render a "PII by pattern" histogram. Today the column is a
single `pii_detected BOOLEAN` — we know "PII fired" but not "which
PII patterns fired."

There are three ways to add this:

1. **Add `pii_categories` to the hash payload.** Makes the column
   tamper-evident. But every existing row's hash was computed
   without it, so every existing chain becomes invalid the moment
   the migration lands. The chain integrity widget would
   immediately report "not valid" for every pod that has ever run
   an action — until rehashing all historical rows, which defeats
   the integrity claim entirely.
2. **Backfill rehash with a one-time migration.** Walk every row,
   recompute the hash with the new column, persist. Removes the
   tamper evidence retroactively (a malicious actor with DB write
   access could alter `pii_categories` AND rehash, indistinguishable
   from the migration). Also a non-trivial migration on a 100k-row
   table.
3. **Store `pii_categories` outside the hash payload (this ADR).**
   The column is a sidecar — readable, queryable, but not part of
   the chain. Existing chains stay valid; the column is best-effort
   metadata, not an attestation.

The trade-off only matters under a specific threat model: an attacker
with database write access who wants to hide *which PII patterns*
fired without altering the fact that PII fired (`pii_detected`
remains in the chain payload via the row's existence). That threat is
hypothetical and orthogonal to the operator-grade audience: Esben is
tuning his own pod fleet, not defending against insider tampering. The
audit-chain widget exists to detect *accidental corruption* and *gross
tampering* (e.g. removed rows, mutated `quarantine_score`), not to
attest to pattern-level PII inventory.

`purpose.md` explicitly scopes this drill as operator-grade, not
audit-grade: "the drill answers 'are my guardrails working and what
are they catching?', not 'can I attest to a regulator?'." Adding
`pii_categories` to the hash payload would over-engineer for the
audit-grade case while breaking the operator-grade case (immediate
"chain invalid" result on every existing pod).

## Decision

`pii_categories` is added to `action_audit` as
`TEXT DEFAULT NULL`, storing a JSON array of pattern names (e.g.
`'["api-key","email"]'`). The column is **deliberately excluded** from
`computeEntryHash`. The hash payload remains:

```
SHA-256(prev_hash || pod_id || action_name || params ||
        response_summary || quarantine_score || created_at)
```

Two integrity guarantees are preserved:

- **Existing chains stay valid.** No rehash, no migration data churn.
  Every pre-Phase-4 row's `entry_hash` continues to verify against
  the unchanged payload.
- **The fact of PII firing remains tamper-evident.** `pii_detected`
  influences `quarantine_score` (which IS in the payload), and the
  row's existence + linkage in the chain remains intact. An attacker
  cannot delete or reorder rows.

What is *not* tamper-evident is the specific list of pattern names.
That's an explicit trade-off, documented here and in `purpose.md` →
Glossary.

The aggregator (Brief 05) reads `pii_categories` for the pattern
breakdown. Pre-Phase-4 rows with `pii_detected=1, pii_categories=NULL`
bucket as pattern name `unknown`. The drill renders this bucket
explicitly so the operator can see how much legacy data is in the
window.

In parallel, `safety_events kind='pii'` rows carry per-pattern
detail (one row per pattern hit) for ALL six active sites including
the action-engine path. The action-engine path therefore has *both*
a sidecar JSON column on `action_audit` and one or more rows in
`safety_events` for the same detection. Brief 05 treats
`safety_events` as the canonical pattern source for forward rows;
`action_audit.pii_categories` is the secondary source AND the legacy-
bucket disambiguator (`pii_categories=NULL` → `unknown`). This dual
write is intentional: `safety_events` is the cross-source fleet view;
the action_audit column is the per-action-call breakdown surfaced
inline with that row.

## Consequences

**Easier:**
- Migration 093 is a single `ALTER TABLE ADD COLUMN` — no data
  rewrite, no chain churn.
- The audit-chain integrity widget continues to verify every
  existing pod's chain on day one. ADR-018's success signal stays
  reachable.
- Future column additions to `action_audit` follow the same pattern:
  if it's metadata for analytics, keep it out of the hash payload.

**Harder:**
- The pattern-list column is best-effort metadata, not an
  attestation. A reader who wants regulator-grade certainty about
  *which PII patterns* fired in the past would need a separate
  signing scheme. Out of scope for operator-grade.
- Brief 02 must include a hash-stability test that proves
  `entry_hash` is identical regardless of `pii_categories` value.
  Without that test, a future contributor could plausibly add the
  column to `computeEntryHash` thinking they're "improving"
  tamper-evidence, and silently break every existing chain.

**Committed to:**
- `computeEntryHash`'s payload definition is locked. Future columns
  on `action_audit` that need to be tamper-evident require a
  superseding ADR and a chain-rehash migration plan.
- The `unknown` pattern-name bucket is a permanent fixture of the
  drill's pattern breakdown. Phase 4 can never retroactively know
  what patterns pre-Phase-4 PII detections matched.
