---
title: "Add pending_fix_feedback table + drop deprecated profile columns"
depends_on: []
acceptance_criteria:
  - type: cmd
    outcome: "test -f packages/daemon/src/db/migrations/099_single_fix_pod.sql && grep -E 'CREATE TABLE pending_fix_feedback' packages/daemon/src/db/migrations/099_single_fix_pod.sql → exit 0"
    hint: "test -f packages/daemon/src/db/migrations/099_single_fix_pod.sql && grep -E 'CREATE TABLE pending_fix_feedback' packages/daemon/src/db/migrations/099_single_fix_pod.sql"
    polarity: exit-zero
  - type: cmd
    outcome: "! grep -nE 'reuseFixPod|fixPodCooldownSec' packages/shared/src/types/profile.ts packages/shared/src/index.ts → exit 0 — no references in shared types"
    hint: "! grep -nE 'reuseFixPod|fixPodCooldownSec' packages/shared/src/types/profile.ts packages/shared/src/index.ts"
    polarity: exit-zero
touches:
  - packages/daemon/src/db/migrations/099_single_fix_pod.sql
  - packages/daemon/src/pods/fix-feedback-repository.ts
  - packages/daemon/src/pods/fix-feedback-repository.test.ts
  - packages/shared/src/types/profile.ts
  - packages/shared/src/constants.ts
does_not_touch:
  - packages/daemon/src/pods/pod-manager.ts
  - packages/daemon/src/api/routes/
  - packages/desktop/
---

## Task

Land the schema and shared-types backbone for the single-fix-pod design.
This brief is the foundation: briefs 02 (lifecycle), 03 (API), and 05
(desktop UI) all build on it. Brief 04 (desktop profile cleanup) takes
the type removal in `packages/shared` and follows through to Swift.

### Migration `099_single_fix_pod.sql`

Schema-version note: the highest existing migration is `098_pod_running_at.sql`.
Use prefix `099` exactly. The `PreToolUse` migration-prefix hook will block
a colliding number locally. Cross-branch collisions need manual rebase.

The migration must:

1. **Create `pending_fix_feedback`**:

   ```sql
   CREATE TABLE pending_fix_feedback (
     id TEXT PRIMARY KEY NOT NULL,
     pod_id TEXT NOT NULL REFERENCES pods(id) ON DELETE CASCADE,
     message TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX idx_pending_fix_feedback_pod_id
     ON pending_fix_feedback(pod_id, created_at);
   ```

   The composite index supports `peek` / `drain` ordering and the cheap
   `count(pod_id)` lookup the serialiser uses.

2. **Drop deprecated profile columns**:

   ```sql
   ALTER TABLE profiles DROP COLUMN reuse_fix_pod;
   ALTER TABLE profiles DROP COLUMN fix_pod_cooldown_sec;
   ```

   These are nullable as of migrations `077` and `090`. No backfill. No
   replacement.

3. **Pre-migration DB snapshot**: the migration runner already supports
   this pattern (precedent: `091_drop_screenshot_blobs.sql` in
   `specs/proof-of-work-screenshots/`). The runner must copy the live DB
   to `packages/daemon/backups/<timestamp>-pre-single-fix-pod.db` before
   running this file. Do not modify the runner if the precedent already
   covers it; do extend it if there is a `pre-snapshot` allowlist.

### `FixFeedbackRepository`

Create `packages/daemon/src/pods/fix-feedback-repository.ts` exactly
matching the contract in `design.md` → Contracts.

Constructor takes the shared `Database` instance. All methods are
synchronous (`better-sqlite3` is sync).

`drain` MUST use a single SQLite transaction:

```ts
drain(podId: string): FixFeedback[] {
  return this.db.transaction(() => {
    const rows = this.db.prepare(
      `SELECT id, pod_id AS podId, message, created_at AS createdAt
       FROM pending_fix_feedback
       WHERE pod_id = ?
       ORDER BY created_at ASC`
    ).all(podId) as FixFeedback[];
    this.db.prepare(
      `DELETE FROM pending_fix_feedback WHERE pod_id = ?`
    ).run(podId);
    return rows;
  })();
}
```

This is the **delete-after-running** contract: callers (brief 02) invoke
`drain` only at the moment the consuming fix-pod iteration transitions
to `running`. If the daemon crashes between `drain` and `running`, the
SQLite transaction rolls back and messages remain queued.

`enqueue` generates a UUID for `id` (use the `randomUUID` import already
in use elsewhere in the daemon, e.g. `pod-repository.ts`).

`peek` returns rows in the same `created_at ASC` order; **does not**
delete.

`count` is a single-statement `SELECT COUNT(*)` — never `peek().length`,
which would over-fetch for the chip rendering path.

### Tests (`fix-feedback-repository.test.ts`)

Use `createTestDb()` from `packages/daemon/src/test-utils/mock-helpers.ts`.
Each test starts with a fresh in-memory DB and an inserted test profile
+ pod (use `insertTestProfile` + the existing pod-insert helpers).

Cover:

- `enqueue` returns a row with a generated UUID; subsequent `peek` finds
  it; `count` returns 1.
- Two enqueues — `peek` returns both in append order; `count` = 2.
- `drain` returns the same rows `peek` does; subsequent `peek` returns
  `[]`; `count` returns 0.
- `drain` on an empty queue returns `[]` without throwing.
- `enqueue` after `drain` — the new row is the only one returned by
  `peek`.
- Concurrent simulation: in a synchronous loop, interleave `enqueue` and
  `drain` calls; assert the message-set lost between drains matches the
  set fed in. (Real concurrency is impossible — single-process daemon —
  but this guards the transaction shape.)

### Shared types (`packages/shared`)

- `src/types/profile.ts`: remove the `reuseFixPod?: boolean` and
  `fixPodCooldownSec?: number` fields from the `Profile` interface AND
  from the Zod schema (`profileSchema`). Drop-on-cutover; no
  `.optional()` left behind.
- `src/types/pod.ts`: add `queueLength?: number` to the `Pod` type. Add
  the `SpawnFixResponse` discriminated union exactly matching the
  contract in `design.md` → Contracts.
- `src/constants.ts`: change `DEFAULT_MAX_PR_FIX_ATTEMPTS = 2` to
  `DEFAULT_MAX_PR_FIX_ATTEMPTS = 5`.
- `src/index.ts`: export `FixFeedback` and `SpawnFixResponse` so the
  daemon and desktop can import them.

### What this brief MUST NOT touch

- `pod-manager.ts` — brief 02 owns the consumer.
- `api/routes/pods.ts` — brief 03 owns the producer.
- Anything in `packages/desktop/` — briefs 04 + 05 own the desktop
  changes.

Keeping these contracts tight is what enables the gate-2 parallel
execution.

## Test expectations

- New unit tests: `fix-feedback-repository.test.ts` covers all repository
  methods. Vitest, runs against `createTestDb()`. Aim for 100% line
  coverage of the new file — it's small and worth it.
- Existing migration runner tests stay green. If the runner needs to be
  extended for the pre-migration snapshot, add coverage there too.
- Zod schema tests in `packages/shared` stay green after the removed
  fields disappear. The schema must still validate older profile JSON
  that happened to carry `reuseFixPod: false` (treat extra keys as
  ignored per the existing schema convention, or strip-on-parse — match
  whatever the existing schema does).
- No daemon integration tests in this brief — that's brief 02.
