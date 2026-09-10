# Full-window import request: additional attempt proposal

**CP129 update:** the approved full-window import succeeded. Sandbox creation returned 400; the task-owned image was deleted and absence verified. No runtime checks ran. The [label-safe additional-attempt proposal](label-safe-image-canary-packet.md) supersedes the consumed request; exact rejection cause remains unconfirmed.

**Prepared, not authorized or executed.** The CP127 approval was used for one successful transient ACR exchange and one image-import PUT. The local runner aborted that PUT after 60 seconds instead of allowing the approved ten-minute import window. No sandbox create was attempted. The [live receipt](receipts/checkpoint-128-live-attempt.json) retains that exact outcome. Continuing read-only reconciliation is recorded in checkpoint 128; inventory absence does not prove that Azure cancelled an unreturned request.

The timeout defect is reproduced locally: the original runner fails a check requiring the import request signal to use the contract's full window; the corrected runner passes. Success and runtime-failure cases preserve single creation and exact-resource cleanup, with mocked network only. [RED](receipts/checkpoint-128-import-window-red.txt), [GREEN](receipts/checkpoint-128-import-window-green.txt). No application source change is involved.

## Proposed additional scope

One new import of the same digest, one in-memory same-principal ACR exchange, and at most one five-minute disposable capability canary, with the same resource, command, egress, cleanup and cost limits as the [previous packet](corrected-image-canary-packet.md). The import HTTP timeout is now **600,000 ms**, drawn from the approved ten-minute image window, rather than the erroneous hard-coded 60,000 ms. No automatic create retry.

The new [contract](fixtures/canary-128-contract.json) pins nonce `autopod-cp128-20260910-7c3a829e`. The [prepared runner](fixtures/run-canary-128-new-attempt.mjs) has a new exclusive journal and requires `--execute-approved-cp128`. Before execution, verify all contract/runner/bundle hashes and fresh source/principal/group/digest identity. Recheck both prior nonces and the new nonce. If either previous resource appears, reconcile/clean it under its existing authority first; do not start this new attempt while a matching previous resource is observed. If an exact ready shared image appears, stop and revise the import request rather than creating another.

This proposal explicitly discloses the prior unreturned operation: repeated empty inventories establish that no task image is visible, but they are not proof that hidden conversion work has terminated. A delayed image could appear later and require exact-nonce cleanup. Any new approval must accept that uncertainty rather than treating the previous timeout as a confirmed cancellation. A new import would be an additional explicitly authorized attempt, not a retry under the old approval.

Known component estimate remains approximately **$0.053** for this additional attempt. Prior conversion/transfer billing is unconfirmed. Image conversion, storage, internal retries and cleanup overruns remain unpriced; no hard dollar cap is asserted. No model calls, role changes, existing-image deletion, deployment, publication or production restart. The actual canary remains unverified until it executes and passes its recorded oracles.

To execute after approval, copy the prepared runner to `/private/tmp/autopod-canary-128-new-attempt.mjs`, retain the hash-verified `/private/tmp/autopod-canary-127-candidate.mjs` bundle, and run `node /private/tmp/autopod-canary-128-new-attempt.mjs --execute-approved-cp128`. Never remove an attempt journal to bypass its single-execution guard.
