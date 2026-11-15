# Hosted sandbox reliability canary

Use one bounded documentation change to check the hosted sandbox path through
independent review, without merging application changes. Running this procedure
requires separate operator authorization for the launch and its provider spend.
Writing this runbook does not authorize a live canary, deployment, image rebuild,
profile edit, host repair, or external-service mutation.

## Prerequisites

- Confirm the intended hosted daemon connection. Save `ap health --json`: require
  healthy release identity, a fresh backup of the active database with verified
  restore evidence, key backup, and adequate disk/capacity headroom. A backup
  filename alone is insufficient. See [key backup](secrets-key.md).
- Select an existing sandbox profile and usable provider account for both worker
  and independent reviewer: valid authentication, model access, quota and bounded
  task budget. Record the resolved main/reviewer configuration; do not substitute
  worker self-review for independent review.
- Require a supported ACR-qualified, linux/amd64 warm image. Record its immutable
  digest and runtime/tool versions, not just a mutable `latest` tag. Verify the
  admitted image against that pin. Missing image, pull permissions or daemon MCP
  reachability is a prerequisite failure; do not repair infrastructure here.
- Record requested and observed sandbox memory and CPU from execution provenance.
  Current memory tiers are XS 0.5, S 1, M 2 and L 4 GiB; 4 GiB is the ceiling.
  CPU flags apply only where supported: a requested CPU value is not proof of
  the actual allocation. Require observed limits suitable for this small task;
  stop on missing resource evidence or OOM rather than weakening checks.

See the [sandbox contract](azure-container-apps-sandboxes.md) for provisioning,
image, resource and workspace constraints. Use an operator workstation with the
current CLI; first save `ap --help`, `ap run --help`, `ap status --help`,
`ap execution-provenance --help`, `ap logs --help`, `ap cost --help` and
`ap approve --help`. Stop if installed syntax differs from the examples below.
These examples follow the repository CLI definitions; worker images may not ship
`ap` at all. Help and configuration previews perform no execution qualification.

## Bound and launch one task

Prepare a UTF-8 `canary-task.md` outside the target checkout. Request exactly one
small documentation edit (for example, clarify a paragraph in an existing
runbook), no application/configuration changes, dependencies or executable Facts.
Specify the intended base branch and expected source SHA, the permitted paths,
focused prose/relative-link checks plus `git diff --check`, independent review,
commit and structured task summary. Require reporting of actual starting SHA,
exact checks, friction and gaps. Set an operator observation deadline (for example,
20 minutes) and a finite task budget using the existing configuration; expiry
means stop and investigate, not automatically retry or approve.

Preview with existing profile/repository names substituted:

```sh
ap run --repo <repository> --profile <profile> --file canary-task.md --execution sandbox --completion approval --output pr --preview --json
```

Inspect the resolved configuration: repository/base, sandbox target, pinned image,
resources, provider accounts, budget, independent reviewer and validation checks.
Ensure inherited workflows do not enable automatic merge. Launch once by repeating
the same command without `--preview`. Save the admission response and full pod ID,
including every hyphen-separated part. If the response is lost, recover the launch
receipt before considering another launch; do not create a duplicate blindly.

The daemon owns authenticated source refresh. Inspect its admitted starting SHA,
then compare the worker's `git rev-parse HEAD` recorded before editing. For this
runbook's source task the baseline was
`577d839fe5baf40a07875dad43d73c1fb4ef4171`; future runs must record their own
expected and actual SHA. A newer SHA needs ancestry evidence, not an assumption
of freshness. Stop for an unexplained mismatch or missing admission evidence;
do not ask the worker to fetch credentials or refresh remotes.

## Observe and retain evidence

Use the exact full ID returned by admission in these read-only commands:

```sh
ap status <full-pod-id> --json
ap execution-provenance <full-pod-id> --json
ap logs <full-pod-id> --follow
ap cost <full-pod-id>
```

Save timestamped control-plane evidence for each boundary, including unavailable
fields and original failures. Redact secrets and raw provider payloads.

| Boundary | Evidence required |
| --- | --- |
| Admission and provisioning | Launch receipt, effective configuration, admitted starting SHA, actual worker starting SHA, actual `sandbox` execution target, sandbox/operation IDs, image digest, resource limits, provisioning timestamps and failures. A preview or accepted launch does not establish that a worker ran. |
| Streaming and exit | Timestamped incremental activity, runtime identity, invocation/exec correlation, terminal `exit_code` or supported matching private exit receipt. A WebSocket close (even 1000), quiet logs, preview URL, PID absence or cleanup success does not prove exit. Record missing output as a gap. |
| Final usage/accounting | Settled execution and final worker/reviewer usage, provider attempts, task-wide totals, partial/unavailable indicators and budget outcome. Live counters are provisional; reconcile final accounting with the same invocation. Catalogue cost estimates are not provider invoices or Azure infrastructure billing. See [Codex accounting](codex-usage-accounting.md) when applicable. |
| Validation | Exact checked commit, commands, exit results and enabled daemon gate results. Record disabled, skipped, deferred or failed checks explicitly; worker checks do not replace daemon validation. This prose task needs review and focused documentation checks, not executable Facts. |
| Independent review | Reviewer identity/configuration, reviewed source SHA and diff, verdict and resolved findings, including the control-plane task review result. A skipped/unavailable reviewer is not a pass. |
| Workspace sync-back | Successful `/workspace` preservation/sync-back, host-side commit SHA and scoped diff matching the worker output. A worker commit alone does not prove host preservation; missing sync evidence blocks delivery claims. |
| PR publication | Daemon publication receipt with real PR URL/number, source branch/head and base, matching the reviewed diff. A requested `pr` output or local commit is not a published PR. |

At the observation deadline, capture current status and classify incomplete phases.
Unknown execution/termination or incomplete final accounting is a stop condition:
retain resources and evidence for the control-plane owner, report the blocker, and
do not retry, respawn, delete the sandbox, repair telemetry, waive gates or approve
to manufacture settlement. Ordinary lost-delivery wrappers have no durable exit
receipt today; the sandbox contract explains the narrower Native Goal receipt path.
Missing source, sync-back, review or publication evidence likewise remains an
unresolved gap, not a successful canary.

## Stop before approval; report separate outcomes

Use **approval** completion and **stop before `ap approve`**: that command may
merge. Approval completion may leave PR publication pending at the approval
boundary. This canary grants no approval or merge authority. If publication needs
an additional action, hand off the checked source and request a separately
authorized, supported PR-only publication path from the control-plane owner;
do not change completion policy or invoke approval to force a PR.

Report these outcomes separately:

- **Launch accepted:** admission receipt exists; execution may still be unproven.
- **Checks passed:** named checks and independent review passed for the exact
  preserved commit, with execution and final accounting settled.
- **PR published:** a real matching PR reference exists. Otherwise report
  **PR publication pending (daemon-owned)**, even if checks passed.
- **Merged:** requires independent merge evidence and separate authority; merging
  is outside this procedure. Leave the canary PR unmerged.

The worker reports its edits, commits and checks in `report_task_summary`; the
control plane reports the live sandbox outcome and delivery evidence. Record
infrastructure friction and unresolved gaps without rewriting failed attempts as
passes. Docs-only checks do not prove application builds, browser behaviour,
heavy workloads, or general Azure transport reliability.
