# R01c: bounded real native sandbox adapter qualification

## Authorization and scope

User preapproved real pods and autonomous branch-contained reliability validation.
Research is `../research/2026-10-15-live-validation-availability.md`, including its
native follow-up. Qualify existing campaign host-adapter behavior against one
existing, digest-pinned historical image. No model, provider token, repository
upload, hosted daemon deployment, disk-image/group mutation or unrelated sandbox
change. This is qualification infrastructure, not a new product feature.

Root owns this plan. All implementation phases are authorized; independently
review the harness before its first live mutation and review final evidence before
PR. This is coordinator review, not a request for new user permission.

## Verified source boundary

`scripts/smoke-sandbox-adapter.mjs` exercises actual manager spawn, buffered/streamed
exec, files, workspace upload/extraction and egress update, but uses static labels
and lacks whole-run ownership/deadline protection. AzureSandboxApiClient supports
credential/fetch seams. Manager supports injected actual client and onCreated.
Use the actual current source, bundled with repository esbuild or fresh daemon
build, without changing these production classes. Record source and harness hashes.

## Phase1: bounded qualification harness

Create a separate opt-in script under scripts (with narrow supporting script files
only if needed). Input is an explicit private selected-target JSON path, never
implicit defaults or committed account IDs. Fail closed on missing/invalid exact
subscription/group/location/immutable image/ready-disk ID. Use current authenticated
Azure CLI account via explicitly injected AzureCliCredential (not the default
credential chain); verify matching subscription and
record metadata without token values. No login or registry exchange.

One unique run/pod label and one create attempt, tierS (1GiB/0.5CPU), synthetic
files under a private temporary directory, no exposed ports. Main work budget
10minutes; reserve a separate6minute cleanup budget. Per-request/body timeout
at most30seconds (create may use60seconds); total bounds must terminate pending
work, not just race a promise while it keeps issuing requests. Use a supervised
child or equivalent cancellable owned run. Ensure an independent cleanup path
still executes on child failure/deadline. Parent must retain the run label before
any request and accepted sandbox ID as soon as the response is observed.

Use a forwarding fetch guard around the actual Azure client. Permit only the
selected data endpoint/group. GETs may inspect that group; any sandbox mutation
must belong to this run. Reject ARM/group/registry/disk-image mutations and reject
any second create attempt. Before forwarding the first create, check exact image
ID/tier/unique labels/policy and persist the intended receipt. Capture successful
create response ID before client readiness polling. After create, permit mutations
only on that ID. Cleanup discovery may adopt an ID only when a fresh full object
has exact unique podId+managedBy labels and is not in the initial inventory.
Never delete based solely on a group-wide before/after difference.

Fresh preflight must confirm selected Ready immutable cache identity, no stale
same-source images, target account and group, and capture initial unrelated IDs.
Native streaming bypasses fetch: inject a forwarding webSocket factory that
allows only exact selected wss endpoint + accepted owned sandbox ID + /exec/stream.
Preserve production frames and headers, enforce bounded connection/lifetime and
frame/output sizes, and close every owned socket on deadline/failure. Its local
tests must reject wrong endpoint/ID and bound a stalled connection. Do not log
handshake headers. This seam constrains the live qualification, not production.
Guard denied calls fail the proof; do not transparently rewrite production requests.
Record safe request method/path/status/counts, never Authorization or token bodies.
All synthetic payload/output is bounded; suppress arbitrary remote/log payloads.

## Phase2: live boundary assertions

Execute one instance after independent harness review. Do not run generic smoke
in parallel. Use real manager methods with the exact built campaign source:
- Spawn deny-all with a tiny host workspace; confirm actual image digest and
  provider allocation on the returned sandbox, plus unique ownership.
- Buffered exec observes an exact marker and nonzero exit (e.g.7).
- Streaming exec observes multiple deliberately spaced markers, stderr marker and
  exit7; assert content/exit. Record actual arrival spread; buffered delivery is a
  failed streaming-timing claim, not silently accepted success.
- Write/read exact synthetic file bytes. Copy uploaded input into a unique
  subdirectory under /workspace, generate output, extract only that subdirectory
  into a distinct owned host directory and assert both exact files.
- Egress refresh remains deny-all; GET observed policy matches. No external probe
  or claim of firewall enforcement is needed.
- Exercise normal manager.kill and verify a separate provider GET404. Repeated
  kill stays harmless. Existing unrelated IDs and immutable cache remain present.

Always cleanup on any failure, including before spawn resolves. Stop main child
before cleanup to prevent late requests. Discover only the exact unique label,
reconcile accepted receipt with full object labels, destroy owned IDs and observe
404. A timed-out/unknown create cannot be retried. If no accepted ID is available,
use bounded discovery through the request/readiness uncertainty window and record
any unresolved absence honestly. Preserve the receipt and continue coordinator
cleanup if deletion cannot be confirmed; never claim success with unproven teardown.
Remove owned local temporary resources regardless of cloud cleanup result.

## Phase3: evidence and integration

Before live execution, test the harness's forwarding guard and ownership/deadline
cleanup with local synthetic transport or child fixtures: forbidden mutation,
second create, response/body stall, child failure after receipt, wrong-label/preexisting
resource refusal, and deadline followed by cleanup. These tests prove harness
control only. Do not fake live results. Run syntax/static/secret checks.

Record final source SHA/hash, target image digest, one-create bound, resource/time
bounds, every boundary outcome, actual provider ID and confirmed404, unrelated
resource preservation, commands and logs in ignored `.autopod-data/reliability/r01c/`.
Keep exact account/IDs private; tracked plan contains sanitized outcome and hashes.
Root independently reviews final diff and receipts before PR into codex/reliability.
Hosted checks plus local harness checks on integration; do not rerun a paid live
instance just because a docs-only merge changes SHA. Any source-affecting change
requires affected revalidation.

## Acceptance

- [ ] Harness guard/deadline/cleanup tests pass; independent pre-live review complete.
- [ ] One actual sandbox exercises the listed real adapter boundaries.
- [ ] Exact ownership and deletion404 verified; other resources preserved.
- [ ] Independent final review, hosted checks and integrated harness checks pass.

## Limitations and rollback

No product API/schema/UI changes. Remove the opt-in qualification script to revert.
No automatic live CI, spend monitor or scheduled task. No assertion about a new
worker image, model execution, full daemon bootstrap or complete pod lifecycle.
No human judgment check is needed for these deterministic adapter assertions.

## Independent plan review

research_lifecycle confirmed the observed target, S-tier and existing cleanup APIs.
Review caught streaming bypassing the fetch seam; root added an independently
guarded forwarding WebSocket and wrong-target/stall tests. Explicit AzureCliCredential
keeps account preflight and runtime identity on the same existing credential source.
No unresolved plan decisions remain.

## Phase1 implementation and local proof

Implemented the opt-in `scripts/qualify-native-sandbox.mjs`, its transport/process
guard in `scripts/lib/native-sandbox-qualification.mjs`, and co-located local
Node tests. No production adapter, package dependency or UI changes. The script
bundles current adapter source with esbuild, records input/bundle/lockfile/harness
hashes, and uses AzureCliCredential pinned to the selected subscription and the
data-plane token scope. It never uses the default credential chain.

The parent supervises a ten-minute work child, waits for that process to exit,
then starts a separate six-minute cleanup child. Atomic private receipts persist
create intent before forwarding and the accepted ID before readiness polling.
HTTP guards enforce exact create payload, one create, selected target, fresh
ownership, deny-all egress, and forbid disk/group/registry/port mutations.
WebSocket guards forward the production protocol while bounding target, duration
and payload size. Cleanup refuses unrelated/preexisting objects and leaves an
unknown create unresolved rather than declaring success from an empty list.

Local proof command (Node22/pnpm9.15.4):

```sh
npx -y -p node@22 -p pnpm@9.15.4 -c 'node --test scripts/qualify-native-sandbox.test.mjs'
```

Thirteen tests pass: target/cache validation, forbidden HTTP mutation, durable
receipt/one-create ownership, header/body stalls, lost create response, WebSocket
target/stall/frame constraints, wrong-label/preexisting cleanup refusal, exact
discovery/deletion/preservation, unresolved absence, actual child death before
cleanup, separate cleanup deadline, and real bundled production create/readiness/
destroy through a synthetic transport. These tests prove local harness control;
they are not live Azure evidence. Syntax, targeted Biome, tracked secret scan
and diff checks are recorded in ignored `.autopod-data/reliability/r01c/`.

Phase1 stops for coordinator pre-live review. No Azure request, sandbox creation,
model invocation or hosted mutation was performed by this worker. Phase2/live
behavior and all cloud teardown assertions remain unproven. A host/parent SIGKILL
or host outage still requires coordinator recovery from the private receipt;
the supervised child deadline does not claim resilience to losing the supervisor.
