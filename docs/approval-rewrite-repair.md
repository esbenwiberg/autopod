# Repair a failed approval rewrite without releasing custody

This is a control-plane source selection, not execution of the held business task.
It requires a release containing these routes. CLI help alone does not establish
server support. No deployment or live recovery is authorized by this document.

The recorded decision USlTDWJt limits this slice to sandbox rewrites with an exact,
settled immutable checks dispatch and logical failed-result publication. Docker
and historical unbound failures refuse admission. Ordinary checkpoint recovery,
source adoption, Resume and Rework remain blocked while a rewrite owns source.

## Preconditions

Use an authenticated human identity and the complete pod ID. Inspect first:

```sh
ap approval-rewrite-repair "$POD_ID" --json
ap source-recovery "$POD_ID" --json
ap reconcile-validation "$POD_ID" --json
ap retry-state "$POD_ID" --stage validation --json
```

The current failed/review-required selection must belong to the exact activated
rewrite, repository, PR, branch, base, frozen configuration, failed dispatch and
result. Its host HEAD/tree must still match the failed candidate. The immutable
validation dispatch must bind that lifecycle, provider namespace and resource;
no coding worker may have run in that lifecycle. The original resource must be
known stopped. Active or unknown workers/checks/wakeups/publications/merges,
pending decisions/guidance, competing custody, compromised source, sidecars,
Goals, interactive/artifact tasks, thin/off/waived review remain blockers.

**Authorized operator access to the daemon's prepared checkout is necessary.**
This feature supplies no SSH, host-command execution, upload, arbitrary path
selection or remote administration. If that access is unavailable, preparation
cannot by itself enable manual repair. Do not circumvent the host boundary.

## Prepare, repair, select

Choose a stable request ID before submission. Copy current identities from
supported read-only status and execution evidence; never infer a dispatch from
an incident narrative or supply a worker's asserted proof.

```sh
ap approval-rewrite-repair "$POD_ID" --prepare \
  --request-id "$REPAIR_ID" --rewrite-id "$REWRITE_ID" \
  --failed-dispatch-id "$FAILED_DISPATCH_ID" --generation "$FAILED_GENERATION" \
  --result-hash "$FAILED_RESULT_SHA256" --head "$FAILED_HOST_FULL_SHA" \
  --reason 'Prepare an independent checkout for the authorized targeted repair' --json
```

Preparation does not change lifecycle, start a coding worker/check, publish,
approve, grant retry or release anything. It creates an independent Git store
under the daemon's checkpoint-recoveries namespace from the exact failed source.
The original pre-rebase source/resource and failed candidate/resource/reports
remain held. The failed result/review and artifact path are retained in immutable
custody evidence. Host capture preserves all bytes, including ignored artifact bytes. Dirty tracked
or untracked Git source is refused; uncertified/oversize/partial capture fails closed. Existing inventory and 1 GiB
bounds apply. This is host capture, not certification of inaccessible sandbox
reports or dependency closure; those original resources stay untouched.

Observe `operations[].prepared.worktree`. An authorized operator must repair and
commit **only inside that independent checkout**. Follow the selected repository's
instructions and the original task scope. No task amendment, execution-profile,
workflow, permissions, references, tool-pack or timeout replacement is supported.
Do not publish the repair manually or edit either retained original. Then:

```sh
ap approval-rewrite-repair "$POD_ID" --check \
  --request-id "$REPAIR_ID" --rewrite-id "$REWRITE_ID" \
  --failed-dispatch-id "$FAILED_DISPATCH_ID" --generation "$FAILED_GENERATION" \
  --result-hash "$FAILED_RESULT_SHA256" --candidate-head "$REPAIRED_FULL_SHA" \
  --reason 'Select this exact committed repair for fresh configured checks and review' --json
```

The preparing human must also select. The daemon verifies its private Git
namespace, clean branch/head/tree, ancestry, repository and unchanged failed
selection around observations. Grafts/replacements/alternates, aliases, dirty,
unrelated or substituted source are refused. The atomic selection advances one
lifecycle and the existing credential epoch, detaches only after the resource
hold is durable, invalidates current validation/review, and queues checks-only
provisioning. Task identity, configuration, counters and original lease remain.

Repeat accepted requests with identical payload and actor only to observe their
receipt. Changed-payload/actor replays conflict. A response lost after commit or
enqueue is not permission to prepare or execute again. There is one candidate
selection/checks invocation per repair, including across restart. Incomplete
preparation, lost admission, interrupted checks or missing completion capture stay
inspectable and held; there is no clear/reset/replay operation. A further repair
of a failed repair is deliberately not admitted through ordinary continuation.

## Retry and outcome

A separate existing authenticated retry authorization is required before the
repair's validation admission. Inspect retry state and use the existing
`ap authorize-retry` operation with explicit human authority and a stable request
key when appropriate, before submitting `--check`:

```sh
ap authorize-retry "$POD_ID" --stage validation --request-key "$RETRY_REQUEST_KEY" \
  --rewrite-repair "$REPAIR_ID" --candidate-head "$REPAIRED_FULL_SHA" \
  --candidate-tree "$REPAIRED_TREE_FULL_SHA" \
  --reason 'Authorize one check of the explicitly prepared rewrite repair; preserve all budgets and holds' --json
```

The generic retry operation is permission only. Do not use Resume/Rework after it;
those remain blocked for rewrite custody. Targeted grants use a distinct retry-authorization route that old daemons refuse;
the CLI verifies the returned target and never falls back to a generic grant.
Obtain the exact commit and tree in the prepared checkout with
`git rev-parse HEAD HEAD^{tree}`. Source changes do not grant a retry, reset counters or
expand budgets. The daemon binds this targeted grant to the prepared operation, exact prospective
commit/tree, failed dispatch, frozen configuration/request and next generation.
Selection must independently prove those Git identities; the grant is not source
proof. Generic or earlier task grants and grants for another candidate cannot
admit repair checks. The normal admission consumes the exact matched grant once. A consumed grant cannot admit another
validation for this repair, including automatic infrastructure correction.
Selection without a grant can remain held; it is not a passing check receipt or
an automatically replayable queue entry. Arrange separate permission before its
queued execution when needed. This implementation grants no live retry authority.

Read-only status distinguishes the original rewrite plus repair preparing,
prepared, checking, held and checked. Operation history retains old bindings and
failed evidence; the rewrite projection shows the CURRENT selected source.
Checks use the frozen configured setup/build/test/lint/review phases as applicable,
require fresh independent review and capture new reports. They start no coding
worker and never push, update a PR, auto-approve, merge, dispatch dependents or
clean up originals. Failure/interruption/timeout or incomplete report capture
holds the selection. A pass stops at validated awaiting separate fresh human
approval; earlier results, sibling results and old taskReview do not certify it.

Later ordinary approval still checks exact repository/PR/base/source bindings
and publishes only using the original recorded predecessor SHA lease. Remote
advancement/deletion, target drift or uncertain push/merge refuses mutation.
If main advances, ordinary approval must prepare another isolated rewrite and
run fresh checks; it cannot certify the repair against the wrong base. Neither
repair request is approval or publication authority.

## API, release and qualification

Human-only, strict JSON endpoints:

- `GET /pods/:podId/approval-rewrite-repair`: read-only rewrite and custody history.
- `POST /pods/:podId/approval-rewrite-repair`: `id`, `rewriteId`, `failedDispatchId`,
  `expectedGeneration`, `expectedResultHash`, `checkpointHead`, `reason`.
- `POST /pods/:podId/approval-rewrite-repair/:recoveryId/check`: `rewriteId`,
  `failedDispatchId`, `expectedGeneration`, `expectedResultHash`, `candidateHead`,
  `reason`.
- `POST /pods/:podId/retry-authorizations/rewrite-repair`: the existing validation
  retry operation through a dedicated transport, with `requestKey`, `reason`, and
  strict `rewriteRepair: {recoveryId, candidateHead, candidateTree}` for one
  prospective repair selection. Additional binding fields
  are server-derived. It neither selects source nor starts checks.

Actor comes from authentication. Unknown fields (including paths, force, config,
result/proof, budgets and execution overrides) fail. Old servers fail the new
routes; the CLI has no Resume/approve/continuation fallback.

This extends the append-only schema234 rewrite and schema235 checkpoint selection
records using explicit rewrite bindings. Fresh migration236 adds a nullable exact
repair target to existing retry authorizations and a storage-level use fence;
historical grants retain their original authority. No historical migration changes.
Check prefix uniqueness when integrating another branch before release. Back up and qualify a retention-aware release before use.
Do not downgrade to a binary unaware of repair selection: it cannot interpret the
current source projection. Roll forward with preserved database, sources,
resources and reports. No hold release or historical-resource deletion protocol
is provided, even after completion. They can continue consuming storage/capacity.

Regression tests use actual temporary Git repositories, SQLite lifecycle facts
and the real manager checks-only path with mocked provider/validation engines.
They do not qualify live Azure capture, actual task checks/model review, native
Docker recovery or desktop/macOS behavior. Release qualification and operator
checkout access remain separate prerequisites. No live incident is mutated by
these tests.
