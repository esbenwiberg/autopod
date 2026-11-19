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
   Use `ap run --config parent-launch.json --request-id <UUID> --preview --json`;
   retain the same file and its preview digest for `expectedDigest` when launching.
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
   must still be a future launch when this composition is installed. An existing
   parent binding can be recovered, but another pod cannot take over its run.
   The reviewed envelope is `AUTOPOD_OPERATOR_ENROLLMENT`; use a separately
   partitioned `AUTOPOD_OPERATOR_PROFILE_SET` and the existing managed CLI owner
   bindings. Setting these is operator deployment work, outside this PR's execution.
4. Parent provisioning records the pod/run/policy and a fresh runtime attempt bound
   to its actual container and lifecycle generation. Only its injected, signed
   attempt credential supplies authority at the existing `/mcp/:podId` boundary.
   Ordinary pod credentials and operator Entra credentials cannot invoke the child
   operation. Reprovision/resume supersedes the previous parent attempt.
5. The parent calls `managed_child_request` with exactly `requestKey`, `recipe` and
   `brief` (1–2048 characters). It must reuse the same key and content after an
   uncertain reply. It can call `managed_family` without selecting another parent.
   Operator `/orchestration/runs/:slot/start` is refused for parent slots.

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
