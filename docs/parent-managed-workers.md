# Parent-scoped managed workers: first slice

Starting source for pod `smiling-lion`: `d0614dc1ca78b74e384328f7c42fd5130f3c9ca0`
(verified against the materialized checkout before editing).

This connects an ordinary, real fleet launch to the existing managed admission and
continuation scheduler. A parent runtime can request one confined, report-producing
worker by recipe and bounded brief. It does not implement a research-to-code pipeline.

## Operator setup

Use a **new version 1 operator enrollment**, new slot/run, new signed source custody
and managed profile set. Do not modify an inspection enrollment or adopt an existing
worker. Existing enrollments without `parent` retain their report-only controller path.
The existing enrollment packet/signature procedure still applies: checks and review
must bind the base policy, including this new parent selection. No worker can mint
these receipts or edit the daemon enrollment.

1. Prepare a normal composable Task launch with an explicit new UUID `requestId`.
   Preview it without launching, and retain its exact launch digest. Select restricted
   egress, read-only GitHub rules, no PIM or deployment, and approval completion.
   Provider, environment and repository provisioning remain ordinary launch components.
   Put the UUID in `parent-launch.json` and run
   `ap run --config parent-launch.json --preview --json`.
   Once reviewed, add the exact preview digest as `expectedDigest` and set
   `"requireParentEnrollment": true` in that launch file. Keep the original request
   UUID. This opt-in refuses admission with `PARENT_ENROLLMENT_REQUIRED` if the
   signed enrollment is not active for that UUID; it never falls back to an ordinary
   Task. Older clients and daemons reject the unknown field. Do not remove the
   guard or replace the UUID as a retry.
2. Add this optional field to the new version 1 enrollment draft before generating its
   checks/review receipts:

   ```json
   { "parent": { "requestId": "<future launch UUID>", "launchDigest": "<64 hex launch digest>" } }
   ```

   Keep the existing managed recipe catalog, source bundle/commit, profile/account and
   execution target pins and finite `budget.requests`, `budget.active` and
   `budget.workers`. They are operator inputs, never parent tool parameters. Current
   enrolled recipes remain confined to repository reads and required `report.md`
   export, with no source publication, network destinations or identity bindings.
   The enrollment's host-controller `main` pin remains in the signed envelope but is
   not invoked for a parent slot; the actual parent model/account comes from its
   independently frozen normal launch.
   Use the existing `enrollment-packet-cli` `preflight`, `packet`, evaluator
   `statement`/`receipt`, and `assemble` modes with a separate packet directory.
   Its fixed source filename remains `inspection.bundle` for compatibility; it
   contains the new enrollment's bundle, never an existing worker. `owner` mode
   refuses parent drafts: parent authority requires version 1 countersignatures.
3. Enroll through the existing daemon-owned operator configuration procedure, then
   launch the exact preview as the enrolled operator. This implementation does not
   change production configuration or restart the hosted daemon. The selected request
   must still be a future launch when this composition is installed. Admission
   checks the enrolled issuer, audience and object ID from the authenticated
   request and commits the parent binding with the ordinary launch snapshot.
   This lets the daemon recover an admitted parent even before first provisioning,
   without adopting a previously unrelated pod.
   The reviewed envelope is `AUTOPOD_OPERATOR_ENROLLMENT`; use a separately
   partitioned `AUTOPOD_OPERATOR_PROFILE_SET` and the existing managed CLI owner
   bindings. Setting these is operator deployment work, outside this PR's execution.
4. Parent provisioning uses the committed binding and records a fresh runtime attempt
   bound to the actual container and lifecycle generation. Only its injected, signed
   attempt credential supplies authority at the existing `/mcp/:podId` boundary.
   Ordinary pod credentials and operator Entra credentials cannot invoke the child
   operation. Reprovision/resume supersedes the previous parent attempt.
5. The parent calls `managed_child_request` with exactly `requestKey`, `recipe` and
   `brief` (1–2048 characters). It must reuse the same key and content after an
   uncertain reply. It can call `managed_family` without selecting another parent.
   Operator `/orchestration/runs/:slot/start` is refused for parent slots.

### Restricted report CLI inside the parent

The daemon provisions the restricted `ap` helper and its existing attempt-scoped
MCP connection only for an enrolled parent. Use a Node.js 22 worker image.

```sh
ap delegate start --key research-1 --recipe inspect --brief 'Check the pinned source'
ap delegate status
ap delegate results --after 0
ap delegate wait --after 0 --timeout-ms 10000
# Use the actual positive cursors of verified reports from this parent run.
ap delegate start --key followup --recipe inspect --brief 'Refine the best assertion' --from 1,2
```

Successful commands return JSON. A start receipt identifies the request and its
last recorded child status; `reserved` is not proof of execution. If the
reply is uncertain, inspect status and use the exact same key and input to
reconcile, never a replacement key or an automatic retry. No owner login,
arbitrary endpoint, generic spawn, coding, or publication is exposed here.

`--from` is an ordered list of up to four distinct result cursors. The daemon only
accepts verified, successful same-run reports, freezes bounded excerpts as untrusted
observations in the continuation, and records their provenance with the reservation.
It never substitutes a missing or unverified report. An exact replay reads the
original reservation without rebuilding its brief from the reports. Changing order,
selectors, recipe, or brief requires a new deliberate request, never a retry.

Results return at most one bounded page of terminal outcomes and a `nextCursor`;
use that cursor on subsequent commands. Only a verified committed report
contributes a bounded, sanitized excerpt. An exit awaiting report export or
reconciliation doesn't consume a result cursor. A failed child or unverified
exit is not a successful report. Wait has a 15-second server budget including
report verification, plus up to two seconds of CLI transport grace; timeout
preserves the cursor. A fresh authenticated attempt of the **same parent run**
can resume reading run history, while stale attempts cannot. Reconnect never
creates another child or calls a provider.

The parent request and its originating attempt, continuation reservation and request
debit commit together **before dispatch**. The production continuation scheduler
reconciles the managed identity by installation/start key/spec/attempt. Replays do
not refund or reset limits. Exhausted budget, active capacity, lifetime worker count,
unknown recipe, changed key content and stale parent sessions fail closed. Unknown
allocation outcomes retain their reservation; never submit a fresh key as a retry.

## Read projection and lifetime

The enrolled operator can GET `/orchestration/parents/:podId/family` with its normal
user credential. Authorization checks issuer, audience and object ID against the
run's enrollment; a pod credential is not an operator credential. The result contains
the selected parent, run, request key, originating parent attempt and actual managed
child identity. It returns no managed grants, runtime references or account credentials.

Statuses are separate: `reserved` precedes external allocation; `started` means a
confirmed start; `exited` requires an observed worker exit; `unknown` covers attempted
allocation without a confirmed start or a later unknown runtime observation. A stop
request is not an exit. The projection joins real managed rows rather than adding
normal fleet pod rows. Parent exit does not delete this history or keep a process
alive for display. There is no Desktop grouping in this slice.

## Private coding handoff (host only)

An internal host collector can retain committed HEAD from a bound, successfully
exited local Docker worker. It runs an unprivileged, bounded export command;
uncommitted files aren't copied and no Git remote is contacted. The daemon
verifies the sole parent against the accepted checkpoint, applies the host's
path scope, and records the exact bundle, tree, and scope in private custody.
It rechecks run and runtime authority at insertion and never marks this evidence
as tested or publishable. The legacy source broker cannot read this custody.

Coding is off by default. A v1 signed parent may opt into one local Docker
`coding` recipe and an allowlist of exact files. It needs an isolated
installation and a reviewed `privateCommit: true` profile stage with verifier
policy `parent-private-commit-v1`, no identity bindings or egress, and no legacy
source broker. The parent can choose the recipe, but cannot choose source scope
or authorize delivery. Completion goes through the watchdog, not a second
parent call. If the collector's durable claim survives without a candidate,
the outcome requires review; it will not rerun collection automatically.
Results distinguish a retained candidate from a verified report; a candidate
does not satisfy a report dependency.

The Azure adapter can now return the private collector's output using a bounded,
single-attempt buffered exec as the unprivileged worker. It requires a valid
observed exit code and caps both response bytes and decoded output. It does not
redirect, retry, or fall back to directory sync. The collector-to-adapter path
is tested against a local data-plane fixture and passed the isolated synthetic
transport rehearsal on the exact image in `autopod-spike-neu`. The sandbox
runtime builds a fresh detached checkout from the accepted checkpoint using a
bounded, no-delta Git pack. It verifies the exact uploaded files and Git
metadata before handing the checkout to the worker. Collection requires a
fresh successful exit receipt from that sandbox and exports committed HEAD
only. The offline test uses a real isolated Docker process with simulated
Azure volume installation and HTTP transport.

The signed Azure opt-in requires separate operator profiles and artifact custody,
a `privateCommit: true` sandbox stage, and `coding.sandbox` with
`resourceScopeDigest` (canonical SHA-256 of the Azure adapter's
`executionResourceScope` string), `readyDiskImageId` and `secondPaths`.
Set `AUTOPOD_OPERATOR_SANDBOX_TARGET` to a separate JSON object containing only
`subscriptionId`, `resourceGroup`, `location` (Azure region slug) and
`sandboxGroup`. All four are required; there is no fallback to the fleet's
Azure settings. The operator-only adapter requires an existing group, uses
tier S, and cannot import or prune images. Its scope digest must equal the
signed pin. This config changes neither the fleet router nor its reapers.
Without signed Azure coding enrollment the variable must be unset.
The packet signs the
exact source, image, launch, recipes, grants, scopes and evaluator endpoints.
The operator provisions `AUTOPOD_EVALUATOR_PUBLIC_POLICY` separately as an
absolute path to a non-group/world-writable JSON file containing the two public
authority records. The daemon rejects absent or mismatched public pins.
Neither an ordinary profile, a report-only enrollment nor owner inspection
can enable this mode. No hosted enablement is implied by the rehearsal.

For this opt-in the first and second successful reservations of the coding recipe
get `coding.paths` and `coding.sandbox.secondPaths` respectively. The two
file allowlists must be disjoint (including case and path prefixes). The scopes
are committed with the reservations, cannot be chosen by the parent, and are
reused on exact replay. A third coding reservation is refused; reports use the
ordinary signed worker/request limits. A failed child does not free its scope
for replacement.

### Explicit sandbox change submission

A newly signed private sandbox coding recipe may require exactly
`change-submission.json` instead of `report.md` (one artifact, at most 16 KiB).
The worker supplies plain UTF-8 replacement text in its final response as
`{"version":1,"files":[{"path":"sample/count.txt","content":"24\n"}]}`
(with the newline escaped in the JSON). The worker does not need to write Git
metadata. The daemon checks the exact resource’s successful exit, reads only
that bounded submission, checks its file paths against the assigned scope,
and creates a private commit from the retained pinned base. Unsubmitted edits
are not read. The exact commit and bundle still go through existing custody,
checks, review, and owner approval. A missing, invalid or uncertain submission
never falls back to exporting worker HEAD or retries automatically. Existing
`report.md` enrollments keep their original commit-export behavior. The
submission itself is not added to the Dispatcher artifact inventory.

## Private integration qualification (host only)

`qualifyParentIntegration` builds from two same-run retained coding candidates.
Trusted check and independent-review adapters each receive the exact bounded
bundle and must import and evaluate that tree before signing. The gate digest
binds both selections and path scopes, the run and checkpoint authority, the
commit/tree, and the bundle SHA-256. Both evaluator keys and configurations are
pinned by the run policy. Custody rechecks the same database rows under the
write transaction. Passing qualification retains the bundle and receipts; it
neither advances accepted source nor approves delivery. No worker or HTTP
operation triggers qualification directly. If signed `coding.evaluation`
enrolls two distinct HTTPS evaluator URLs, the second successfully completed
coding child reserves the ordered pair in the same database transaction.
A separate timer submits the exact bundle to the pinned checks endpoint, then
to independent review only after a valid passing checks receipt. Both receipts
and the ready status are retained atomically. The owner can discover the result
at `/orchestration/parents/:podId/review/status`. Boot never makes a new
qualification reservation or resends a previously reserved job: recovery
reports `not-sent` for a pre-send reservation and `unknown` for an interrupted
send. No automatic rearm or replacement.

`parentIsolatedReview` is a host-only adapter for reusing the existing isolated
reviewer. It reads the durable `independentReview` claim for the exact input,
rechecks custody and the frozen Task launch, and supplies a bounded packet from
a verified disposable mirror. Neither the parent nor the coding child needs to
remain alive. It requires a separate fixed account with no failover, mounts no
source or worker state in the reviewer, and retains ordinary reviewer accounting
and cleanup. The reviewer reservation has a stable identity derived from the
input digest, so a new adapter cannot run the same review again. A passing
verdict still requires the separate receipt signer. The adapter is exercised
in local integration tests.

For a sandbox candidate, signed `coding.sandbox.hostQualification: true` selects
a trusted host binding instead of HTTPS evaluator URLs. It is mutually exclusive
with `coding.evaluation` and remote dispatch credentials. The host entrypoint must
explicitly supply the deterministic check and isolated reviewer ports plus
independently controlled signers. Both roles independently verify the same exact
combined bundle and run only under the corresponding durable qualification claim.
The stock start command rejects host qualification. The isolated fictional-trial
entrypoint is `node packages/daemon/dist/index.js --parent-candidate` from the
built release. Start with a clean environment, not a copy of the hosted daemon
environment. It requires loopback `HOST=127.0.0.1`, Entra authentication, a
canonical mode-0700 `AUTOPOD_PARENT_CANDIDATE_DIR`, and that root's `home`,
`autopod.db`, `data`, and `worktrees` for `HOME`, `DB_PATH`, `DATA_DIR`,
and `AUTOPOD_WORKTREE_DIR`, respectively. Configure only the signed operator
profile set and its exact sandbox target, not an ordinary fleet. It does not
run global resource reapers, background launchers, or Task reconciliation on
boot. Do not expose this trial instance as a shared daemon or copy its enrollment
into a hosted deployment. The unpublished trial database used migration numbers
273–276 that are now assigned to unrelated mainline migrations. Keep that database
separate and do not open it with the mainline build. The mainline parent migrations
use 277–280 and expect a mainline migration history. For a single-owner candidate
reusing the already authorized Azure CLI login, set both
`AZURE_TOKEN_CREDENTIALS=AzureCliCredential` and `AZURE_CONFIG_DIR` to its
canonical owner-controlled configuration directory. The candidate does not need
an Azure login or token copied into its isolated HOME. Verify the selected Azure
identity and pinned disk before launching.

The candidate checks only the frozen fictional count-and-reason sample. The
Task admission must carry the signed request UUID and expected digest with
`requireParentEnrollment: true`. It must resolve to a repositoryless local Task
and a separate fixed reviewer route. `parentCandidateChecksDigest` pins the
check recipe; `parentCandidateReviewDigest(reviewer, image)` pins the frozen
reviewer selection and explicit `reviewerImages.local` image in the candidate's
host settings. For a single-owner fictional trial, sign `coding.sandbox.singleOwnerReceipts: true`
alongside `hostQualification: true`. Before enrollment, the operator runs the candidate's
`dist/orchestration/parent-candidate-keys-cli.js init <candidate-root> <review-digest>`
once. It generates two role keys in a private candidate file and prints only public
pins; `pins` reads them without rotating anything. Run `preview <candidate-root>
<review-digest>` to inspect the unsigned seed packet. It verifies the owner-private
`draft.json`, `profiles.json`, `cli.json`, and `seed.bundle` against the frozen
fictional source and scope. Review the exact launch, reviewer, target and recipes,
then pass the reviewed packet digest to `enroll <candidate-root> <review-digest>
<input-digest>`. It refuses drift and prints the signed enrollment only. The
signature is bound to seed admission, not the separate result qualification
digest. Neither command boots or launches anything. Boot
refuses missing or mismatched keys and rejects external socket or public-policy
configuration in this mode. The
checks and reviewer still evaluate separately, on the same verified tree. The
candidate daemon holds both keys and issues local receipts. The signed enrollment
binds this choice into the retained policy digest, and the receipts identify the
single-owner role keys. They are not external attestations and do not protect
against the local daemon owner or a compromised host. Keep the key file out of
backups and mounts; neither the coding nor reviewer runtime receives it.
Owner-only approval is unchanged.

In separate-authority mode, both role public pins must come from the independently
provisioned `AUTOPOD_EVALUATOR_PUBLIC_POLICY` file. `AUTOPOD_PARENT_RECEIPT_SOCKETS` is JSON keyed by `checks` and
`independentReview`, each with an absolute `socket` and its positive numeric
`uid`. The role directories must be 0750 and their sockets 0660, with distinct
non-root owners other than the daemon. Use a dedicated group granting only the
candidate access; do not expose these sockets to containers. The bounded
single-shot protocol is `POST /v1/parent-receipt` with a role-bound
`GateStatement` and an exact `SignedGateReceipt` reply. Only digests and
authority identifiers are sent, not the source. The caller verifies the pinned
Ed25519 signature and every statement field; socket metadata is not
cryptographic peer authentication. Each service must independently authorize
its exact role and evidence before signing, not act as a generic signing
oracle; it must keep its own keys and durable one-shot state. The candidate
does not start signer services. The HTTPS evaluator service below uses a
different protocol. No fixture key or response establishes live trust.

`parentExactTreeEvaluator` is an evaluator-side
adapter: it verifies the copied bundle and exact tree in a disposable bare
mirror before invoking a fixed role-owned recipe and signing its evidence.
Executable tests need an isolated runner, not a daemon-host checkout. The
request is JSON `{request, bundle}`, where `bundle` is base64; the reply is one
signed gate receipt. Azure coding with signed dispatch enabled includes a short-lived
`dispatch` proof in that body. Calls do not forward browser credentials,
follow redirects, or retry.
Only enroll endpoints authorized to receive the source. No production endpoints
or keys are configured here.

For a fixed-input synthetic rehearsal, the separate
`registerParentEvaluatorEndpoint` entry can back a role-owned private service.
It requires authenticated ingress plus an expiring lease for one exact
integration request digest; it never consumes a lease on a different input.
Use one private persistent state directory and a separate private scratch
directory per role. Both the HTTPS front end and its private backend must deny
direct access by workers or the public. The role supplies its own fixed
evaluation and signing ports; neither the submitted source nor an HTTP field
configures those ports. Run under separate service identities with bounded
scratch, CPU, memory and request time; keep request bodies out of logs. It
writes a durable claim before evaluation, distinguishes a veto from an
unavailable outcome, and does not retry or clear the claim after uncertainty.
This entry is also packaged as a separate Unix socket service. From a built
release, invoke `node packages/daemon/dist/orchestration/parent-evaluator-service-cli.js /absolute/role.json`
(or `pnpm --filter @autopod/daemon start:parent-evaluator /absolute/role.json`).
It never listens on TCP and is not part of daemon boot. Run one instance per
role under separate non-root identities; put a dedicated authenticated HTTPS
proxy in front of each socket. The proxy must authenticate and authorize the
daemon; do not forward a public listener or give workers access to the socket.

The role config contains only `role`, `policy` (combined public policy),
`lease`, and absolute `stateDir`, `scratch`, `socket` and `recipe` paths.
Use separate evaluator-owned private state and scratch directories (0700) and
a non-world-accessible socket directory (0750 with the dedicated proxy group).
Socket mode is 0660; verify the actual group and that unrelated identities
cannot connect. Keep configuration, recipe, credentials and their parent paths
outside worker or proxy write access. The service refuses an existing socket;
never clear a durable claim to recover the listener.

The recipe is a reviewed, role-owned ES module exporting `evaluate`, with no
relative imports. Its bytes must match the role's `configurationDigest` before
it loads; its result comes from the verified mirror, not request metadata.
Treat it as trusted evaluator code, not a sandbox. Never execute bundle code
or a model under the signer identity; isolate that work separately. The
runner calls the role-owned code with a verified disposable mirror, and reads
its own Ed25519 signing key only from the systemd credential
`evaluator-receipt-key`, which must match the role's public pin. No shared
receipt key or daemon database is needed.

For dynamic dispatch
set the signed `coding.sandbox.authorizeEvaluatorDispatch: true` opt-in.
Each role's lease pins its own `dispatchPublicKey` (raw 32-byte base64url)
with the exact run, base, repo, paths and lease expiry. Provision two distinct
daemon-side PKCS#8 Ed25519 keys via systemd credentials
`autopod-parent-evaluator-checks-dispatch` and
`autopod-parent-evaluator-review-dispatch`. They must also differ from both
receipt keys. Never install evaluator receipt or dispatch keys in a worker.
Dynamic dispatch also requires HTTPS mutual authentication. For each of
`checks` and `review`, provision `autopod-parent-evaluator-<role>-tls-ca`,
`-tls-cert` and `-tls-key` via the trusted systemd credential directory.
The CA is one dedicated private CA certificate, the cert a single daemon
client certificate, and the key its protected private key (PEM). Use
different CA and client key pairs per role. Configure each proxy to trust
only its corresponding daemon client identity. The daemon requires TLS 1.3,
validates the enrolled server name using only that role's CA, and has no
general HTTPS fallback for dynamic dispatch. Never provision worker access
to these files. The authorized proxy, TLS deployment, and role-specific
credentials must be qualified in the real environment separately.

The dispatch credentials authorize calls, not test or review results;
the endpoint still requires authenticated ingress and its own receipt signer.

The daemon records the exact integration request digest with the durable
qualification selection before the first evaluator call, and verifies that
digest again when transitioning to independent review. Each outbound proof
binds the request digest, evaluator role and an expiry of at most 60 seconds.
A proof for the checks endpoint cannot authorize review. Boot does not sign
or re-send either role. The fixed-digest mode remains available for rehearsals;
the two modes are mutually exclusive. Neither mode provisions a hosted endpoint.

**Desktop launch.** In the isolated Desktop Preview, use **New pod → Configuration → Full launch JSON** (or the legacy **Full launch configuration** disclosure). Apply the complete enrolled Task request, including `intent: "task"`, `requireParentEnrollment: true`, the exact `requestId`, and `expectedDigest`. Preview must resolve to that same digest on the selected daemon. Desktop keeps the enrollment on edits and never substitutes a new launch identity. It records the exact request before sending; if the result is uncertain, check the original daemon rather than resending.

**Desktop review status.** On the selected parent's Overview, the existing
family card shows coding and qualification progress, a stopped or uncertain
outcome, or the exact commit and evidence digest when ready. It refreshes
alongside the family, without notifications, attention prompts, or new
actions. A stale connection never presents a change as currently ready.
Report-only parents and older daemons omit this section.

**Private review handoff.** For a coding-enrolled parent, the authenticated
owner can preview one qualified evidence digest at
`/orchestration/parents/:podId/review/:evidence/preview`. POST
`{evidenceDigest, expectedReviewDigest}` to the corresponding `/approve` to
approve release of that immutable change for human review, then GET `/bundle`
for the exact tested Git bundle. A corrected or separately qualified version
needs its own explicit approval. Approval is durable across restart and cannot
be made by a child token, reused on different evidence, or used after the run
or source authority has changed. It is not permission to push, open a PR,
merge, or advance accepted source.

## Evidence and remaining milestones

Run the offline contract:

```sh
npx pnpm --filter @autopod/daemon exec vitest run src/orchestration/parent-managed-launch.integration.test.ts
```

It uses production normal launch admission, parent provisioning, `processPod`, the
MCP server/HTTP ingress/authentication, SQLite custody and ownership, managed
admission, continuation reservations/scheduler and the family projection. The model
and external container/provider boundary are fake. The fake parent runtime receives
its real provisioned configuration and sends the commissioning tool request itself;
the operator never starts the child. Other scenarios inspect lost-reply/restart
idempotence and rejection without spend/allocation. These tests are not live provider,
container enforcement or product delivery evidence.

Still required in separate, authorized work:

- Actual subagent code production: a deliberately enrolled write-capable recipe,
  isolated source custody and independently verified candidate/check/review receipts.
- Verified two-wave handoff: durable accepted source from wave one, verified before
  another worker consumes it; report text alone is not source or approval.
- Desktop grouping: native UI integration, retained history and unknown-state UX,
  validated on a Mac.
- Approved delivery: independent daemon validation/review, human approval and
  daemon-owned publication. No worker merge, push or deployment authority is added.
- Retained live demo: separately authorized real parent/child execution, provider and
  enforcement evidence, retained identities/results and operator inspection after exit.

No production configuration changes, restart, live child, deployment, publication,
archive or teardown are part of this worker task. PR publication remains daemon-owned
and pending human review.
