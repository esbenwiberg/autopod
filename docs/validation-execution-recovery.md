# Reconciling an unverified validation execution

This path inspects and fences the exact old execution. Destructive reconciliation is
unavailable without provider final-content proof. It does not pass tests, waive validation,
observe an exit code, grant a retry, reset task allowances, or start a worker. The original
failed result, partial output, attempt, metered usage and admission remain unchanged.
Worker `reconcile-termination` and native Goal process receipts are separate evidence.

## Inspect first

After deployment of this implementation, use the full pod ID:

```sh
ap reconcile-validation <full-pod-id> --json
ap retry-state <full-pod-id> --stage validation --json
ap retry-state <full-pod-id> --stage worker --json
```

The first command is read only, including when the provider is unavailable. Its state
contains `generation`, `validationTimestamp`, `resultHash`, immutable `dispatchId` and
`binding`, `required`, `allowed`, `settled`, `operation`, `receipt`, and audited
`testBudgets`, and `preservationAttempts` with exact attempt IDs/outcomes. Eligibility is advisory; every mutation checks the current identity again.
A binding includes exact task, pod, lifecycle generation, finalization cycle, attempt,
admission, sandbox UUID, provider namespace, retained worktree and provider/config digest.
Current mutable container IDs, human assertions and provenance alone are insufficient.
Unsettled immutable validation dispatches also retain their exact resource in the
daemon's orphan reference set, even if the mutable pod pointer is cleared. The
claim cannot be released by the currently unsupported destructive recovery path;
clearing a pointer is not proof.

`VALIDATION_LEGACY_OWNERSHIP_UNAVAILABLE` means there is no maintained immutable
validation dispatch/result/resource join. A historical result without cleanup diagnostics
can expose exact ownership **if that exact join exists**; missing timeout metadata
is distinct from the provider final-content proof gap. Destructive reconciliation
remains unavailable even with that join. Releases before this ledger did not record that join. No migration fabricates
one from a worker run, current sandbox, provenance ID or timestamp proximity. Do not insert
records manually to overcome this rejection. Retain the pod and escalate the missing
historical evidence to the operator. Missing historical bindings remain unavailable;
this implementation does not claim recovery of a previously unverified execution.
Partial output can contain real assertion failures and must not be relabelled a passing suite.

Migration 222 introduces immutable recovery evidence above schema version 221.
The bounded design does not authorize live recovery.
Migration 223 separately retains immutable engine-returned outcomes before retry
admission closes. It does not rewrite migration 222 or backfill guessed outcomes.
Migration 224 distinguishes exactly-once logical history/completion publication
from intermediate infrastructure-attempt evidence and accounting. Intermediate
attempts remain inspectable without duplicating the logical history or resetting
retry allowances; this never closes an unknown-termination fence.

If a daemon stopped between dispatch/outcome recording and publication, inspection
returns `VALIDATION_RESULT_PUBLICATION_UNVERIFIED` with the exact retained dispatch
binding and available outcome hash. Task-wide execution and ordinary deletion remain
blocked even when the pod's published result is older or absent. This operation does
not invent a published result or replay checks to resolve that case; preserve its
source/reports and escalate the saved admission/publication evidence for repair.

## Destructive reconciliation is blocked

The current ordinary-validation provider adapter cannot establish exact-execution
quiescence or a qualified immutable final-content snapshot. Reconciliation returns
`VALIDATION_FINAL_CONTENT_UNVERIFIED` before any resume, checkpoint, export or
deletion. A host snapshot verified earlier can still omit source or ignored reports
written later by the unknown execution. A stopped/suspended resource and an older
export do not close this race, including after daemon restart.

The authenticated, generation/result-bound request remains explicit:

```sh
ap reconcile-validation <full-pod-id> --apply \
  --generation <generation> --result-hash <resultHash> \
  --reason 'Inspect exact recovery prerequisites while retaining original evidence'
```

This request cannot currently delete or settle an unknown validation execution.
Retain original resources and escalate the provider-proof limitation. There is no
force, human-assertion, worker/Goal-receipt or snapshot-reuse bypass. Old deletion
receipts remain inspectable but cannot certify final report preservation or unlock
retry. Existing source custody, wakeup, external-delivery, lifecycle and task-wide
execution fences remain authoritative. GET inspection never contacts the provider
or changes the resource.

Final destructive recovery needs a supported provider capability and new exact-byte
qualification. This implementation must not be described as recovering the supplied
legacy incident. Its original partial output includes real failing assertions.

## Read immutable retained evidence

Authenticated humans can retrieve the original published result or immutable
unpublished engine outcome and its partial console output independently of current
worktree/resource pointers. The response explicitly identifies `evidenceKind` as
`published-result` or `outcome`; reading an outcome does not publish or settle it:

```text
GET /pods/<full-pod-id>/validation-execution-evidence/<dispatchId>?resultHash=<resultHash>
GET /pods/<full-pod-id>/validation-execution-evidence/<dispatchId>?resultHash=<resultHash>&path=reports%2Ffailed-tests.xml
```

The second request returns at most 5 MiB as base64 from a retained preservation
snapshot, after verifying its original generation/cycle inventory receipt before
and after the read. No worktree fallback is used. Traversal, absolute paths and links
are rejected; missing, changed or corrupt saved bytes stay blocked. The first request
reports whether a snapshot was retained. These are historical exported bytes, not
proof that the unknown execution could not subsequently update its original reports.
Wrong pod/dispatch/result bindings are rejected even after code repair changes the
current worktree. Requests require the existing authenticated human API transport;
no worker token, provider access or production command is needed for local tests.

## Select a finite recovery budget separately

Frozen setup settings are not rewritten. To select one test budget for the next admitted
sandbox validation in this generation or its immediately following repair generation:

```sh
ap validation-recovery-budget <full-pod-id> --seconds 900 \
  --generation <generation> --result-hash <resultHash> \
  --reason 'Measured healthy full suite took 732.08 seconds; use finite headroom'
```

Select this **after settlement**, before requesting repair. This is an audited one-shot
selection of 1–3600 **seconds**, expiring after one hour. Inspection includes the selection,
expiry and consuming dispatch. Engine input converts seconds to milliseconds before
capturing retry identity; timeouts participate in the command-input hash. It is consumed
once at dispatch and does not apply to later automatic infrastructure retries. If it expires
before dispatch, frozen settings apply; inspect expiry before proceeding. No current preset
or unrelated setting is adopted. Neither selection nor consumption grants retry permission,
changes historical duration, proves termination or resets task-wide accounting.
An unused selection cannot apply to a different completed failure. It can survive
the existing repair flow clearing the old result only in the immediately following
generation, with the same task and provider/config binding.

## Retry authorization, checks, and repair are separate

Review the original assertion failures and the validation/worker retry ledgers. If required,
record a normal stage-specific retry authorization through `ap authorize-retry --help`
(or the desktop authorization cards) before requesting work. Provider/source bindings,
usage budgets, active-execution fences and task retry admissions still apply.

When inspection says a stage requires a grant, the supported commands are:

```sh
ap authorize-retry <full-pod-id> --stage validation --request-key <stable-validation-key> \
  --reason 'Reviewed original evidence; authorize one validation repeat' --json
ap authorize-retry <full-pod-id> --stage worker --request-key <stable-worker-key> \
  --reason 'Reviewed original assertions; authorize one code repair worker' --json
```

Request only the stage grants required by its ledger, reusing the same request key
after a lost response. A validation grant is separate from permission for a worker.
For checks on an eligible retained resource, the desktop's **Retry checks** submits
the generation/timestamp-bound `retry-checks` API request documented in
[validation recovery](validation-recovery.md#authenticated-recovery-api).

Use **Fix validation** (or `ap rework <full-pod-id>`) to request a coding worker and normal
validation/delivery policy. After sandbox deletion, **Retry checks** remains unavailable
because there is no retained execution resource; it does not silently re-provision through
a publication-capable workflow. On retained resources with verified/observed termination,
Retry checks uses the existing checks-only operation: no coding worker, publication, PR,
dependents, approval or merge. Reconciliation itself never initiates either operation.

The desktop shows the read-only inspection command when termination proof is required;
repair/check controls stay disabled until their daemon gates allow them. Do not use generic
Resume, retry authorization or a validation waiver to settle an unknown execution.

## API

- `GET /pods/:podId/validation-execution-recovery`: read-only state above.
- `POST /pods/:podId/validation-execution-recovery`: `{expectedGeneration,
  expectedResultHash, reason}`. Validates actor and exact result, then refuses unsupported
  destructive recovery. It performs no provider inspection, resume, export or deletion.
- `GET /pods/:podId/validation-execution-evidence/:dispatchId?resultHash=...&path=...`:
  authenticated immutable result/report access; omit `path` to inspect the original result.
- `POST /pods/:podId/validation-recovery-budget`: the same exact-result fields plus
  `testTimeoutSeconds`. No retry or settlement permission is implied.

Mutation bodies are strict; callers cannot submit resource identity, proof or exit codes.
The audit actor comes from authenticated human identity, not the request body.
