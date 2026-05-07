# ADR-020: Snapshot resolved network policy on `pods` row at provisioning

## Status
Accepted

## Context

Phase 4's Safety drill includes a "network-policy distribution"
section: a count of pods in the trailing window bucketed by
`'allow-all' | 'restricted' | 'deny-all'`. The operator wants to see
"of the pods that ran in the last 30 days, how were their network
egress policies set."

The natural source is `profiles.network_policy` (migration 004) —
this is where the field lives today, and it's the value that
`docker-network-manager.ts` reads at pod start to install the
container's iptables rules. But there are two complications:

1. **Profiles are mutable.** A profile's `network_policy` can change
   at any time via the desktop profile editor. A pod that ran two
   weeks ago under `restricted` may now be associated with a
   profile whose policy has been flipped to `allow-all`. Aggregating
   today over `pods.profile_id JOIN profiles` would attribute
   historical pods to the *current* profile state, not the state at
   the time they ran. Historical aggregates would silently drift
   every time the operator edits a profile.
2. **Profile inheritance.** A derived profile inherits
   `network_policy` from its base via the `extends` chain
   (`profiles/inheritance.ts`). The "effective" policy at pod startup
   is the post-merge value, not the literal column on the immediate
   profile. The aggregator would have to re-resolve inheritance for
   every pod read — slow, and worse, it re-resolves against the
   *current* base profile, compounding the drift problem.

Three alternatives were considered:

- **Option A: aggregate over the live profile chain.** Computes
  cheap per pod read but historical aggregates drift on profile
  edits, contradicting the "no backfill of historical metrics"
  cross-cutting principle in the master plan.
- **Option B: snapshot the resolved policy on the `pods` row at
  provisioning** — a new `pods.network_policy_resolved` column
  written once, immutable thereafter. Future profile edits do not
  affect historical aggregates.
- **Option C: log the resolved policy to a separate
  `pod_provisioning_log` table.** Introduces a new table for one
  field; cardinality always equals `pods` count. Pure overhead.

Option B aligns with how `pods` already snapshots
`runtime`, `output_mode`, and other fields that derive from the
profile but are persisted on the pod row for historical fidelity. It
also matches the pattern established in Phase 1 (ADR-016) where
forward-only data is the norm and historical reconstruction is not
attempted.

## Decision

Add `pods.network_policy_resolved TEXT DEFAULT NULL` (migration 094).
Write the post-inheritance, effective network policy value once at
provisioning time, in `pod-manager.ts`, after profile inheritance is
resolved and before the container spawns. Use the existing
`podRepository.update(podId, { networkPolicyResolved: <value> })`
path; no raw SQL from `pod-manager.ts`.

Values: `'allow-all' | 'restricted' | 'deny-all'`. Mirror the literal
strings used by `docker-network-manager.ts` exactly to avoid bucket
drift in the aggregator.

Pre-migration pods (every pod that ran before this column existed)
remain `network_policy_resolved = NULL`. The drill's aggregator
buckets these under `'unknown'` — the operator sees the legacy
bucket explicitly so they can judge how much of the window is pre-
Phase-4 data.

The recovery / resume path **must not overwrite** an existing
`network_policy_resolved` value. The whole point of the snapshot is
historical immutability — if a pod is resumed via
`recoveryWorktreePath`, the original snapshot stands. Brief 03 guards
this: write only when the column is NULL or it's the first
provisioning pass.

The Profile-side `network_policy` column stays as-is. It remains the
source of truth for *new* pod provisioning. The pod-side column is
only ever read by the analytics drill.

## Consequences

**Easier:**
- Historical aggregates are stable. Editing a profile's
  `network_policy` today does not change last month's
  network-policy distribution.
- The aggregator query is a one-table read on `pods`; no JOIN, no
  inheritance resolution, no per-row code execution.
- Pattern matches existing snapshot columns (`runtime`,
  `output_mode`); contributors recognise the shape.

**Harder:**
- Two columns hold "the network policy" — one on `profiles` (live,
  mutable) and one on `pods` (snapshot, immutable). Code reading
  the policy must pick the right one for its purpose:
  - For *runtime decisions* (what to install in iptables), read the
    live profile chain — same as today.
  - For *historical analytics*, read `pods.network_policy_resolved`.
  Drift between them after-the-fact is by design, not a bug.
- Pre-migration pods bucket as `unknown` forever. The drill ramps
  up over time; for the first ~30 days post-migration, the
  `unknown` bucket dominates the distribution.
- The recovery path needs an explicit guard against re-stomping
  the snapshot. A future contributor who refactors provisioning
  could plausibly re-write the column on every pass; Brief 03's
  test gates against that regression.

**Committed to:**
- The literal string values `'allow-all' | 'restricted' | 'deny-all'`
  are now part of the Safety drill's contract. Renaming any of them
  in `docker-network-manager.ts` requires a coordinated migration
  that updates `network_policy_resolved` values too.
- The snapshot is one-shot: once written, never re-written. Adding a
  "current policy at re-resume" column would require a separate
  field, not an overwrite of the existing snapshot.
