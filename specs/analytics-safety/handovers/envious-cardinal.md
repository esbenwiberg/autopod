# Handover — envious-cardinal (Brief 01: Migrations + Shared Types)

## What was built

Four SQLite migrations and the `SafetyAnalyticsResponse` contract in `@autopod/shared`.

- **`092_safety_events.sql`** — `safety_events` table with 3 indexes (`created_at`, `(kind, created_at)`, `pod_id`). One row per pattern hit per detection event.
- **`093_action_audit_pii_categories.sql`** — `ALTER TABLE action_audit ADD COLUMN pii_categories TEXT DEFAULT NULL`. Populated forward by Brief 02. Deliberately outside the hash payload (ADR-019).
- **`094_pods_network_policy_resolved.sql`** — `ALTER TABLE pods ADD COLUMN network_policy_resolved TEXT DEFAULT NULL`. Written at provisioning by Brief 03 (ADR-020).
- **`095_audit_chain_verifications.sql`** — `audit_chain_verifications` table. Written by Brief 05's `POST /audit-chain/verify`, read by `GET /pods/analytics/safety`.
- **`packages/shared/src/types/analytics.ts`** — appended `SafetyEventKind`, `SafetyEventSource`, `NetworkPolicyBucket`, `SafetyAnalyticsResponse`, `AuditChainVerifyResponse`.
- **`packages/shared/src/index.ts`** — re-exported all 5 new types.
- **`packages/daemon/src/db/migrate.test.ts`** — added 4 migration smoke tests (share a `beforeEach` DB) confirming tables/columns exist and tables start empty.

## Deviations from brief

None. All files land exactly where the brief specifies. No data writes anywhere.

## Gotcha discovered: semicolons in SQL comments break `mock-helpers.ts`

`createTestDb()` in `packages/daemon/src/test-utils/mock-helpers.ts` splits migration SQL on `;` and re-executes each chunk. Any semicolon inside an inline SQL comment (e.g. `-- 0..1 for injection; NULL for pii`) splits the CREATE TABLE mid-statement and causes `SqliteError: incomplete input` in ALL tests that call `createTestDb()`.

**Fix applied:** removed semicolons from inline comments in `092_safety_events.sql` and `095_audit_chain_verifications.sql`. Future migration authors must not put semicolons inside `--` comments.

## Files owned — do not modify without good reason

- All four `.sql` migration files (schema is now durable/forward-only)
- `packages/shared/src/types/analytics.ts` — types are the cross-pod contract; Brief 06 (Swift) mirrors them verbatim. Any rename breaks Swift decoding silently.

## Contract notes for downstream pods

- `SafetyEventSource` includes `'event_payload'` even though it's unwired. Brief 02–04 must not add new source values beyond the 7 already in the type.
- `pii_categories` column on `action_audit` is TEXT (JSON array). Brief 02 writes it as `JSON.stringify(string[])`. Do not include it in `computeEntryHash` — ADR-019.
- `network_policy_resolved` on `pods` is TEXT nullable. Brief 03 writes `'allow-all' | 'restricted' | 'deny-all'`. NULL means pre-migration pod → `'unknown'` bucket in drill.
- `AuditChainVerifyResponse.firstMismatch` shape: `{ podId: string; rowId: number; reason: string }` — Brief 05 must produce this exact shape.
