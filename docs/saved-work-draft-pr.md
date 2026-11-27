# Share saved work as a draft PR

An authenticated human can publish a settled ordinary PR-output task's saved
source for review, including failed checks, never-run checks, exhausted retries
and a compromised original worktree. In task actions, choose **Create draft PR
from saved work…**. Select verified saved source, prepare its independent
checkout, review the exact commit/tree, freshness, new branch, base and check
gaps, then explicitly confirm **draft only — original retained**.

This does not approve or complete the task. The separate draft receipt does not
set `pod.prUrl`, enter merge/fix polling, reset budgets, change checks/readiness,
clear compromise, start coding, release resources or clean up source. Existing
PRs and ordinary approval/merge requirements remain unchanged, including GitHub
draft merge refusal.

## CLI

Use the complete pod ID and retain a stable request ID before any write:

```bash
ap draft-pr <full-pod-id> --json
ap draft-pr <full-pod-id> --prepare --source checkpoint-3 \
  --request-id <stable-request-id> --binding <inspection-binding> --json
ap draft-pr <full-pod-id> --confirm --request-id <stable-request-id> \
  --binding <confirmation-binding> --json
ap draft-pr <full-pod-id> --observe --request-id <stable-request-id> --json
ap draft-pr <full-pod-id> --cancel --request-id <stable-request-id> \
  --binding <confirmation-binding> --json
ap draft-pr <full-pod-id> --cancel-preparation --source <original-source-id> \
  --request-id <stable-request-id> --binding <original-inspection-binding> --json
```

Inspection is read-only: no sandbox wake/export, checks, worker or provider write.
Preparation creates only an independent bundle/object store/checkout in daemon
saved-work storage. Confirmation authorizes the exact actor/task/generation,
repository/base, source and new branch bound by that operation. Initial
confirmation expires after 15 minutes if no push has been admitted.

The source list prefers the latest verified saved checkpoint, including a fully
host-imported, lineage-verified snapshot whose original promotion failed solely
with `LINEAGE_CONFLICT`. Commit, tree, single parent, parent tree, pod-owned
quarantine ref, raw daemon author/committer/subject and actual local objects are
reverified. Partial transfer or a
compromise flag alone never establish proof. Older checkpoints are labeled
`older-saved` and require explicit selection. Host HEAD is a separate
`host-commit-only` selection with unknown capture freshness; dirty files, staged
changes, ignored files and uncaptured sandbox edits are excluded. Nothing
silently substitutes host HEAD for sandbox work.

## Uncertain outcomes and unavailable actions

Keep the same request ID after a lost response. Use `--observe` or desktop
**Observe / refresh**; neither sends a push or creates a PR. A negative read after
a timeout never authorizes replay. Matching remote SHA is accepted only after
this operation recorded push admission. A PR must match the admitted operation
marker, repository, head, target, URL and open draft state. Closed, merged, ready,
wrong-source or wrong-base results remain blocked.

If observation proves `pushed`, no PR create has been admitted: a fresh explicit
confirmation of the same operation can continue to draft creation. If it remains
`create-uncertain`, do not replay publication. If the work was handled elsewhere
and no PR appears in observation, the original human can explicitly retire that
exact draft attempt:

```sh
ap draft-pr POD --observe --request-id REQUEST_ID --json
ap draft-pr POD --retire-uncertain 'Why this exact draft is no longer needed' \
  --request-id REQUEST_ID --binding CONFIRMATION_BINDING --json
```

Retirement requires an idle operation, an authenticated provider read returning
no PR, and the exact saved commit still present on the operation branch. A
negative read does not prove absence; `retired-uncertain` preserves that fact.
The receipt releases only this draft’s cleanup lock. It does not touch the
operation branch, any PR, the original pod or its files, and it still forbids
republication of the same saved selection. Inspect the pod separately; normal
Kill/Delete guards still apply. If retirement’s response is lost, observe the
same request rather than sending another publication request.

Active worker/validation, deletion, source rewrite, recovery preparation and
unreconciled publication ownership block this workflow. Permanent historical
retention alone is not active mutation authority. Unsupported providers refuse
before preparation or push: the adapter must locally validate support for the
frozen repository, including on every later confirmation. Supported paths use
GitHub `draft:true`, gh `--draft` and ADO `isDraft:true`. Canonical provider PR
URLs reconcile using repository identity (including GitHub casing/`.git`/trailing
slashes and ADO legacy host aliases), not a raw URL prefix. The deterministic body records task failure, source, freshness,
exclusions and historical checks with unknown exact-snapshot applicability. It
never generates a pass, waiver or AI-authored success narrative.

Configured publication security scanning still runs on the independent selected
tree before push. The daemon reads the frozen target's `origin/<base>` tracking
ref in the original object store, takes its merge-base with the selected source
and proves that commit is an ancestor in the independent checkout. With that
verified base it applies the ordinary push semantics: changed files are scanned
and findings already present in the base are ignored, so pre-existing content
(for example test fixtures) cannot block an unrelated docs change. Without a
verified base, for a compromised original, or when the profile configures
full-tree push scans, it scans the full tree. The daemon gives this scan up to
eight minutes; the ordinary push scan budget is unchanged. Confirmation can take
several minutes and must still be valid when the push is admitted.

A refusal names its cause and pushes nothing. `SECURITY_SCAN_BLOCKED` lists each
blocking finding's scanner, rule and file:line; matched values are never
recorded. `SECURITY_SCAN_INCOMPLETE` (for example budget exhausted, files could
not be listed or a detector failed) and `SECURITY_SCAN_FAILED` (the scanner could
not run) carry their reason. The redacted result is stored on the operation as
`publicationScan`, so `--observe` shows it while the operation stays `prepared`.
This is separate from task validation and does not change its check results or
budgets.

Preparation failures and expired initial confirmations record cancellation before
any external admission. A human can explicitly cancel an interrupted or prepared
operation using its exact confirmation binding. Cancellation releases only this
operation's temporary fence; all original resources and independent preparation
files remain retained. A new selection needs a new request ID. Once a push is
admitted, cancellation is refused. Only the separate, explicitly acknowledged
retirement above can release the lock on an unresolved draft create; it is not
an alternative for an uncertain push.

If a locally journaled preparation never becomes observable, a negative lookup
does not allow discarding it. Explicitly **Cancel pending preparation — prevent
delayed admission** (or `--cancel-preparation`) using the original selection. The
daemon atomically records a durable request revocation, cancels only an existing
pre-effect preparation if present, and forbids delayed admission of that exact
request. Only this receipt lets desktop clear its local pending journal and
review a new selection. No preparation is resubmitted and no source is deleted.

## Verification ownership

Dedicated suites are daemon `pods/saved-work-draft-pr.test.ts`, daemon
`worktrees/saved-work-draft-provider.test.ts`, and CLI
`commands/saved-work-draft-pr.test.ts`. The v253 upgrade regression is
`db/saved-work-draft-upgrade.test.ts`; this unpublished feature allocates migration
**254_saved_work_draft_pr.sql**, after main's applied reviewer-budget (252) and
validation-source (253) migrations, whose bytes remain unchanged. Provider effects are mocked; snapshot and
divergence preservation use disposable real Git repositories. Native tests live
in `SavedWorkDraftTests.swift`. Run `bash scripts/test-desktop.sh` and the desktop
build on a Mac. Linux results do not prove Swift compilation or UI behavior.
