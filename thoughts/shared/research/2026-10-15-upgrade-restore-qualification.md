---
date: 2026-10-15T20:48:06.642545+02:00
researcher: Codex
git_commit: 913c06220282b0b0970282583a223b1949a0b10b
branch: codex/reliability
repository: autopod
topic: "Existing database upgrade and restore qualification"
status: complete
last_updated: 2026-10-15
last_updated_by: Codex
---

# Upgrade and restore qualification

## Current implementation

The production migration runner rejects duplicate numeric prefixes before applying
migrations, including collisions below the database's current maximum. It refuses
the unpublished native 151–163 lineage. Populated disk databases with pending
cutovers require the asynchronous backup-aware runner; startup awaits it. Each
migration is transactional; FK toggles occur outside transactions. There is no
down migration path. See packages/daemon/src/db/migrate.ts:23–225 and index.ts:246.
Read-only filename inventory: 195 SQL files, maximum207, no duplicate prefixes;
gaps80,81,154–163. This is newer than the general AGENTS migration warning.

Cutover backup uses SQLite's online backup, private staging, source identity and
inode checks, disk headroom, a120-second deadline, integrity/FK checks, checksum,
all-table watermark and receipt publication. Cutover snapshots are not pruned.
Backup-directory search may select an existing ancestor directory; a fixture's
own backups directory determines isolation. See db/cutover-backup.ts:23–122.

verifyBackupRestore copies a backup into a disposable directory and checks its
caller-supplied expected source identity, freshness, checksum, integrity/FKs,
watermark and rolled-back write probe. It removes the copy in finally. The built
verify-backup CLI returns0/1/2 for verified/failed/arguments and does not activate
a restored database. See db/backup-verification.ts:83–137 and
 db/verify-backup-cli.ts:4–31. Configuration cutover has a separate private DB/key
restore-candidate path with post-cutover fingerprint checks; activation is external.

## Existing coverage

- db/managed-migration-compatibility.test.ts:10: real disk schemas150/152/153,
  retained native and managed rows, integrity/FKs.
- Same file:119,153: reject unpublished lineage unchanged; upgrade native182
  without migration153, repair the missing managed table, repeat idempotently.
- pods/completion-journal.test.ts:131: schema171 decisions and schemas139/141
  unanswered decisions survive upgrade/reopen.
- pods/retained-history-upgrade.test.ts:11: schema180 event/progress retention.
- db/cutover-backup.test.ts:47: synthetic destructive cutover preserves committed
  WAL/rowids and supports isolated restore plus built CLI verification. Other
  cases reject changing source/migrations, low disk and receipt failures.
- db/backup.test.ts:51: current task-run backup and isolated restore retain newer
  active data; wrong-source, stale and corrupted snapshots are rejected.
- db/reconcile-native-checkpoint.test.ts:19: legacy151/158/163 conversion into
  new verified copies, including built CLI and retained-row checks.
- configuration/conversion-cli.test.ts:16: offline built conversion rehearsal,
  apply, repeat and restore-candidate behavior.

createTestDb directly executes fixture migration SQL; it does not exercise the
production runner's backup/version qualification (test-utils/mock-helpers.ts:107).

## Qualification boundary present in the sources

The native182 disk fixture has retained pod/guidance rows and pending real
cutovers193/194/198/200. Production-generated backups can be verified independently,
then copied into another disposable path and upgraded through the same current
migration chain. Existing tests establish these pieces separately; the inspected
suites do not express this complete historical-upgrade/actual-backup/re-upgrade
round trip as one scenario.

## Environment and limits

Node22/pnpm9.15.4 and better-sqlite3; writable temporary disk with backup headroom.
Build daemon dependencies before suites invoking dist binaries. Docker, provider
calls and daemon startup are not needed. Research performed no live DB reads or
mutations and ran no qualification tests. Root verified the runner, backup,
verification, historical upgrade and cutover tests after agent research.

## Open questions

No claim is made about an officially supported historical-release matrix,
representative performance sizes or released old-client/new-daemon combinations.
Those are separate scope choices, not prerequisites for the known schema182
qualification boundary.
