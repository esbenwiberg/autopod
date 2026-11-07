# Preservation-safe infrastructure recovery

`ap recover-infrastructure <pod>` is a separate, authenticated human control for a
failed **local Docker** task whose worker has settled and whose exact clean Git
source was preserved before a current-generation infrastructure report. It is
not ordinary Resume/Rework, a waiver, a retry-budget reset, or completion.
Interactive/Goal tasks, sidecars, shared resources, active or unknown executions,
disabled/thin validation, and missing independent review remain ineligible.
Uncollected guidance blocks checks-only recovery. An explicitly selected `rework`
may admit its one owned worker to collect the still-saved guidance through normal
`check_messages` delivery/acknowledgement. No operator marks it read: pending
human decisions still block admission, and unread or newly arriving guidance
blocks candidate sealing, fresh-check certification and delivery.

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
