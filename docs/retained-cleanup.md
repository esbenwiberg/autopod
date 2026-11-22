# Delete & free resources for retained Docker continuations

This backend action is separate from **Stop and retain**, legacy Kill/Delete,
archive, recovery, validation settlement and delivery. It removes the live
fleet row only after exact resource absence is independently observed. It
does not complete the task, pass checks, change approvals, or modify a PR.

## Qualify the host and task

Only use this on a Linux daemon with a local Unix-socket Docker Engine sharing
the daemon's host bind-mount paths. The daemon must be the exclusive controller
of the managed resources and their source directories. Do not run external
Docker or Git operations against them, expose the source to other host writers,
or run older/mixed binaries or multiple daemons against the same resources.
The daemon cannot fence external root/same-UID processes or Docker socket
administrators. No TCP or Docker Desktop qualification is supplied.

The supported slices are idle `failed` and `review_required`, or `killed` with an
exact **completed** Stop and retain receipt. In each case every guest execution,
including originals and replacements, must be observed stopped or absent. This
action never stops, restarts, wakes or force-removes a container. Pending Stop,
active or unverified work/checks/delivery, Goals, interactive and sidecar/test
topologies, linked work, rewriting/adoption/forks, specialized recovery and Azure
are out of scope. Migration 274's unpaged v1 **recorded** producer closure is a
prerequisite, not present-day custody. There is no backfill (including
`loud-ocelot`) and an archive flag is not authorization.

Preview checks exact full IDs/Engine, producer correlation labels, all bridge
endpoints and container references, the worktree and Git bind relationships,
and physical Git identities. A same-name replacement is not adopted. Host
deletion requires canonical protected paths, positive mount-table evidence,
no unexplained paths or registrations inside private roots, and bounded source
closure. Aliased mounts, nested repositories, unsupported permissions or
storage, and incomplete observations block rather than select a fallback.
Prior cleanup of a Git registration with its directory still present (or vice
versa) is **not** confirmed absence.

## Human API

Requests require a verified Entra delegated human token or the explicitly
enabled local development operator token. Pod/worker tokens, app-only tokens,
and anonymous callers are rejected. Responses carry `Cache-Control: no-store`.

- `GET /pods/:podId/retained-cleanup` returns `RetainedCleanupInspection`.
  An `eligible` plan has `version: 1`, `generation`, `binding`, `sessionId`
  (the durable task execution ID, not a runtime transcript ID), the ordered
  resources, `dataLoss`, `retained`, and `notReclaimed`. A `blocked` preview
  lists what could not be proven. `requested` points to the saved exact request.
- `POST /pods/:podId/retained-cleanup` takes exactly
  `{id, expectedGeneration, expectedBinding, expectedSessionId, reason, acknowledgeDataLoss: true}`.
  Copy the three exact reviewed values and save the full request with a stable
  ID before submission. Explain the decision in a meaningful reason (10–4000
  trimmed characters). No paths, provider identities, actor fields or override.
  Stale exact values, conflicting actor/body for an admitted ID, and competing
  IDs for an owned pod return 409 before effects. `blocked` (HTTP 200) means no
  request was admitted and no resources were removed by that POST.
- `GET /pods/:podId/retained-cleanup/:requestId` reads the exact durable
  `RetainedCleanupReceipt` including after fleet-row removal; 404 if not found.
  Neither GET creates a claim, advances effects, retries deletion or records absence.

## Read the outcome, not just the HTTP status

`pending` / `partial` (POST HTTP 202) retain exclusive ownership.
`removal_unconfirmed` indicates a dispatch marker, not a provider result.
Observe the exact receipt after an uncertain HTTP result. Explicitly resubmit
only the original normalized body as the original actor to reconcile: an
uncertain step is never dispatched again, including a crash after the journal
write but before the native call. An exact 404 on the pinned Docker Engine or
independent host path **and** registration absence can confirm a step. No
expiry releases custody. A persistent unknown requires investigation, not a
new key, legacy deletion or editing the database.

Containers precede bridges, then Git removes only exact registered checkouts.
Each independently prepared private root (bare store, snapshot, receipt and
bundle) follows its linked checkout. Snapshot Git links are unlinked, never
opened as a repository or traversed. No generic Git prune or recursive checkout
fallback is allowed. `deleted` (HTTP 200) requires positive absence of every
agreed target and an atomic History archive/fleet removal/receipt transaction.
Never infer that receipt from an absent fleet row.

Unpublished work, writable container layers/logs and local reports in the
listed roots are lost. External PRs/refs, shared Git stores (including their
local refs and objects), shared caches, volumes, images, separately stored
runtime state, input/report data and immutable review, validation, custody and
cost evidence are not deleted. This is not a billing estimate or an instruction
to reclaim shared storage.

## Desktop and CLI

On a retained failed or review-held Docker card, open **Delete & free
resources…** (also **Recovery → Free storage**). On a killed card, the
daemon still requires the exact completed **Stop and retain** receipt. Stop
and retain is a different Recovery action: it preserves storage. Review the
ordered Docker/host targets and their full identities, what will be lost, and
what will be kept. Enter a reason and acknowledge permanent loss before
submitting. If proof is unavailable (including runs without the producer
inventory), don't substitute Kill or ordinary Delete. Desktop uses recorded
checkpoint custody to route those cards to Recovery; an ordinary Docker pod
keeps its existing Delete action and daemon safety checks. On older daemons
that do not send the custody hint, ordinary controls still rely on those
server checks; there is no automatic destructive fallback. Existing Stop and
retain supports retained PR tasks; already-stopped eligible branch tasks can
use direct cleanup. Azure sandbox abandonment remains a separate control.

Desktop saves the exact normalized request before sending it, in a private
local journal keyed by daemon connection and pod. **Observe request** is
read-only; **Reconcile saved request** sends the same request only when you
choose it. Reopen the same daemon connection to recover an uncertain request.
If another client submitted it, Desktop can observe it but cannot recreate
that client's journal. Use the CLI's exact observation if the fleet row is
already gone.

```sh
ap cleanup-retained "$POD" --json       # preview only
# Copy the daemon identity, version, generation, binding and session ID
# from that exact eligible preview; choose and keep one stable request ID.
ap cleanup-retained "$POD" --apply --daemon-identity "$DAEMON" --plan-version 1 \
  --generation "$GENERATION" --binding "$BINDING" --session "$SESSION" \
  --request-id "$REQUEST_ID" --request-file "$JOURNAL" \
  --acknowledge-data-loss --reason 'Discard unpublished work after exporting needed files'
ap cleanup-retained "$POD" --observe --request-file "$JOURNAL"
# Without the file: --observe --request-id "$REQUEST_ID" (same daemon and pod).
ap cleanup-retained "$POD" --reconcile --request-file "$JOURNAL"
```

Apply needs a new file in a directory you control. The CLI writes the mode-0600
journal before dispatch; reconcile checks the configured daemon endpoint and
exact pod against it. Keep the file unchanged and use the original operator.
There is no automatic POST retry, even for auth or connection failures.
Inspect the output state: eligible, blocked, requested, pending, partial,
unsupported, missing or uncertain are not confirmed deletion. An exact
`deleted` receipt lists every agreed target as `confirmed_absent`.

## Schema and qualification

Migration **275** adds immutable task/resource claims, per-target dispatch and
absence facts, exact completion receipts and fences; never downgrade an owned
task to an unaware binary. The scoped tests use SQLite and disposable Git with
faked Docker calls, including uncertain outcomes after reopen. Native proof
uses the explicit fixture socket/Engine/image from
[the v1 inventory fixture](retained-allocation-inventory.md#fixture-qualification).
The native file includes a positive deletion and unrelated-endpoint refusal on
the isolated engine. Do not use the default Docker socket or existing workloads.
