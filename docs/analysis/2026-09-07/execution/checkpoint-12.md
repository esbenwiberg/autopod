# Checkpoint 12: coexistence with the deployed managed schema

Starting commit: c6a98441. No live migration or other external mutation.

The local reproduction built the managed producer's schema 150, inserted native and managed sentinel data, then ran our migrations. It failed because MAX(version)=150 silently skipped our 142–149 tables. A second reproduction showed duplicate files with one prefix applied the first business migration before failing on the second schema-version insert. This corrects the older documentation's description of the exact fresh-database failure mechanism; either case is unsafe.

The managed schema definitions 142–150 are retained byte-for-byte from the separate producer worktree as an inert schema compatibility baseline. The same bytes are frozen in test fixtures. No managed routes, execution code, grant, or enablement configuration was imported. Our unpublished additions move to 151–158; the mapping is recorded. This avoids missing prerequisite tables on fresh installs and preserves deployed managed records during upgrades. The migration runner rejects duplicate numeric prefixes in a pre-scan, including collisions below the current version, and logs the actual maximum applied version rather than current version plus count.

Eleven migration/ledger/backup suites passed 85 tests. The final compatibility, runner and task-ledger suites passed 37 after adding exact baseline-byte and already-applied-prefix checks. Native malformed legacy content, managed workspace rows and managed source BLOBs survive the upgrade; foreign-key and integrity checks pass. Predecessor-version tests now reference the renumbered native additions.

The prefix audit refreshed origin/main and inspected 262 Git refs plus all five registered Autopod worktrees, including untracked migration files. No other ref has a prefix at or above 151; the managed worktree ends at 150 and this branch at 158. Remote migration-file bytes remain unverified pending the explicit read-only SSH metadata approval. Prior local experimental databases from this unpublished branch used the colliding numbers and must be recreated; none was deployed by this task. Earlier checkpoint receipts retain their historical numbering.

Next: commit this coherent revision and execute the full required validation pipeline. Resolve its failures before final acceptance, then continue every remaining implementation criterion. The goal and native/live verification remain open.
