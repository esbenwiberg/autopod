# Exact-source adoption and fresh checks

**Controller, production guards, authenticated API and CLI are implemented;
release qualification is in progress. This is not a deployment, a live-pod
recovery receipt, or permission to bypass original execution uncertainty.**

An advanced human-repaired branch cannot be approved using an old pass or
force-pushed backwards. This operation preserves the old work, fast-forwards
only the requested exact source in both workspaces, and runs fresh checks.
**It never authorizes publication, approval, PR merge, cleanup or report release.**

## Supported controls (after releasing this version)

- `GET /pods/:podId/source-adoptions` reads durable operations, including failures
  and partial application after HTTP loss or daemon restart. It does not probe,
  wake or mutate a provider resource.
- `POST /pods/:podId/source-adoptions` admits an explicit authenticated human
  request: `id`, `expectedGeneration`, `oldHeadSha`, `targetHeadSha`,
  `dependencySetupCommand`, `reason`. Repository, worktree, provider/resource and
  actor identity come from the daemon, never caller-supplied paths/credentials.
- `ap source-recovery <pod-id> --json` inspects. To request adoption:

  ```sh
  ap source-recovery "$POD_ID" \
    --request-id "$RECOVERY_ID" --generation "$ORIGINAL_GENERATION" \
    --old-head "$ORIGINAL_FULL_SHA" --head "$REPAIRED_REMOTE_FULL_SHA" \
    --setup 'npm ci' --reason 'Validate this exact repaired source without delivery'
  ```

  Choose/retain the request ID BEFORE submitting. All six mutation flags are
  required; no omitted SHA/epoch is guessed. A repeated identical ID observes
  only that original request. Different input/actor conflicts. It cannot restart
  stopped work. A lost response requires observation, not another request ID,
  another worker, a grant, or blind replay.

## Admission and exclusivity

The coordinator checks original task-wide worker settlement and the OLD canonical
validation execution fence before invalidation or wake. Active controls,
validation/worker/recovery invocations, unanswered decisions, unacknowledged human
guidance, native Goals, interactive workspaces, validation phase bypasses and
uncertain publication/PR/merge admissions refuse adoption. **An old unconfirmed
publication is not retrospectively declared rejected.** Such legacy delivery
uncertainty needs separately supported evidence/reconciliation first.

Migrations219–221 bind immutable task/source/provider/resource/actor evidence,
monotonic phases, a unique active task owner, one checks invocation and witnessed
native command steps. The new controller composes them; it does not replace the
existing task execution/retry/usage ledger. There is no implicit waiver, new
retry grant, expiry or task-wide accounting reset.

A private connection-scoped async owner permits only the coordinator's epoch and
validation metadata updates. Competing facade mutations, lifecycle updates,
worker starts, source publication/PR/merge admissions, Kill/Delete, resource
cleanup and both sandbox reapers honor source custody. Pre-existing facade
controls remain visible through their external awaits, preventing a new source
claim while they are active. Read-only status remains available. Source checks
passing still leaves readiness risky and **delivery/report custody held**.

## Preservation and application

1. Bind exact repository/branch/base, generation, runtime/provider/account,
   original host/container commit and backend namespace. Docker binds the actual
   engine plus full inspected container ID; Azure binds configured endpoint,
   region/subscription/resource-group/group and original ID. Labels are not proof.
2. Observe/wake ONLY the original resource through the durable wakeup protocol.
   Unknown/deleted resources never allocate replacements. Legacy stopped Azure
   resources with unresolved old restore/copy outcomes remain blocked.
3. Independently archive ALL host and retained `/workspace` bytes, including
   ignored binary reports, dependencies and Git metadata, BEFORE fetching refs.
   Both copies must pass generation/path/content/mode receipts. Fresh private
   archives are physically disjoint from source, mode0700, never reused/chmodded.
   Existing bounds remain100k files/links,100k directories and1GiB per snapshot;
   oversize or partial capture fails closed without excluding files.
4. Fetch and pin the exact requested remote head through daemon-authenticated
   Git, refuse unexpected movement/non-FF/dirty or hidden/sparse/submodule source,
   and preserve old+target history in a SHA256-verified no-replace bundle.
   System Git/interpreter isolation and pre-status filter checks prevent repository
   imports, hooks, filters, grafts or replacement objects from falsifying identity.
5. Atomically capture prior canonical evidence, advance the epoch once, invalidate
   CURRENT validation/review/waiver evidence and admit mutation. Historical
   readiness/approval and original task/run/start-commit/accounting stay intact.
6. Apply the pinned source to both workspaces by local FF only, with
   `--no-overwrite-ignore`, no hooks/autostash/reset/clean/rebase/auto-commit/push
   or provider PR merge. Native command identity is admitted before start; only
   actually observed exit settles it. A negative signal exit is known non-success,
   not a fabricated zero or a transport sentinel. Partial success remains applying
   and held; there is no automatic second FF or rollback.

Private bundle transfer is bounded and verified on both ends. Writes are
single-attempt and ownership-fenced after auth. Docker tar must not widen parent
permissions; Sandbox source chunks avoid its buffered root chmod/chown path.
A lost chunk response stops before assembly, never retries the write. Originals
and snapshots remain retained. A fresh isolated local Docker fixture qualified
actual namespace/native exec/export/transfer/FF, ignored binary retention and
15 observed native command exits; its validation engine was mocked. Azure file/
mode behavior and actual hosted-pod validation remain unqualified.

## Fresh source-bound validation

The controller calls the real private `revalidateAdoptedSource` workflow, not
ordinary revalidate/pull/graft. It requires an already-invalidated result, exact
source ownership and explicit dependency preparation, claims ONE invocation,
executes full fresh checks/review and uses normal retry/execution admission.
Setup must actually pass for an overall pass to be accepted. There is no coding
worker, replacement/wakeup fallback, old review/pass reuse, control-plane publication,
publication-linked advisory QA, dependent dispatch, approval or merge. Repository
setup/check commands still execute code under the existing container credentials
and network policy; checks-only is NOT an OS-level read-only sandbox. Do not admit
setup scripts that themselves publish, merge or destroy work.

Ownership is rechecked after successful AND rejected awaits. Clean exact
host/container branch/head/tree AND requested remote head are verified around
checks and before canonical result publication. Unexpected tracked/lockfile
mutation fails closed. Returned results are retained as **unaccepted observations**
before certification; current proof is never relabelled from historical results.

## Deliberate limits and remaining recovery work

- Errors/crashes/lost transport retain phase, immutable evidence and originals;
  source/command/checks invocations do not automatically replay. A narrowly
  authenticated phase-aware reconciliation/recheck action is NOT yet exposed.
  Inspect status; do not edit the production DB or reuse ordinary worker recovery.
- Symlinks are archived as links, not their external targets. Reports outside
  `/workspace`, global caches, provider snapshot copies and complete dependency
  closure are NOT certified. Original resources can continue billing indefinitely.
- Verified report inventory and separately audited supported hold release remain
  unfinished. Checks success is not archive completeness or delivery permission.
- Existing no-merge and original PR-target constraints remain. External delivery
  is a separate provider observation, not permission to merge an open PR or mark
  an unrelated failed pod complete.
- Local tests use real SQLite/Git/filesystem and observed local process exits with
  a fake data plane/validation engine. They test orchestration, not live Azure,
  actual hosted-pod validation, full dependency closure or recovered old reports.
- Do not roll back to a retention-unaware binary after source custody exists.
  Prefer a retention-aware roll-forward. Force rollout still requires normal
  release gates and a fresh concrete interruption scope review.
