# Retention-safe continuation of existing work

Use this explicit human operation when existing source or infrastructure needs
repair but ordinary Rework would replace/delete the original resource. It reuses
the retained-checkpoint ledger, credential epochs and task accounting. It does
**not** broaden legacy checkpoint recovery or in-place source adoption.

A failed approval rewrite retains its own publication/source authority. Use the
[dedicated rewrite-owned repair continuation](approval-rewrite-repair.md) for an
eligible settled sandbox selection; these ordinary continuation operations remain
refused while a rewrite owns source.

## Authority and limits

- Only idle ordinary automatic PR/branch tasks in failed/review-required/validated states,
  with a stopped original resource, clean retained host source and an existing
  result are eligible. A failed task with no result is also eligible when its
  worker is settled, completion records source preservation, and current-generation
  infrastructure reports are retained (see below). Docker and sandbox originals
  are supported.
- Unsettled workers, immutable validation dispatches, unknown publication/merge
  requests, competing custody, pending decisions/guidance, Goals, sidecars and
  waivers remain blockers. Custom workflows retain their configured phases;
  independent review is mandatory. Thin/off validation is not a recovery route.
  New ordinary continuation records `reviewPolicy: independent-v1`: this adds a
  fresh independent review gate even when the original native workflow omitted
  its review phase, provided its frozen AI configuration already has an
  independent reviewer route. No reviewer route is invented or selected from a
  mutable preset. A legacy launch lacking enabled review, or a native launch
  without that frozen independent route, still refuses recovery.
- An exact **host checkpoint** is selected, not a claim that it contains final
  sandbox bytes. Ignored reports or unsynced edits can still exist in the original.
  Preserve that original; do not wake it, replay an unknown restore, or delete it.
- Host bytes, ignored files and Git history are preserved using the existing
  private inventory/bundle protocol. Existing bounds (1 GiB and inventory limits)
  remain; oversize/partial capture fails closed, not by excluding dependencies or
  reports. The new checkout has independent Git storage and refs; the original
  Git configuration/credentials are not imported with the bundle.
- No coding agent starts. No per-cycle counter, task retry history or token budget
  is reset. A retry grant remains a separate authenticated action, when needed.
- Preparation/checking errors and interrupted invocations retain custody and are
  not automatically replayed. There is no manual-clear or destructive release
  action. Do not change request IDs to bypass a held operation.

Configured setup/check commands still execute repository code under the new
resource's credentials and frozen network policy. Checks-only means no coding
worker, not an OS-level read-only sandbox, complete dependency-closure proof or
recovery of inaccessible original sandbox reports.

## Inspect and preview

Inspect the full pod ID, result and retry state before admission:

```sh
ap health --json
ap status POD --json
ap reconcile-validation POD --json
ap retry-state POD --stage validation --json
ap retained-continuation POD --json
```

### Infrastructure reported before validation

An expected native-check deferral can be mistakenly reported as infrastructure
trouble before daemon validation ever starts. Do not clear the report, invent a
validation result, answer it as a question, or force ordinary Resume. After
inspecting the recorded need and qualifying the intended fresh execution, use
this explicit checks-only continuation.

Read-only inspection returns `selection.expectedGeneration` and
`selection.expectedResultHash`. For an existing validation result the hash is
unchanged. With no result, it binds `{result: null, infrastructureReports}` using
the exact current-generation report IDs, recorded timestamps and payloads shown
in `selection.infrastructureReports`. **Do not hash `null` alone.** The server
preserves the null result and reports in the operation's `originalEvidence`;
report changes during observation/preparation invalidate selection. At most 100
reports, 64 KiB per payload and 1 MiB combined payload are accepted.

Use that inspected hash with `--result-hash` for both preparation and any later
candidate selection. A selection hash is not an eligibility or qualification
receipt: all stopped-resource, source-custody, termination, pending-guidance,
retry-budget and independent-review checks still apply. Missing settlement,
source preservation or current reports remains blocked. Legacy checkpoint
recovery is unchanged. Successful fresh checks still require separate approval;
no historical report is marked repaired or erased.

Confirm the hosted release includes this control before applying it; CLI help alone
is not proof of deployed support. Serialize heavy recovery/check runs on qualified
capacity rather than starting the fleet together.

Independently inspect the exact retained host HEAD and intended repository/source
branch. Refresh the provider PR/source state. Readiness or an earlier pass is not
current-source approval.

If software or resources must change, explicitly select an existing reviewed
replacement **profile ID** and preview it:

```sh
ap retained-continuation POD --preview-execution RECOVERY_PROFILE_ID --json
```

The server resolves only replacement environment/image and execution resources.
Repository/setup/commands, task/contract, AI/provider accounts, workflow/review,
network policy, PIM, actions, references, tool packs/instructions and budgets remain
inherited from the original admitted launch. The original launch snapshot stays
available; an immutable continuation records the selected configuration and its
parent digest. Later preset edits cannot change that selection. Missing required
capabilities, sidecars or inconsistent image/resources refuse admission.

**Preview is not image qualification.** Verify the pinned image's actual required
Git/runtime/CA/build capabilities and capacity. Deployment does not rebuild a
frozen worker image. In particular, full Autopod declaration work needs qualified
local capacity rather than silently overallocating a 4 GiB sandbox. See
[worker profile reliability](worker-profile-reliability.md).

## Select source for fresh checks

Choose a stable recovery ID before submission. Supply the exact original result
hash and host HEAD, not a worker assertion or a branch name:

```sh
ap retained-continuation POD --apply \
  --request-id RECOVERY_ID --generation ORIGINAL_GENERATION \
  --result-hash ORIGINAL_RESULT_SHA256 --head ORIGINAL_HOST_FULL_SHA \
  --reason 'Select this exact retained source for fresh checks; retain original reports' \
  --json
```

When a legacy in-place rebase left the host divergent from the published branch,
use `--remote-head EXACT_CURRENT_REMOTE_FULL_SHA`. The daemon first preserves the
original, then fetches the source branch into the **new private clone** and refuses
an unexpected head. It also records a fresh private base ref for review. Selecting
this source does not certify its extra commits or create retroactive force-push
permission. Subsequent delivery remains ordinary exact-source publication; an
advanced unrelated remote is never overwritten.

Add `--execution-profile RECOVERY_PROFILE_ID --execution-digest PREVIEW_SHA256`
only after inspecting the preview. Missing/stale digest refuses selection before
claiming or detaching the original. A backend change is atomic with the original
resource hold, new generation and selected launch digest. No old container,
worktree or network is torn down by selection.

New ordinary continuation admission also records the versioned mandatory-review
obligation in the immutable binding. During ONLY the owned, activated, exact-source
checking invocation, the daemon removes `review` from effective skipped phases;
all other frozen phase skips and commands remain unchanged. It never edits the
original launch workflow, imports worker pre-submit review or resets retry budgets.
The obligation is explicit in the validation task/fingerprint and a passing
current independent-review result is required before the operation can settle.
Existing records without this policy are not retroactively upgraded. Approval
rewrite repair keeps its dedicated admission semantics. Do not downgrade a daemon
while it owns an active operation with this policy: old binaries cannot execute
that additional review gate.

Admission returns a durable operation, not successful validation. Reuse the same
request ID and identical inputs after an uncertain response to observe it.

## Targeted repairs before checks

For conflicts or unfinished code, add `--prepare-only` to admission. This prepares
an independent repair checkout **without** changing the pod generation or queuing
a worker/checks. Its path and source identity are in the operation's `prepared`
evidence. Keep edits inside that private checkout; never reset the original or
push around its custody. Read the selected repository's instructions, integrate
against the recorded base, perform the authorized targeted repair and commit it.
The repair must descend from the explicitly selected prepared source.

If preparation did not select replacement execution, it can be selected once at
`--check` with the paired `--execution-profile` and `--execution-digest` from a fresh
preview. This supports qualifying infrastructure after source preparation without
replacing the operation or its original custody. An execution choice already made
at preparation cannot be replaced; omit these flags to retain that choice. The
candidate and any late execution choice share one immutable, atomic selection.
Image qualification is still separate, and no permissions, workflow or budgets
are changed by selecting software/resources.

Then select the exact final committed candidate:

```sh
ap retained-continuation POD --check --request-id RECOVERY_ID \
  --generation ORIGINAL_GENERATION --result-hash ORIGINAL_RESULT_SHA256 \
  --candidate-head EXACT_REPAIRED_FULL_SHA \
  --reason 'Select the committed conflict/code repair for fresh checks and independent review' \
  --json
```

The server checks clean branch/head/tree and ancestry, records an immutable human
source-selection receipt, then queues checks-only provisioning. Replaying with a
changed actor, source or request conflicts. Repeating the exact accepted request observes its
receipt; it does not allocate another resource or rerun checks.

### One finite Docker outer-test allowance

A measured suite overrun can require more outer command time without rewriting
its frozen workflow. At final `--check` only, an authenticated human can pair:

```sh
--test-budget-seconds 1800 \
--test-budget-reason 'Measured full suite exceeded its frozen fifteen minute outer limit'
```

This must extend the original test timeout, is capped at3600 seconds, and is
immutable with the exact source/actor/generation selection. It changes only the
outer test command bound, not individual test deadlines, commands, phase selection,
review, tokens, task authority or attempt counters. No original resource is used.
It is Docker-only; ordinary sandbox recovery budgets remain a separate operation.
The distinct `/check-budgeted` endpoint fails closed on old daemons; the CLI never
falls back to an ordinary check that would ignore the requested bound.

**Retry permission is separate.** Inspect `ap retry-state`; when needed, record
one explicitly approved `ap authorize-retry` with a stable request key. A larger
bound is not changed conditions for retry admission: that identity still uses the
frozen timeout. The first started validation admission in the selected generation
is the durable one-shot use receipt. Repeated selection observes its receipt,
not another execution. Automatic full-validation infrastructure retries cannot
reuse this allowance. Source/custody, active-execution and remaining task-budget
fences still apply; no reset or unknown-execution settlement follows.

## Outcome and later delivery

Follow `ap retained-continuation POD --json`, pod activity and status. A current
pass requires genuine configured checks **and independent review**, exact selected
source (or proven owned no-op checkpoints), and a verified new report snapshot.
Historical worker reports/reviews are not reused as current proof. The pinned
fresh base scopes review without rewriting the task's historical starting SHA.

No PR creation/push, dependents, automatic approval or merge follows this check
invocation. Passing checks stop at validated for a separate fresh human approval.

After inspecting the exact selected source and its current checks/review, a human
can approve **PR publication only**:

```sh
ap approve POD --publish-only --reason 'Approve this checked source for PR review only; do not merge'
```

This updates or creates the PR and leaves the pod validated. It does not rebase,
plan/request/poll a merge, complete the task, trigger dependents or clean up its
resources. The pod remains validated even while publication is in flight, so a
restart cannot reinterpret it as merge authority. Bulk and squash flags are
refused. A no-change candidate without a PR needs separate reconciliation, not
completion through this action. Ordinary `ap approve` still authorizes merging;
**do not substitute it** if the deployed daemon lacks publication-only support.
The separate `POST /pods/:podId/publish-pr` endpoint requires a human, a reason
and checked retained source; an older daemon fails closed rather than ignoring
an unknown approval flag.
Failed/missing review, source drift or incomplete report capture holds delivery;
a later waiver or unrelated historical pass cannot certify this selection.

Original resource and source holds survive pointer changes, restart, completion
and cleanup. Docker also enforces retired-resource holds at the backend boundary.
Unknown original wakeups/executions remain unchanged. This version does not
implement release/deletion of retained originals.

### Docker provider custody

Retained Docker replacements use a deterministic, versioned recovery/generation
namespace for the container and bridge, not a new logical pod, task or request ID.
The original name is never freed or renamed. A conflict on the replacement name
is an uncertain allocation to inspect, never permission to remove it and replay.
Ordinary constructor cleanup requires a custody database and an inspected full
container ID, with holds checked before stop and again before removal. Managed
reuse and constructor failure cleanup also respect holds. Missing identity or
custody authority fails closed.

Original and replacement bridges stay retained, even when empty. Startup orphan
reconciliation and subnet-pool pruning cannot remove them or detach retained
endpoints. Do not manually prune them to recover address space.

For disposable native Docker qualification, select an **already present exact**
image ID with the `autopod` user and `sleep`; no pull or substitution occurs:

```sh
npx pnpm --filter @autopod/daemon exec esbuild \
  src/containers/retained-docker-custody.native.ts --bundle --platform=node \
  --format=esm --packages=external \
  --outfile=node_modules/.cache/custody-native/check.mjs
AUTOPOD_SOURCE_ROOT="$PWD" AUTOPOD_DOCKER_CUSTODY_IMAGE=EXACT_LOCAL_IMAGE_ID \
  node packages/daemon/node_modules/.cache/custody-native/check.mjs
```

The fixture uses its own in-memory SQLite custody and unique containers/internal
bridges. Network enumeration is fixture-label-scoped, and cleanup touches only
IDs created by that invocation. Require both native custody and owned-cleanup
success markers. This tests actual Docker constructor/network behavior, not a
hosted image's toolchain, live task checks, model review or Azure capabilities.

The separate `src/containers/retained-check-test-budget.native.ts` fixture uses
that same compile/environment pattern. It runs an actual1400ms Node command in
its disposable Docker replacement: the frozen1000ms control times out, while the
selected3000ms bound succeeds. Real SQLite admission records refuse a second
execution and the original stays stopped/unchanged. Require
`NATIVE_RETAINED_TEST_BUDGET_PASSED` and `OWNED_BUDGET_FIXTURE_CLEANUP_PASSED`.
Its engine/reviewer scaffolding is synthetic; this proves timing/one-shot protocol,
not real task checks or model review. A timed-out disposable control is not
termination evidence; only fixture-owned containers are force-removed on cleanup.

**Do not downgrade to a binary unaware of these continuation facts after use.**
Prefer a retention-aware roll-forward. Older binaries cannot interpret a selected
replacement launch or enforce the added Docker holds.

## Human API

All routes require authenticated human identity; worker tokens and caller-supplied
paths, actors, configs, results, force flags and proof are refused:

- `GET /pods/:podId/checkpoint-recovery`: shared durable operation inspection.
- `GET /pods/:podId/retained-continuation/execution?profileId=ID`: read-only preview.
- `POST /pods/:podId/retained-continuation`: exact original selection, optional
  `remoteHead`, `prepareOnly`, and paired `executionProfileId`/`expectedExecutionDigest`.
- `POST /pods/:podId/retained-continuation/:recoveryId/check`: exact original
  generation/result, `candidateHead`, meaningful reason, and optionally paired execution profile/digest
  only when preparation did not select replacement execution.
- `POST /pods/:podId/retained-continuation/:recoveryId/check-budgeted`: the same
  exact-source selection plus required `testBudget: {seconds, reason}`; one finite
  Docker outer-test allowance, never retry permission. Ordinary `/check` refuses
  this field rather than silently ignoring it.

Related: [legacy checkpoint recovery](retained-checkpoint-recovery.md),
[source adoption](source-adoption-recovery.md),
[approval source leases](merge-operator-recovery.md), and
[validation execution recovery](validation-execution-recovery.md).
