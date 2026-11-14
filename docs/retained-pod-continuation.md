# Retention-safe continuation of existing work

The existing `ap retained-continuation` sections below describe **checks-only**
continuation. For the separate, prospective typed-launcher repair-and-code protocol,
see [Conditional environment repair and one coding continuation](#conditional-environment-repair-and-one-coding-continuation).
Machine wakeup, checks-only continuation, Resume delivery and coding authorization
are different operations, never fallbacks for one another.

Use this explicit human operation when existing source or infrastructure needs
repair but ordinary Rework would replace/delete the original resource. It reuses
the retained-checkpoint ledger, credential epochs and task accounting. It does
**not** broaden legacy checkpoint recovery or in-place source adoption.

A failed approval rewrite retains its own publication/source authority. Use the
[dedicated rewrite-owned repair continuation](approval-rewrite-repair.md) for an
eligible settled sandbox selection; these ordinary continuation operations remain
refused while a rewrite owns source.

For a failed **running but settled local Docker original**, do not manually stop
it to satisfy the stopped-original prerequisite. The separate
[preservation-safe infrastructure recovery](infrastructure-recovery.md) control
acquires custody before its one non-destructive stop and explicitly distinguishes
checks-only from an independently provisioned coding repair.

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

The default `ap retained-continuation POD` view leads with recorded infrastructure
needs and policy refusals. `--json` includes the full additive `inspection` field
alongside the existing `selection` and `operations`. This is authenticated,
read-only inspection: no provider GET, wakeup, source fetch/preparation, credential
epoch rotation, report changes or queue dispatch is performed.

`requires_selection` and `no_recorded_blocker` are **not admission permission**.
Inspection reuses the continuation policy's first conservative refusal and exposes
worker/guidance/custody observations, but source cleanliness/identity, provider
resource state, actual environment qualification and retry admission remain
`not_checked`. A recorded host path or preservation marker is not proof of final
original sandbox bytes; uncollected files/reports remain retained there. Needs
are worker-reported context, not diagnosed prerequisites or repaired evidence.
Displayed needs are read independently of selection eligibility and bounded in
SQLite (20 current-generation reports, 256-character ID/owner/phase, 1024-character
need). Truncation is explicit and original selection evidence remains unchanged.
Needs remain visible with an existing validation result or missing settlement/source
preservation; displaying them neither supplies missing evidence nor permits execution.
Old-generation reports are excluded, and missing/non-text fields remain unrecorded
rather than being inferred from prose. If settled pre-validation report evidence
is incomplete or exceeds selection bounds, inspection still displays bounded
needs and the refusal: `selection` is null, the GET response includes
`selectionRefusal`, and inspection records a blocked `selection_evidence` check.
No usable hash is invented. Only the expected `CHECKPOINT_RECOVERY_BLOCKED` (409)
selection refusal is displayed this way; unexpected storage/programming/auth errors
still fail the request. Selection and admission themselves remain unchanged.
An older daemon without this projection displays inspection unavailable, never
assumed eligibility. Storage/inspection errors do not produce an eligible result.

Use execution preview only to inspect a proposed configuration; qualify the actual
environment separately. Waking the original sandbox is machine recovery, not task
continuation. Preparation, candidate selection, checks, retry authorization and
fresh human approval retain their existing independent fences. No coding worker
or generic in-place repair operation is added by this inspection.

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

### Explicit build-only tool environment correction

An authenticated pod owner can select `--build-only-env KEY[,KEY...]` with an
execution preview and initial `--apply` (not late `--check`). This is an explicit
exception to frozen repository environment inheritance, not arbitrary command or
workflow replacement. For example, a global `XPM_BICEP` tool-path override can
correctly select the pinned Bicep executable during build yet violate Node
identity tests that require an otherwise clean application environment.

```sh
ap retained-continuation POD --preview-execution SAME_REVIEWED_PROFILE \
  --build-only-env XPM_BICEP --json
```

The derived digest binds the selected 1–16 unique keys, their existing public
literal values and the unchanged original build script. The daemon removes those
keys from globally inherited `buildEnv` and quotes their assignments around the
original build command in a build-phase-only shell. No caller values, secret
references, new commands, skipped assertions or altered phases/reviewer are
accepted. The original snapshot stays immutable; the selected configuration and
human actor are retained. Missing keys/build command, changed preview, malformed
keys or oversized wrapped commands fail before custody. Existing selections with
no scoping retain their digest semantics. Older daemons reject the new field or
query; never fall back to an unscoped request.

Supply the same keys and the **scoped** preview digest with initial `--apply`, or
include `buildOnlyEnvironmentKeys` in a saved checks-only infrastructure recovery
request. A prepared execution cannot be amended later, and this option cannot
authorize coding. Owner identity is rechecked after asynchronous observation and
before preparation/checks. All source, settlement, retry, task-budget and independent
review gates remain. A preset edit alone does not repair a frozen launch.
Scoping changes the effective command/environment identity, so the existing
changed-conditions policy may admit a retry within the unchanged task budget.
It does not grant an unchanged-input override or reset attempts; if that policy
refuses admission, a separate explicit retry authorization is still required.

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

Startup orphan reconciliation and ordinary pruning cannot remove retained bridges
or detach retained endpoints. A bridge is an execution resource, not custody
evidence. Only the [release protocol](hosted-daemon-docker-networks.md#release-protocol)
may remove the empty bridge of a *superseded* identity, and only after a
durable release record. It never releases the current identity of a non-terminal
pod or any bridge of a finalized or recovery-fork pod, and never touches
containers. Do not prune bridges manually with `docker network rm`.

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

## Checks from sealed pre-validation source

A stopped task does not need a fabricated failed result or infrastructure report
to enter its **first real checks**. The existing `ap retained-continuation`
checks-only selection also accepts an exact settled Docker stop-and-retain receipt
when no validation dispatch, stored validation or validation retry admission exists
for the logical task. This is source evidence, not an inferred worker outcome.

The current frozen native task/generation/cycle, settled worker, Docker namespace
and resource, original host path, preserved branch/clean HEAD/tree and private
archive checksum must match the immutable receipt. Original result remains null.
Admission and preparation observe the exact stopped resource; preparation rehashes
the complete retained archive (including ignored files/Git data) and rechecks the
original clean source before activation. Missing/changed archives or source hold
the operation without starting checks.

This slice supports **exact-source checks only**: no coding continuation,
prepare-only/manual candidate, remote source substitution, original wake/exec,
second stop, resource deletion, inferred pass or delivery. Existing guidance,
ownership, settlement, retry, task-budget and frozen independent-review gates still
apply. Changing a task token cap is a separate explicit human action; source
selection does not reset usage, retries, execution history or other limits.

Inspection supplies the ordinary generation/evidence hash. Select the exact sealed
host HEAD using `ap retained-continuation POD --apply --request-id SAVED_ID
--generation GENERATION --result-hash EVIDENCE_HASH --head SEALED_HEAD --reason ...`.
A replacement execution selection remains separately previewed software/resources
only; task/repository/AI/workflow/network authority stays frozen. Originals,
archives, reports, unknown worker result and prior accounting remain retained.
Fresh required checks and independent review stop at validated for separate human
approval. A failed/unknown check is recorded, never an automatic coding retry.

## Conditional environment repair and one coding continuation

`ap repair-continuation` and the desktop **Inspect repair & continuation…** sheet
use the separate authenticated `repair-continuation-v1` protocol. CLI help or a
local desktop build does not prove a deployed daemon supports it. A 404, unknown
version, malformed response or static refusal disables authorization; clients never
fall back to Rework, Resume, `/validate` or retained checks-only mutation.

### Supported selection, not inferred repairability

This first slice is for an ordinary frozen automatic PR/branch task with configured
validation and independent review, exact retained **host HEAD**, and a reviewed
local-Docker software/resource replacement. All current original-generation
infrastructure reports must carry the supported version-1
`missing-execution-prerequisites` envelope, bound to the original v2 manifest's
requirements hash and explicitly declared missing launcher names. The complete
canonical report-set hash is additional to the existing result hash, even when a
validation result exists. Old/free-text, mixed, truncated or unsupported needs
cannot be inferred, backfilled, cleared or waived by an operator reason.

Launcher lookup is not a working Docker builder, private release/credential access,
native Mac proof, filesystem repair or a completed required check. Resource minima
still apply, but resource-only blocker mapping is not supported. Unknown execution,
competing custody, uncollected guidance, pending decisions, waivers, linked fixes,
Goals/interactive tasks and sidecars remain refused by backend policy. No in-place
install commands, remote source substitution or manually edited future candidate
are selected by this protocol.

### Inspect, preview, explicitly authorize, observe

```sh
# Read-only inspection with original report/preservation and budget/retry context:
ap repair-continuation POD
ap repair-continuation POD --json

# Read-only STATIC eligibility/configuration diff; use the exact inspected host SHA:
ap repair-continuation POD --preview-execution REVIEWED_PROFILE_ID --head EXACT_HOST_SHA --json

# Save the exact request fields and stable ID before running this explicit action.
# Copy hashes/digests from that preview; do not substitute branch names or recompute null.
ap repair-continuation POD --apply --request-id STABLE_SAVED_ID \
  --generation ORIGINAL_GENERATION --result-hash EXACT_RESULT_HASH \
  --report-set-hash EXACT_COMPLETE_REPORT_SET_HASH --head EXACT_HOST_SHA \
  --execution-profile REVIEWED_PROFILE_ID --execution-digest EXACT_PREVIEW_DIGEST \
  --binding-digest EXACT_BINDING_DIGEST \
  --reason 'Select this reviewed environment for one conditional coding attempt'

# Read-only, including after timeout/lost/malformed responses; never resubmits:
ap repair-continuation POD --observe STABLE_SAVED_ID --json
```

Preview returns `configurationOnly: true`, `actualQualification: not_run`, and
`conditionalAttemptEligible`. Supported, fully bound static selection may enable
**Authorize repair and one coding continuation IF it qualifies**. It does **not**
require proof from a not-yet-provisioned resource, nor is it itself qualified
proof or permission to skip probes. Unsupported/unknown static eligibility stays
disabled. Authorization permits the daemon's bounded provision/prepare/qualify/code/
seal/check sequence, not an unrestricted repair runner.

Inspection may return `available: true` with `sourceHead: null`: it deliberately
does not inspect host source. Enter the exact user-selected host HEAD and reviewed
profile for preview. Only a successful source-checked preview binds that HEAD,
profile, generation, result/report-set hashes and requirements. A non-null inspection
HEAD must agree; a null inspection HEAD is neither source proof nor a reason to
require a pre-qualified future candidate.

The daemon must qualify the **actual candidate** under the normal worker context
and consume its exact resource/source/configuration/requirements/report-set/epoch
binding before any coding stream. Qualification evidence expires after five minutes
or earlier identity/restart/wake/mutation changes. False, unknown, timed-out or
mismatched evidence cannot start coding. A disabled client button is not an
admission fence: the daemon owns settlement, atomic one-use accounting, custody
and duplicate-worker prevention.

Clients distinguish claimed/provisioning/qualification/coding admission/checks and
final approval. Accepted is not qualified; admitted is not completed; checks passed
is not delivery approval. A separately sealed clean descendant final source goes
through the genuine configured checks and independent review, with no automatic
second coding segment. Success stops validated for separate human approval; no
publication, autoapproval, dependents, token reset or implicit retry grant follows.

The selected Git source is not a claim to contain original final sandbox bytes.
Original host work, ignored/unsynced files, reports and resources stay retained,
including after failed/unknown attempts. Historical NOT-RUN checks stay visible
and incomplete in retained history/new reviews; qualification does not pass them.
Repository/task/AI/account/runtime/model/workflow/network/PIM/actions/tool packs/
permissions and cumulative budgets remain frozen. Worker/startup/validation retry
state and cumulative recorded usage are displayed separately; unavailable is not
zero or retry permission, and recorded budget admission is not a future spending
reservation. Use existing owning controls for any separate grant/budget decision.

The CLI requires a caller-supplied stable ID and prints the exact unchanged request
plus an observe command on an unconfirmed authorization response. It has no hidden
mutable request database. Preserve those fields; do not change IDs after an
uncertain result. Desktop journals the exact request in protected per-daemon/pod
storage **before** POST; reopen/refresh only inspect/observe and never auto-send.
Corrupt/conflicting journals block new authorization rather than silently replacing
the request. Connection changes fence late responses/errors. No data-loss checkbox
or “clear blocker” control exists in the repair sheet.

### Versioned API

Shared strict schemas and public types live in
`packages/shared/src/schemas/repair-continuation.schema.ts`:

- `GET /pods/:podId/repair-continuation-v1`: direct `RepairContinuationInspectionV1`.
- `GET /pods/:podId/repair-continuation-v1/preview?sourceHead=SHA&executionProfileId=ID`:
  direct `RepairContinuationPreviewV1` (configuration/static eligibility only).
- `POST /pods/:podId/repair-continuation-v1`: strict `RepairContinuationRequestV1`;
  202 direct `RepairContinuationOperationV1`, not a result or wrapped empty success.
- `GET /pods/:podId/repair-continuation-v1/requests/:requestId`: direct operation;
  observe the same saved key. Absence is not proof no dispatch occurred.

Each operation response includes required `operationId`, the opaque internal
retained operation/custody ID. It is distinct from `request.id`, the caller's stable
external replay key used in the observation URL. Qualification
`binding.operationId` **and** `binding.custodyId`, and sealed final-source
`operationId`, must correlate to the response's `operationId`, never to the external
request key. Immutable qualification/final-source evidence is not rewritten to
look like a request. Older responses missing this identity are unavailable rather
than accepted without correlation.

The request includes only `version`, `intent`, `id`, `expectedGeneration`,
`expectedResultHash`, `expectedReportSetHash`, `sourceHead`, `executionProfileId`,
`expectedExecutionDigest`, `expectedBindingDigest` and `reason`. Caller-authored
proof, actor, epochs, arbitrary shell commands, retry grants and reset flags are
not accepted. Read-only report/accounting composition uses existing checkpoint,
task-execution and retry-state endpoints; their failures remain visibly unavailable.
