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

- [x] Harness guard/deadline/cleanup tests pass; independent pre-live review complete.
- [x] One actual sandbox exercises the listed real adapter boundaries.
- [x] Exact ownership and deletion404 verified; immutable cache retained. Fresh live sandbox inventory was empty, so nonempty inventory preservation was not exercised.
- [x] Independent final review, hosted checks and integrated harness checks pass.

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

Fifteen tests pass: target/cache validation, forbidden HTTP mutation, durable
receipt/one-create ownership, header/body stalls, lost create response, WebSocket
target/stall/frame constraints, wrong-label/preexisting cleanup refusal, exact
discovery/deletion/preservation, unresolved absence, actual child death before
cleanup, separate cleanup deadline, and real bundled production create/readiness/
destroy through a synthetic transport, and exact owned-only resume constraints.
These tests prove local harness control;
they are not live Azure evidence. Syntax, targeted Biome, tracked secret scan
and diff checks are recorded in ignored `.autopod-data/reliability/r01c/`.

Phase1 stopped for coordinator pre-live review. At that checkpoint no Azure request,
sandbox creation, model invocation or hosted mutation had been performed by this
worker; live behavior and cloud teardown were unproven. A host/parent SIGKILL
or host outage still requires coordinator recovery from the private receipt;
the supervised child deadline does not claim resilience to losing the supervisor.

### Pre-live review correction

Coordinator/reviewer identified the missing resume allowance used by extraction
when a fresh sandbox GET is non-Running (or that GET fails). Running sandboxes
return early and do not POST resume, so this was a suspended/transient path gap.
The expanded fresh-source test forced Suspended and failed at the real client's
resume request with `mutation-path-denied`; the receipt is
`r01c/resume-before-fix.log`. The guard now permits only the owned sandbox's
empty-body POST resume during work, with explicit unrelated/body/cleanup denials.

The source-composition test also exercises archive upload, image/allocation reads,
buffered exec, native stream script staging/frames, file roundtrip, suspended
extraction, egress update and repeated destroy. Immediate synthetic stream frames
exposed an observation race where exitCode resolved before Readable data drained;
both harness and test now await stream completion before asserting content.
No production behavior changed. The revised head then paused for independent
pre-live review before any Azure qualification.

### First invocation — local input rejection before cloud access

The reviewed `1fccc187` invocation exited before creating a run receipt/directory
or launching a child: the existing Azure identity resource ID uses the legal
lowercase structural segment `resourcegroups`, while the harness required
`resourceGroups` case-sensitively. Zero Azure requests and zero create attempts
occurred. This is a harness preflight parser rejection, not a cloud qualification
failure. Private evidence is `r01c/phase2-local-rejection.json`.

The identity syntax check now accepts ARM structural casing without changing the
original target string; the provider-name dot remains literal. A dedicated test
reproduced the rejection before the fix and also rejects extra path segments and
other provider names. All exact account/group/cache/ownership checks and budgets
remain unchanged. Coordinator and independent reviewer cleared the corrected
head after all fifteen local tests passed, before the subsequent invocation.

## Phase2 live outcome — bounded adapter qualification proven

Executed the unchanged reviewed harness at
`44e4f39fabc192db31a915ee054b8268e978577a` against the exact private selected target.
Fresh preflight passed and exactly one S-tier create request returned HTTP200.
The work child and separate cleanup child both exited0 without reaching their
deadlines. Total elapsed time was26,863ms;33 HTTP requests were recorded with no
guard violations, disk-image/group/registry mutations or model requests.

Passed actual boundaries: spawn and exact image digest/provider allocation;
buffered marker with exit7; native streaming with exact stdout/stderr and exit7
(three stdout chunks over2,020ms); exact file write/read; synthetic workspace
upload and subdirectory extraction; deny-all policy update/readback; normal kill,
repeated kill and provider GET404. This verifies policy configuration, not actual
external firewall enforcement. No repository was uploaded.

The fresh live baseline was an empty sandbox inventory. Earlier read-only research
had observed another sandbox, but it was already absent at this run's preflight.
Therefore this run does not prove nonempty unrelated-inventory preservation.
Local guard tests separately prove refusal to mutate unrelated/preexisting IDs.
The exact immutable cached image remained present. Independent cleanup verified
the accepted owned ID returned404, and both owned local workspace and bundle
directories were removed. Coordinator then independently performed three bounded
read-only data-plane GETs confirming owned-ID404, empty remaining inventory, and
matching immutable cache; no additional create was needed.

Private worker evidence:
- `.autopod-data/reliability/r01c/r01c-4cb46cf8-2500-4df7-9da4-8040dfd2b55e/receipt.json`
- `.autopod-data/reliability/r01c/live-proof.json`
- `.autopod-data/reliability/r01c/phase1-proof.json` and local test/static logs

Coordinator's independent post-cleanup evidence is in the integration worktree:
`.autopod-data/reliability/r01c/root-cloud-check.{mjs,json,log}`.

Hashes verified against the unchanged tested files and142 bundled source inputs:
- Harness: `72cf283d09d79c41f6a7146b6f62e07755337e90204d8e95fa2a4e41c6d96d69`
- Guard: `4496a688014347bacc5c1d6b20f725eab111074289776620a5f57ff0d9ae1ad2`
- Bundle: `ecc8607dc42a17b8600a879f22d929ee745480668ee75a3263fc8273ffd4a162`
- Receipt: `d949f0239a26d159292889e01203bdaa7748ef189bcaea31ea3248d378dfae45`

Final independent diff/evidence review and hosted/integrated checks remain pending.
Only these sanitized plan notes change after the tested code head; no further live
instance is needed for a documentation-only commit. The proof covers the campaign
host adapter against one historical immutable worker image. It does not cover a
new worker image, model execution, full daemon startup or complete pod lifecycle.

## Coordinator integration proof

Root reviewed the final documentation-only diff, checked harness/guard/live receipt hashes, reran all15 local guard tests and independently queried the provider for owned-ID404, empty inventory and retained immutable cache. Hosted general/secret checks passed (run38796613803); all15 local tests passed again after campaign mergef818a8b3. No further live create was performed; the tested adapter and harness sources are unchanged. Fresh empty initial inventory means nonempty unrelated-inventory preservation remains outside live proof.

Integrated commands and results: `.autopod-data/reliability/qualification-integrated.log`. PR #429 targets the campaign branch.
