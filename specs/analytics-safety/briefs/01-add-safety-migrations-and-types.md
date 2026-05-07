---
title: "Add safety migrations + shared types"
acceptance_criteria: []
touches:
  - packages/daemon/src/db/migrations/
  - packages/shared/src/types/analytics.ts
  - packages/shared/src/index.ts
does_not_touch:
  - packages/daemon/src/safety/
  - packages/daemon/src/actions/
  - packages/daemon/src/api/
  - packages/daemon/src/pods/
  - packages/daemon/src/issue-watcher/
  - packages/desktop/
---

## Task

Lay the durable foundation for the Safety drill: four SQLite migrations
and the `SafetyAnalyticsResponse` contract in `@autopod/shared`. Every
later brief depends on this; nothing here writes data or wires routes.

The four migrations:

1. **`092_safety_events.sql`** — new `safety_events` table with the
   exact DDL in `design.md` → "`safety_events` schema". One row per
   pattern hit (so `(action_response, kind=injection, threats=2)` writes
   two rows). Three indexes on `created_at`, `(kind, created_at)`, and
   `pod_id`.

2. **`093_action_audit_pii_categories.sql`** —
   `ALTER TABLE action_audit ADD COLUMN pii_categories TEXT DEFAULT NULL`.
   Stores a JSON array of pattern names, populated forward by Brief 02.
   Pre-existing rows stay NULL → bucketed as `unknown` in the breakdown.
   **Critical:** this column is deliberately outside the audit-chain
   hash payload (ADR-019). No change to `compute_entry_hash` or the
   migration that introduced the chain. Add a SQL comment in the
   migration body restating this.

3. **`094_pods_network_policy_resolved.sql`** —
   `ALTER TABLE pods ADD COLUMN network_policy_resolved TEXT DEFAULT
   NULL`. Snapshot column written by Brief 03 at provisioning time
   (ADR-020). Pre-migration pods stay NULL → bucketed as `unknown` in
   the drill.

4. **`095_audit_chain_verifications.sql`** — new
   `audit_chain_verifications` table per the DDL in `design.md`. Tiny
   append-only log of fleet-wide verification runs. Brief 05's
   POST `/audit-chain/verify` writes here; Brief 05's
   GET `/pods/analytics/safety` reads the latest row.

Then add the shared types — exact shape locked in `design.md` →
Contracts:

- `SafetyEventKind`, `SafetyEventSource`, `NetworkPolicyBucket` unions.
- `SafetyAnalyticsResponse` interface.
- `AuditChainVerifyResponse` interface.

Re-export from `packages/shared/src/index.ts`.

## Touches

- `packages/daemon/src/db/migrations/092_safety_events.sql` (new).
- `packages/daemon/src/db/migrations/093_action_audit_pii_categories.sql`
  (new).
- `packages/daemon/src/db/migrations/094_pods_network_policy_resolved.sql`
  (new).
- `packages/daemon/src/db/migrations/095_audit_chain_verifications.sql`
  (new).
- `packages/shared/src/types/analytics.ts` — append the new types
  alongside `CostAnalyticsResponse` / `ReliabilityAnalyticsResponse` /
  `QualityAnalyticsResponse`.
- `packages/shared/src/index.ts` — re-export.

## Does not touch

- `packages/daemon/src/safety/` — Brief 02 creates this directory.
- `packages/daemon/src/actions/` — `pii_categories` write happens in
  Brief 02. Hash payload must not change.
- `packages/daemon/src/api/` — endpoints in Brief 05.
- `packages/daemon/src/pods/` — `network_policy_resolved` write in
  Brief 03.
- `packages/daemon/src/issue-watcher/` — instrumentation in Brief 04.
- `packages/desktop/` — Brief 06.

## Constraints

- **Migration prefix**: highest existing prefix is `091`. Use
  `092 / 093 / 094 / 095` exactly. Never reuse a prefix (silent bug per
  `CLAUDE.md` "CRITICAL — migration numbering"). Re-check
  `ls packages/daemon/src/db/migrations/ | tail -5` immediately before
  writing the files in case Brief 04 or another concurrent change
  landed first.
- **Hash payload immutability**: `pii_categories` is NOT included in
  `computeEntryHash` (ADR-019). Existing chain semantics must keep
  verifying after this migration. Do not touch
  `audit-repository.ts` / `audit-repository.test.ts` in this brief —
  Brief 02 owns those edits.
- **Indexes** on `safety_events`: include the three listed in the
  design doc. Aggregation queries hit `(kind, created_at)` and
  `(pod_id, created_at)` shapes; the indexes pay for themselves.
- **Type names** mirror `design.md` → Contracts verbatim. Don't rename.
  Brief 06 mirrors them in Swift; drift will silently break decoding.
- **`SafetyEventSource` includes `'event_payload'`** even though it's
  unwired today. Reserved for the day `event-bus.ts` content
  processing is enabled in production. Documented in `purpose.md` →
  Non-goals.
- **No data writes**: this brief does not insert into any new table. A
  fresh `createTestDb()` should produce empty `safety_events` and
  `audit_chain_verifications`.

## Test expectations

- **Migrations apply cleanly**: `createTestDb()` from
  `packages/daemon/src/test-utils/mock-helpers.ts` runs all migrations
  on each call. Add a one-off test or assert via an existing
  `createTestDb()`-using test that the four new tables/columns exist.
  Suggested: extend an existing migration smoke test if one exists, or
  drop a small assertion into `db/migrate.test.ts` if present.
- **Type compilation**: `npx pnpm --filter @autopod/shared build` must
  succeed. The `analytics.ts` types are structural, so the test budget
  is just "tsc compiles".
- **Hash chain regression**: `audit-repository.test.ts` must still pass
  unchanged. (You're not editing it, but the migration adds a column to
  the `action_audit` table the chain operates on. The default-NULL
  column does not appear in the hash payload, so the chain stays
  valid.)
- **Index existence**: a small `pragma_index_list` query in test ground
  is fine — but only if the project already has precedent for it. If
  not, skip; the SQL files speak for themselves.

This brief ships zero `acceptance_criteria` because the only
observables are "migrations apply" and "types compile" — both already
gated by the validation pipeline (`./scripts/validate.sh`). The diff
reviewer covers schema correctness; padding the frontmatter with
no-ops would create false confidence per `/plan-feature` guidance.

## Risks / pitfalls

- **Reusing a migration prefix.** This is the silent-bug class
  highlighted in `CLAUDE.md`. Verify with `ls -1
  packages/daemon/src/db/migrations | tail -5` immediately before
  creating the four files.
- **Adding `pii_categories` to the hash payload by accident.** The
  hash live elsewhere; this brief touches only the migration. Do not
  edit `audit-repository.ts` in this brief — even if the diff looks
  trivial, that's Brief 02's territory and conflating them risks a
  hash regression slipping in.
- **Forgetting to re-export the types.** Brief 06 (desktop) mirrors
  the contract from the shared package via the daemon's TypeScript
  output; if the type isn't re-exported it appears available locally
  in Brief 05 (same package) but breaks downstream consumers.
- **SQLite default expression syntax**: `DEFAULT (strftime('%Y-%m-%d
  %H:%M:%S','now'))` requires the parens. Mirror the existing pattern
  in `packages/daemon/src/db/migrations/064_*.sql`.

## Wrap-up

Before finishing:
1. Run `/simplify` and address its findings.
2. Re-run `./scripts/validate.sh`; build + lint + tests must pass.
3. Commit and push.
