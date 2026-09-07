# Action security implementation plan

Baseline: `2d5456edac542a99d27f12eb1dbd16e5ad8c2c2a`.
Branch: `codex/action-security-http-resilience`.

1. Establish full-body HTTP deadlines and byte bounds with local reproductions. Inventory shared helper callers and preserve existing response semantics.
2. Bind generic HTTP connections to validated DNS answers, validate equivalent IP forms, and reject redirects. Prove real socket and TLS behavior with controlled fixtures.
3. Prevent raw upstream/credential content from reaching action errors, logs, audit records and tool responses. Verify real sinks and denial invariants.
4. Review, run affected and complete validation, commit scoped checkpoints, and close every acceptance criterion with exact source evidence.

Each fix starts with a failing desired-behavior regression. Required acceptance is defined by ../goal-prompt.md and acceptance.json, not by the number of tests added. No provider, deployment or paid canary is required.

## Initial ownership check

Other task `01a07afa-a577-70e1-a800-f4f5de43bf2e` observed active. Its implementation checkout `/private/tmp/autopod-durable-execution` changes daemon package.json and pnpm-lock.yaml relative to baseline, but has no changes in actions/ or api/ssrf-guard.ts. Avoid manifests; recheck before every milestone. The current worktree initially had only this task's untracked goal prompt.

## Shared HTTP helper caller inventory

Generic HTTP, GitHub, ADO, Azure Logs, Azure PIM, and test-pipeline handlers use fetchWithTimeout. Some consume text/error bodies directly; enforcing limits only in readSafeJson leaves those paths unprotected. readSafeJson currently buffers before checking JavaScript character length, which is not a streaming byte limit. All these callers need focused regression runs after changes.

## Fixed fixture limits

Use the existing 2 MiB response limit. Local deadline tests use 60 ms configured deadlines and a 1,000 ms assertion ceiling; fixture safety cutoff is 1,200 ms, to guarantee baseline tests terminate. Do not increase these limits in response to a failure without diagnosing and recording the cause. Cover delayed headers, stalled body, slow chunks, oversized success/error, and caller abort. Prove cleanup through observed stream cancellation/socket closure, not just rejected promises.
