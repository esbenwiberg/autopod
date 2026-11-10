# Recovery fork: conservative local-Docker slice

Recovery preserves the original pod, resource, host checkpoint and private evidence
permanently. It admits a separate child into the same logical task accounting.
Original budget, worker retries, validation attempts and PR-fix counters/limits
remain authoritative. PR/fix links, sessions, approvals and waivers are not inherited.

Only a clean host checkpoint from a settled original Docker/sandbox task is
supported. The new candidate must be Linux local Docker. Tracked credentials,
control paths, links, submodules, replacement refs, sparse indexes/checkouts,
assume-unchanged and skip-worktree entries are refused. Source inspection does
not change the original graph or metadata. No original configuration is copied
into the candidate Git directory. Selected supplemental files get exact literal
server-owned exclusions before normal cleanup, followed by actual candidate
byte/hash verification before coding. Daemon-generated evidence/screenshots keep
only their exact standard exclusions. After coding, an edited supplemental file
must be committed as regular source: its new bytes are then bound by the verified
HEAD/tree. Uncommitted or missing imported reference files remain blocked. This
after-coding allowance never changes initial-copy or pre-worker verification.

The immutable handoff packet keeps the original frozen handoff instructions in
`originalFrozenHandoffInstructions` and the new human instructions in
`humanContinuationInstructions`. Historical text is separately quoted. Runtime
sessions, reasoning and raw tool payloads are omitted. Chained recovery and
pointer-only prior recovery handoffs are explicitly unsupported; a same-path
packet inside a new container is never treated as the parent's packet.

Configuration cutover must be ready during eligibility and again inside atomic
child admission after asynchronous capability checks. Existing exact operation
replay and observation remain available when the gate closes.

Fresh passing checks and independent review record an immutable receipt binding
actual clean source before/after validation, generation, resource, frozen launch,
result and completed retry admission. The first authenticated human approval
can enter without prior approval; publication still requires a separate durable
human decision bound to that exact source/check receipt. Mutable readiness,
automation, inherited approvals and passing qualification alone cannot publish.

POST rejection proof is deliberately narrow. After authentication and strict
parsing, only known read-only selection/policy/binding errors before any claim
attempt can return HTTP 409 with:

```json
{
  "code": "RECOVERY_FORK_REJECTED_BEFORE_CLAIM",
  "parentPodId": "exact URL pod",
  "requestId": "exact immutable request.id",
  "expectedBinding": "exact request.expectedBinding",
  "noOperationCreated": true,
  "error": "Safe selection-rejection explanation",
  "reasonCode": "RECOVERY_FORK_SELECTION_STALE"
}
```

The coordinator must synchronously reconfirm that no existing/replayed/conflicting
source owner exists. Generic errors (including 404), unknown infrastructure errors,
claim attempts and every later failure carry no such proof. Unknown provider
status and unexpected Git ancestry errors remain unproved; only Git exit 1 is
established non-ancestry, even when a later GET
finds no operation. All responses use `Cache-Control: no-store`. Native reconsideration
still requires another authoritative exact-ID GET absence and explicit user discard;
this error never authorizes automatic resubmission or abandonment.

## Isolated local-Docker lifecycle fixture

The opt-in case in `packages/daemon/src/pods/recovery-fork.test.ts` exercises real Docker
allocation, identity/image/resource probes, production workspace reconstruction,
qualification, streaming process exit, Git commit/sync-back, the frozen build/test
commands, source-bound check receipts and separate human-actor approval. It also
checks exact request replay, shared logical-task identity, selected supplemental
bytes, original frozen instructions, automation refusal and unchanged original
row/source/resource state.

**This is synthetic integration proof, not live-provider qualification.** The
fixture launcher reports `0.0.0` and refuses model execution. Coding and review
are deterministic test adapters; the approval actor is supplied by the fixture,
not an HTTP authentication ceremony. Production image/tool installation, model
semantics, real human authentication and external publication are not certified.
Publication is deliberately refused at the worktree delivery boundary *after*
the immutable human decision is recorded; no remote receipt is fabricated.

The test only accepts an explicit cached immutable image ID and local Unix
socket. Creation is additionally constrained to synthetic-root mounts, no
network/ports/capabilities, no privilege escalation, one CPU, at most 2GiB RAM
with no extra swap, and 128 PIDs. It clears inherited image environment values,
uses only fixture account values, isolates runtime state under its temporary
root, journals exact UUID-labelled resources before start, refuses original
Start/exec/stop/removal, and verifies labels before fixture-only teardown.
The synthetic original is retained throughout the workflow; deleting that test
resource during teardown is not product release authority. Private JSON receipts
are retained separately, including failing stages and cleanup observations.

Build the synthetic image deliberately from a **previously cached linux/amd64
Node24+Git base**; inspect the base ID first. The test never builds or pulls.
The Dockerfile also supports a caller-selected cached base via `BASE_IMAGE`:

```sh
BASE_IMAGE=node:24-bookworm # must already exist locally; no registry login
# Verify the expected immutable ID/platform before building.
docker image inspect "$BASE_IMAGE" --format '{{.Id}} {{.Os}}/{{.Architecture}}'
docker build --pull=false --network=none --build-arg BASE_IMAGE="$BASE_IMAGE" \
  -t autopod-recovery-fork-fixture:local \
  packages/daemon/src/test-utils/fixtures/recovery-fork-docker
IMAGE=$(docker image inspect autopod-recovery-fork-fixture:local --format '{{.Id}}')
cd packages/daemon
AUTOPOD_RECOVERY_FORK_DOCKER_IMAGE="$IMAGE" \
AUTOPOD_RECOVERY_FORK_DOCKER_SOCKET=/absolute/path/to/local/docker.sock \
AUTOPOD_RECOVERY_FORK_DOCKER_RECEIPTS=/absolute/path/to/private/receipts \
  pnpm exec vitest run src/pods/recovery-fork.test.ts --maxWorkers=1
```

The same image can run `environment-qualification.docker.test.ts` using its
`AUTOPOD_QUALIFICATION_DOCKER_IMAGE`, `AUTOPOD_QUALIFICATION_DOCKER_SOCKET` and
`AUTOPOD_QUALIFICATION_DOCKER_RECEIPTS` variables. That separate real-Docker
fixture includes missing-launcher, image/resource mismatch, hidden source-change
and hostile Git-filter negative cases. Both fixtures skip by
default; ordinary green unit CI is not proof that either Docker fixture ran.
