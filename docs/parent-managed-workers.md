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

## Private integration qualification (host only)

`qualifyParentIntegration` builds from two same-run retained coding candidates.
Trusted check and independent-review adapters each receive the exact bounded
bundle and must import and evaluate that tree before signing. The gate digest
binds both selections and path scopes, the run and checkpoint authority, the
commit/tree, and the bundle SHA-256. Both evaluator keys and configurations are
pinned by the run policy. Custody rechecks the same database rows under the
write transaction. Passing qualification retains the bundle and receipts; it
neither advances accepted source nor approves delivery. No worker or HTTP
operation exposes this helper, and no production evaluator is configured here.

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
