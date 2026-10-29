# External PR delivery and retained reports

A legacy sandbox pod can still appear `validated` after a human merged its PR
outside Autopod. If ordinary approval tries to restore the sandbox first, an
unavailable memory snapshot prevents recognizing an already completed delivery.

## Supported approval reconciliation

Normal authenticated human approval now checks an existing, unjournaled sandbox
PR's provider disposition **before** waking the sandbox. It recognizes delivery
only when all of these hold:

- The provider freshly confirms **merged**, not merely closed or scheduled.
- Repository, source branch and target branch exactly match the bound task.
- Read-only local inspection confirms a clean retained branch at the exact
  provider-observed source commit. No ancestry/checkpoint exemption is inferred.
- A read-only provider lookup confirms the original sandbox still exists (running
  or stopped). Unknown/deleted resources are not claimed retained.
- Existing validation is a recorded pass; approval, human-decision, guidance,
  worker-termination, lifecycle and deletion-ownership fences still hold.
- The actor is an authenticated human. Automated legacy adoption is refused.

Interactive workspaces are excluded: their edits may still exist only in the
container. Existing source-bound merge-journal recovery keeps its own protocol.

An atomic settlement records an immutable **external delivery observation** and
performs normal approved → merging → complete transitions. It does **not** invent
a daemon publication/merge intent, issue another merge/push, wake a sandbox,
rewrite validation, or clean up the retained resource.

Inspect the receipt through:

```
GET /pods/:podId/external-delivery
```

The response is `{ "receipt": null }` or contains exact source/target, existing
validation timestamp, observer/time, human actor/reason and retained sandbox and
worktree identities. The receipt is separate from source-bound daemon journal
counters; those counters do not retrospectively claim a daemon merge request.

## Reports remain pending — this is not an artifact-preservation waiver

The Readiness review explicitly shows **Delivered externally — reports pending**.
Delivery completion means the provider-confirmed source is delivered; it does not
mean ignored reports were collected. The original sandbox and host worktree remain
retained. Central destructive cleanup, Kill, Delete, repository deletion and both
sandbox reapers respect the durable retention record, including after a restart or
loss of the current container binding. Retained sandbox storage may keep billing.

There is deliberately no automatic expiry or "forget this resource" escape hatch.
Releasing this hold requires a separately audited report-preservation settlement;
this change does not provide one. Do not delete the observation, fabricate old
publication rows, or manually set pod status. Preserve inaccessible sources while
provider-side restoration is investigated.

## Other attention-pod recovery fixes

- Readiness no longer presents an unexplained disabled approval/reason form for
  failed/review-required pods. It explains the state and links to Validation.
  A readiness reason does not waive failed checks or unresolved execution.
- `allowPackageManagers` includes the exact `storage.googleapis.com` CDN host:
  the Go module proxy redirects toolchain/module ZIPs there. This is a shared
  content host (not a bucket/path restriction); no `*.googleapis.com` wildcard or
  unrestricted egress is added. Pods without package-manager consent do not gain it.
  A fresh container/network is needed for existing pods to receive derived policy.
- Container Tier-1 critique requests the provider-native JSON schema already used
  by other review stages, while retaining local validation of the response. A
  malformed response remains a failure with bounded head/tail diagnostics; it is
  never accepted as a passing review.

Unknown validation execution termination still requires real reconciliation.
These changes do not reinterpret a stopped snapshot as proof of process death.
