# Validation-held local Docker controls

An authenticated human can preview `ap stop-validation-held <full-pod-id> --json`
or open **Recovery → Stop and retain**. Preview does not stop anything. It lists
exact resources, present observed state and retained data, or a specific blocker.
Ordinary Kill/Delete remain fenced. No live incident resources were inspected or
changed while implementing this control.

Stop requires an explicit reviewed generation, binding, daemon identity, reason,
request ID and new operator-owned `--request-file` with `--apply`. The CLI saves
and syncs this journal before sending one POST. Desktop also journals before
dispatch. `--observe --request-file <file>` reads only the exact receipt;
`--reconcile --request-file <file>` is an explicit reconciliation by the original
authenticated actor. A lost reply is unknown, never permission for another key.
Once Stop has been dispatched, reconciliation observes independently and never
dispatches it again. A still-running resource after an uncertain Stop remains
blocked for investigation. Opening Recovery or observing never starts execution.

Stop preserves the worktree, reports, fleet card, original validation result and
hold. It records present stopped/absent execution only; it does not establish
historical command exit, validation settlement, final-file preservation, retry
permission, publication or delivery. The existing retained-finalization ledger
provides permanent task/resource/path custody and startup fences.

**Discard and delete** is a separate preview and data-loss confirmation through
`ap cleanup-retained <full-pod-id> --json` and its existing `--apply` protocol, or
Recovery's **Delete & free resources** control. Desktop leads to Stop first.
Discard requires every execution to be independently observed stopped/absent.
It reuses retained cleanup's journal, exclusive custody, Linux physical-path and
Git registration checks, bounded removal, independent absence observation and
atomic History/card finalization. Partial/unconfirmed removal keeps the card and
exact request; dispatched uncertain removals are never repeated. Containers,
their logs/writable layers, and the selected local checkout are lost. Shared Git
cache/refs, images, volumes, separately stored reports/runtime data, external
branches and PRs are not reclaimed. Validation evidence and both receipts remain.

## Exact limits

Only ordinary automatic local Docker PR/branch tasks at `review_required` with
`EXEC_EXIT_UNVERIFIED` in an ordinary in-container setup/lint/SAST/build/test/facts
phase are qualified. Azure, Goals, linked/dependent tasks, retained continuations,
rewrites, recovery forks, external test pipelines, sidecars, unknown host/browser
or reviewer execution topology and conflicting source/delivery custody block.

Legacy qualification does not invent an old validation dispatch. It requires the
recorded full Docker ID **present on the observed Linux local-socket Engine**,
corroborating `POD_ID` environment (and non-conflicting managed labels), an exact
labelled private bridge, bind mounts of the recorded checkout and its Git common
store, reciprocal physical Git registration and the recorded branch. Protected
paths and complete Docker container/network scans must exclude foreign or shared
attachments. Additional capabilities/devices/unrecognised mounts block. A missing
legacy main container cannot supply these independent proofs and blocks initial
admission; absence after an admitted exact Stop is separately observable.

Task-wide worker/provider/retry/reviewer admissions and historical validation,
allocation, worker and source claims are inspected unpaged. Generation one and
empty mutable pointers are never resource-closure proof. Current producer or
dispatch evidence, when present, must agree with the independent observed set.
An interrupted admission, unexplained historical resource or unavailable provider
observation blocks; this control does not repair or backfill those ledgers.

Stop checks ownership and protected Git identity without requiring the destructive
tree scan, Linux deletion mount readiness, clean source, continuation, delivery
proof or immutable final files. Discard can therefore remain blocked after a
successful Stop. There is no force/prune/legacy-kill fallback.

Native desktop checks must run on a Mac using `scripts/test-desktop.sh`; Linux
fixtures do not prove Xcode compilation, UI rendering or live Docker behavior.
