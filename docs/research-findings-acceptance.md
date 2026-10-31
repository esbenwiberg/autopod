# Research findings acceptance

New research tasks explicitly select frozen `workflow.completion: accept-findings`.
They run an automatic task (not a Goal), output `artifact` or `none`, and have no
native validation phases or advisory QA. Launch preview rejects incompatible
settings; it never removes configured blocking checks. Shared presets are unchanged.
`ap research` selects artifact output and this completion policy. Select a workflow
with empty validation phases, or explicitly supply them in the launch JSON.
`ap run --completion accept-findings --output none --config ... --override-config`
can select the same policy. Preview before launch.

A settled worker's native task summary and complete workspace snapshot are retained
with the existing generation/cycle artifact inventory receipt. This includes ignored
reports and supports summary-only investigations. For this explicit contract, `none`
means no source publication; it still retains review evidence. Failed diagnostics and
unresolved questions remain findings, never a manufactured native validation pass.
The task-wide worker, validation execution, deletion ownership and source custody
checks still apply. Missing summaries, ambiguous termination, corrupt snapshots or
failed cleanup do not expose acceptance. Resources remain retained for recovery.

After snapshot verification and worker cleanup, the task enters **Research ready**.
It stays in Attention until a human accepts findings. Native validation is **Not
required for this research task**; other security and safety evidence remains visible.
Open the summary and reports in desktop/phone details, or use:

```sh
ap status <full-pod-id> --json
ap files <full-pod-id>
ap files <full-pod-id> --path <report-path>
# Immutable receipt/history access, including deleted pods:
ap findings <full-pod-id>
ap findings <full-pod-id> --generation <generation> --cycle <cycle> --evidence-hash <hash> --path <report-path>
ap accept-findings <full-pod-id> --generation <generation> --cycle <cycle> --evidence-hash <researchFindings.evidenceHash>
```

Acceptance acknowledges receipt of this exact investigation. It does not say the
investigated defect is fixed, grant implementation/publication authority, create
follow-up work, waive validation, approve delivery, push a branch, or create/merge a PR.
It records authenticated actor and acceptance time with the exact summary, snapshot,
frozen digest and lifecycle identity, then completes once. Exact duplicate requests
return the original receipt; stale or superseded requests conflict. The ready time
and worker settlement time remain separate from `completedAt` at acceptance.
Approval, bulk approval, auto-approval and Podsitter cannot consume Research ready.
Dependencies retain existing policy and are released only after acceptance to complete.

The authenticated API is `POST /pods/:id/accept-findings` with strict body
`{expectedGeneration, expectedCycle, expectedEvidenceHash}`. The actor is never supplied
by the caller. `GET /pods/:id/findings-receipts` exposes immutable ready/accepted
receipts across pod reuse/deletion. `GET /pods/:id/findings-receipts/:generation/:cycle/content?evidenceHash=...&path=...`
reads at most 5 MiB from the exact retained receipt, independently of current pod/worktree
pointers. Reads verify the inventory hash pinned in the immutable database receipt as
well as the snapshot sidecar; changing both snapshot and sidecar cannot rewrite accepted
history. The CLI `ap findings` exposes these archived receipts and reports. Current evidence stays in pod detail/history.
Artifact reads verify the retained receipt and never fall back to a live worktree.

Interrupted collection/cleanup uses the existing artifact finalization recovery:
inspect the failure and explicitly Resume finalization. A recorded settled worker
is not dispatched again. Receipt corruption must be repaired from original evidence;
there is no force-accept or termination-proof bypass.

## Compatibility and rollout

Migration 225 adds nullable projections and append-only findings receipts, with no
historical classification or backfill. Old frozen launch digests and default workflow
semantics remain unchanged. Ordinary empty diffs, disabled validation, artifact exports,
interactive workspaces and scheduled tasks retain their old semantics unless they
explicitly select the new completion contract.

Release updated desktop, CLI and phone clients **before enabling accept-findings
launches** on a daemon. Old desktop versions map unknown states to queued and cannot
safely operate Research ready. There is no daemon capability negotiation in this patch:
operators must enforce this release ordering and keep older clients disconnected from
findings-enabled fleets. The new desktop enum and reconnect refresh recognize the
state. A hosted rollout requires separate deployment authorization and migration backup.
Do not enable the workflow while unsupported clients remain in use.

Legacy adoption is deferred. In particular, `religious-swordfish` predates the frozen
contract and is not converted, reopened or accepted by this change. Adoption needs a
separate reviewed human operation binding an exact settled lifecycle, original config,
source/termination custody, evidence and reason without expanding publication authority.
No production mutation or deployment is part of evolutionary-tuna. Follow-up-launch
convenience is deferred; use the existing explicit launch composer with fresh permissions.

macOS SwiftUI/AppKit tests and Xcode builds must run on a Mac before client release.
Linux TypeScript checks do not verify the native desktop UI.
