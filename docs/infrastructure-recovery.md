# Preservation-safe infrastructure recovery

Held empty-workspace artifacts have a separate bounded
[checks-only artifact route](artifact-checks-recovery.md). The Git-backed controls
below do not admit them, and collecting files alone is not independent acceptance.

`ap recover-infrastructure <pod>` is a separate, authenticated human control for a
failed **local Docker** task whose worker has settled and whose exact clean Git
source was preserved before a current-generation infrastructure report. It is
not ordinary Resume/Rework, a waiver, a retry-budget reset, or completion.

If finalization stopped because of uncommitted or untracked files, this is not
a failed infrastructure execution. The read-only `ap recover-infrastructure`
and `ap source-recovery` views can point to `ap rework <id>` instead. This hint
is not permission; existing custody and retry checks still apply. Auto-commit
refuses to stage when machine-local Git excludes disagree with the source
check, so files a host marked private cannot silently enter a commit. Commit
intended changes explicitly and move scratch files outside the workspace.

After an owned `rework` has sealed its exact candidate and completed fresh checks
with a recorded failure, a human may explicitly select a **new** operation against
that failed result. This narrowly supported successor uses the prior immutable
candidate/check receipt, not a fabricated infrastructure report or backfilled
completion marker. The prior task, generation, resource, worktree, source HEAD/tree
and result hash must still match. Its ID is durably bound into the new operation;
source cleanliness and all ordinary settlement/accounting gates are rechecked.
Old/free-text failures without this sealed, completed repair proof do not acquire
this permission. No second worker starts automatically, no failed check becomes a
pass, and unknown/active executions remain ineligible.

A checks-only successor can also select a **settled infrastructure-blocked repair**
that stopped before candidate sealing or daemon validation. This does not invent a sealed
candidate, erase the infrastructure reports or start another coding worker. It requires the
exact completed worker/run/resource and original Docker engine/creation namespace, current
settled/source-preserved finalization and bounded report-set hash, unchanged task/generation/
configuration/worktree, no competing or uncertain worker/reviewer/validation, and an explicitly
selected clean committed descendant of the prepared repair source. `rework` is refused for
this predecessor shape. All ordinary guidance, budget and independent-review gates remain.

Ordinary retained continuation still reports custody blocked. Select this separate explicit
`mode: checks` request through the owning `recover-infrastructure` control, using the current
inspected generation/report hash and exact final host HEAD; do not reuse the original repair
request or select another coding attempt.

The controller binds the predecessor's immutable hash and atomically inserts a unique,
immutable predecessor-to-successor custody receipt when claiming the checks-only selection.
The old blocked record, source, container and reports remain retained; only the new exact
operation owns task execution. A partial preparation, uncertain stop or failed fresh check
holds the successor instead of clearing custody or replaying it. Inspect the saved request;
do not choose a new request ID to evade an uncertain result. Passing fresh configured checks,
Facts and independent review still stops at validated, without delivery or automatic approval.

A separate narrow successor also supports a completed **checks-only retained
continuation** that genuinely failed, without inventing an infrastructure report.
It requires the same logical task/current generation, exact immutable checked
failure/result hash, completed latest validation admission, unchanged selected
host checkpoint/worktree, frozen independent reviewer, and a positive Docker
creation-label observation matching the prior recovery/generation namespace.
Missing, foreign or legacy labels fail closed before custody/stop. The new
operation records `predecessorChecksId`; it authorizes checks only, never a coding
worker. With no recorded post-check source field, only the already selected
prepared checkpoint is supported, not an inferred final container export.
Unsynced files/reports and the whole original container remain retained.

This includes a pod parked at `review_required` when that completed checks-only
predecessor records `phase: review`, `code: REVIEW_UNAVAILABLE`, no critic verdict,
and no failed product checks or pending Facts. The reviewer must be settled and
cleanup confirmed through its existing controls before selection. Use a new
`mode: checks` request with the current generation, immutable checked result hash,
and exact retained HEAD. Fresh checks and independent review still run under
existing retry and reviewer budgets; this is not a path around critic rejection,
failed checks, or a reviewer hold.

This is the continuation/quiescence protocol, **not** `finalize-retained
--stop-retain`: finalization permanently owns the task and would prevent further
continuation. Do not use finalization to make an original appear stopped.

Interactive/Goal tasks, sidecars, shared resources, active or unknown executions,
disabled/thin validation, and missing independent review remain ineligible.
Uncollected guidance blocks checks-only recovery. An explicitly selected `rework`
may admit its one owned worker to collect the still-saved guidance through normal
`check_messages` delivery/acknowledgement. No operator marks it read: pending
human decisions still block admission, and unread or newly arriving guidance
blocks candidate sealing, fresh-check certification and delivery, including across
asynchronous final source inspection. Ordinary retained-continuation inspection
still describes checks-only eligibility; its unread-guidance refusal is not a
refusal of the separate explicitly selected one-worker `rework` operation.

## Linked PR-fix tasks

The explicit infrastructure protocol also supports a canonical linked fix when
its root parent is settled and **failed**, still names that exact fix, and owns
the same logical task, repository, branch/base and existing PR. Parent identity,
generation, frozen launch and PR-attempt limits are bound into the recovery's
configuration hash and rechecked across asynchronous source/provider operations.
A changed parent or active/uncertain task execution remains blocked. Series
branch redirection and chains of fix parents are not supported by this path.

Ordinary retained continuation and rewrite recovery still reject linked fixes.
The infrastructure repair retains its parent and original resources, uses normal
task/retry accounting, and stops at fresh validation/review without pushing,
creating a PR or restarting parent merge polling. Recovery does not grant new
publication or merge authority. A fix with a current infrastructure report or
retained-checkpoint custody is no longer automatically recycled by the parent;
the parent parks failed without spending another PR-fix attempt.

Read-only inspection includes separate `infrastructure.policies.checks` and
`infrastructure.policies.rework` observations. In particular, unread guidance may
block ordinary/checks-only continuation while one explicit repair can collect it.
These observations do not qualify source/software, authorize a retry or admit work.

## Desktop handoff

When ordinary Rework, Revalidate or Resume reports `INFRASTRUCTURE_BLOCKED`, the
repair sheet shows **Infrastructure recovery required**, the current generation's
recorded owner/phase/needs and preservation observations. This is a durable report
hold, not live infrastructure health. Refresh and token-budget changes do not
repair it, and a successful worker segment that reported a blocker is not labelled
a worker failure.

**Copy read-only inspection command** supplies `ap recover-infrastructure POD
--json` (using the installed `autopod` command). It only copies text; nothing is
executed. Use the exact checks-only CLI selection below for fresh checks without
coding. Software/resource selection and admission remain explicit CLI steps, not
an automatic replacement performed by the sheet. The separately available
**Review replacement environment and coding repair…** opens the existing
conditional repair-continuation inspection/preview; opening it does not qualify
an environment or admit a coding segment. Its typed prerequisites and all ordinary
guards still apply. Unknown/stale report observations do not enable ordinary
controls. No report is cleared and no original resource is deleted by this UI.

## Inspect, qualify, select

```sh
ap recover-infrastructure POD --json
ap recover-infrastructure POD --preview-execution QUALIFIED_PROFILE --json
```

The default is read-only and returns the report-bound selection and existing
operations. Inspect the source SHA separately; the hash of `null` is not a
selection. Qualification must address the actual recorded needs before admission:
source inputs, immutable software, build capacity/tooling, reviewer access and
required check platforms. A diagnosis string is operator context, **not proof**
that these prerequisites or the product acceptance checks passed.

Save an exact request JSON file (128 KiB maximum), containing:

- `id`: stable request ID; `expectedGeneration`, `expectedResultHash` and
  `checkpointHead`: the exact inspected original selection;
- `mode`: `checks` (no coding worker) or `rework` (one owned coding repair);
- `reason` and `qualification`: explicit human selection and recorded-needs diagnosis;
- optionally `executionProfileId` and `expectedExecutionDigest`: a separately
  previewed software/resource replacement. Original repository, AI/reviewer,
  workflow, network, credentials, tools and other authority remain frozen;
- for `checks` only, optional `buildOnlyEnvironmentKeys`: explicit owner-selected
  public tool variables restricted to build, paired with the exact scoped execution
  preview/digest. See [build-only correction](retained-pod-continuation.md#explicit-build-only-tool-environment-correction).
  This does not replace assertions or allow a different test command;
- for `rework` only, `instructions: {content, sha256}`: credential-free operator
  repair context, at most 64 KiB of exact UTF-8 bytes with its SHA-256. It does not
  rewrite the original task or count as review/check evidence.

```sh
ap recover-infrastructure POD --apply --request exact-request.json --json
```

No `actor`, `force`, source path, fake result, `remoteHead` or `prepareOnly` is
accepted. A file path mentioned in instructions is **not delivered** to a worker.
Required source archives must already be safely qualified and available through
selected immutable software/ordinary supported inputs, or supplied as bounded
actual context bytes. Never copy a live checkout or personal authentication store.

## Custody and stop

Before any stop, admission binds the human/request, logical task, original
source/tree, provider namespace/resource, generation, configuration and preserved
reports. An independent bounded Git checkout is prepared while original custody
blocks competing writes, cleanup, exec and wake. A private capability permits
only the one durable, non-destructive original-stop dispatch; it never authorizes
container deletion, name reuse, an exec or a wake.

A lost stop response is not retried. Read status, then reconcile with the **same
saved request and authenticated actor**:

```sh
ap recover-infrastructure POD --reconcile --request exact-request.json --json
```

Reconciliation observes provider status and rechecks exact source/resource and
settlement. Running/unknown stays held; a confirmed stopped original can activate
its successor. Concurrent/repeated observations coalesce; a recorded stop is
never dispatched again, including after daemon restart. Changed source, provider,
report, actor or request fails closed. Incomplete/unknown preparation and unknown
worker/check termination remain retained, not implicitly replayed or certified.
Do not use raw Docker stop/kill, terminal finalization, DB edits or a replacement
task to bypass a denial.

## Independent execution and delivery

`checks` provisions the selected preserved source and runs no coding worker.
A current-generation structured `prerequisiteBlocker` cannot authorize `rework`
through this API. Typed missing-launcher repair must use
[conditional repair continuation](retained-pod-continuation.md#conditional-environment-repair-and-one-coding-continuation),
which qualifies the actual replacement environment before consuming one coding
admission. This control's operator diagnosis is not that qualification receipt;
checks-only recovery remains available without acquiring coding authority.
`rework` increments the normal Rework count, provisions an independent checkout,
and admits one resource/generation-bound worker atomically with its task-run
receipt. Normal task/token and retry accounting still applies. No original worker
session resumes. After observed worker settlement, only a clean committed
**descendant** can become the frozen repair candidate. Candidate/resource drift
or a failed/unknown worker blocks; there is no automatic second repair worker.
Only an authenticated human answer to the exact active repair worker's pending
`ask_human` question can enter a narrow reply capability. It records normal
guidance custody; worker collection/acknowledgement is still required. It does
not resume a dead worker, answer credential/override requests, extend a paused
worker's budget or authorize another coding turn. Qualify task/token headroom
before admission; a budget-paused/unknown repair remains held, not reset.

The exact live infrastructure repair worker can report plans, progress, summaries
and blockers through its current pod-scoped MCP credential. This borrows only its
recorded run/generation/cycle/resource/worktree scope and originating daemon
process, rechecked on mutation; it does not authorize another worker,
original-resource access or ordinary controls. Historical runs without the
process binding and stale, settled, foreign or uncertain workers remain refused. A current-generation
infrastructure blocker parks completion before candidate sealing or validation;
a clean unchanged checkout is not evidence that blocked integration succeeded.

Both modes run fresh configured checks with mandatory independent review,
including the additive frozen-review policy for workflows that omitted the review
phase. No prior worker review is reused. An infrastructure failure does not turn
into an automatic coding retry. Passing source-bound checks, review and new report
capture stop at `validated`, with auto-approval disabled. Publication/merge still
require normal fresh authenticated approval, exact source/provider proof and
external gates. The original source, resource and historical reports remain held.

## Qualification scope

`infrastructure-recovery.test.ts` exercises real SQLite, Git, API/controller,
manager/worker/validation and approval/publication/completion orchestration with
provider, model and check doubles. These results are **not live provider/product
acceptance**. The opt-in Docker fixture additionally proves a controller-owned
stop and retained-resource guards using one cached image, no mounts, no network
and a disposable test-owned local container:

```sh
AUTOPOD_RECOVERY_DOCKER_FIXTURE_IMAGE=sha256:... \
AUTOPOD_RECOVERY_DOCKER_FIXTURE_SOCKET=/path/to/local/docker.sock \
npx pnpm --filter @autopod/daemon exec vitest run src/pods/infrastructure-recovery.test.ts -t 'disposable local Docker'
```

It neither rebuilds an amd64 worker image nor proves Mac/Azure/Tailscale checks.
Do not downgrade to a binary unaware of retained recovery custody after admission.
