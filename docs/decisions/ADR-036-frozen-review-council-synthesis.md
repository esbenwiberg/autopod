# ADR-036: Frozen review council synthesis is source-backed

## Status

Accepted

## Decision

The standard full review remains the first gate. A failed standard review, or an explicitly deep full review, triggers a frozen five-axis council. All axes receive the same immutable packet identity, reviewed HEAD, cumulative diff hash, bounded executable contract and validation context.

Council synthesis may accept, reject, or merge only source-addressable candidate findings. It cannot invent claims, paths, severities, evidence, or remediations. If synthesis is unavailable or invalid, deterministic deduplicated union preserves every valid candidate; unavailable required axes fail closed. This ADR does not introduce cross-attempt fixed/open/regressed lifecycle semantics.
