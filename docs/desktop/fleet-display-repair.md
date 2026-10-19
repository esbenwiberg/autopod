# Fleet display repair

Updated 2026-10-19. Fixes the two failures reproduced in
[connected acceptance](connected-acceptance.md).

Status: **implemented and proven against repaired local HTTP routes in the real
Preview app; hosted rollout and hosted recheck remain pending**. Keep PR #439
draft until that final boundary passes.

## Behavior

Compact discovery now includes an optional `display` envelope containing a
captured repository identity and structured agent-reported progress. Cards can
show the repository and `M3/9` before any detail request. The shared presentation
also supplies pod headers, repository search/filtering, History and Series.

Repository identity comes from the pod's active immutable launch snapshot or
phase, including retained snapshots. A legacy pod can use its captured profile
snapshot. Modern missing/invalid snapshots remain unavailable; they cannot fall
back to today's mutable profile. An explicit repository-free launch displays
Empty workspace. Older daemon responses without this envelope retain their
existing compatibility path.

SQLite extracts only the display fields; complete launch payloads and credential
objects are not loaded into Node for discovery. Remotes have bounded length;
userinfo, query and fragment are stripped. Progress text is bounded, and invalid,
negative, fractional, zero-total or out-of-range milestone counts become null.
An explicit null clears stale progress on a newer refresh. Missing envelopes on
older responses retain known captured identity through hydration. Equal-version
records can acquire display metadata after a daemon upgrade without reopening.

No migrations, new execution authority, network policies, account grants or
pod lifecycle changes are involved. The only daemon changes relative to current
main are these display projections and their regression tests.

## Evidence

- Real Preview connected to a disposable, read-only local Fastify server using
  the repaired pod routes and an in-memory migrated SQLite database. Three
  synthetic modern pods had two captured repositories and one empty workspace.
- Before selecting any pod, cards displayed acme/backend with M3/9, acme/web
  with M2/5 and Empty workspace with M1/3. The detail column still said Select a pod.
- Clicking acme/backend reduced the fleet to one pod. Opening it retained the
  captured repository in its header and the same milestone token on the card.
- History showed both repositories, Empty workspace and the reported counts.
  Standalone Series showed both repository identities and member progress.
- Native captures were inspected and saved at `/private/tmp/`:
  `autopod-fleet-repair-initial-native.png`,
  `autopod-fleet-repair-filter-detail-native.png`,
  `autopod-fleet-repair-history-native.png`,
  `autopod-fleet-repair-series-native.png`.
- The disposable local connection was removed, Preview restored to Hosted
  acceptance, and the local server stopped. No hosted data was modified.

Validation: 154 affected daemon route/repository tests and 420 shared tests pass;
full TypeScript build and typecheck pass; lint and secret scanning pass. The
complete isolated desktop suite and signed Preview build pass; additional
upgrade/refresh cases pass in PodStoreFleetTests. Exact final counts are recorded
in the PR validation update.

The local Node 24 SQLite finalizer crashed during testing. Rebuilding the locked
better-sqlite3 dependency for Node 22 (matching CI) completed all 154 tests; none
were skipped. Lint initially included copied upstream renderer files in the
Preview output; `build-preview` now has the same generated-output exclusion as
the existing desktop `build` directory. Application source remains linted.

The local server exercised the actual GET handlers and SQLite projection, with
synthetic records and stubbed execution services. It rejected mutations and ran
no provider work. It did not implement unrelated schedules or preview services;
their fixture loader alerts are not evidence about production behavior. This
proof does not establish that the existing hosted daemon has the new contract.
