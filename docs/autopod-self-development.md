# Developing Autopod in Autopod

Autopod's worker checkout is the application under development, not the host
control plane. A Linux worker can implement and validate daemon, CLI, MCP, shared
and web changes. macOS desktop changes additionally require the Mac CI job or a
Mac checkout; a Linux pass is not desktop qualification. On a Mac, use the maintained
`./scripts/test-desktop.sh` driver, followed by the app build from the Desktop CI
workflow. The driver discovers the complete target inventory and runs targets in
separate processes: a monolithic `swift test` mixes AppKit/WebKit and HTTP-fixture
OS state and is not the repository's qualified full-suite execution path.

## Before launching

1. Preview a new repository launch using current defaults (`ap run --repo autopod
   --preview --json`). Do not copy an old frozen pod merely to get today's setup.
   Use published source branch names; record the actual admitted starting SHA.
2. Use the repository's qualified Docker execution setup for the full monorepo,
   with sufficient admitted memory (8 GiB in the qualified setup), writable
   dependency caches and disk headroom. A sandbox's effective allocation may be
   smaller than the requested value. Check `ap execution-provenance <pod> --json`.
3. Verify the selected image, not just its mutable tag: Node/package-manager
   compatibility, managed system CA trust, and the required Git capability must
   actually exist. The supplied `autopod-check-git` fixture exercises the needed
   merge-tree operation. Never disable TLS verification to make setup succeed.
4. Inspect `ap health --json`. A source PR merged into main does not update the
   daemon or rebuild a frozen worker image. Validation-owner and reviewer fixes
   must be present in the deployed daemon; compiler/test-fixture changes must be
   present in the supplied worker checkout. Keep these two revisions distinct.

See [worker profile reliability](worker-profile-reliability.md) for image,
compiler heap, disk-fixture and reviewer input details. These are prerequisites,
not permission to change an existing pod's frozen authority or receipts.

## Worker loop versus independent acceptance

Run applicable checks while implementing, then the required independent review.
Explicit task checks still apply. Execute expensive setup, build, full tests and
typecheck serially; do not start another copy because a buffered result is unknown.
Use the configured frozen install/native build path. A native-binding failure
after that path is an infrastructure report, not an invitation to repair the host.

The daemon still runs its enabled independent acceptance gates. Never turn off
checks or substitute a scoped pass for a required full-suite pass. Record failures,
actual command scope and deferred Mac checks. An ordinary unit fixture now clones
an isolated migrated database image instead of rebuilding hundreds of migrations
for every test; dedicated migration and persistence tests still use their real
paths. Named, exact watcher-schema types also prevent repeated declaration
expansion without widening validation types or dropping compiler entrypoints.
These changes improve the workload rather than hiding it behind longer timeouts
or a larger heap.

Do not query the host daemon from inside a worker, read its credentials, or use
port 3100 as the application endpoint. Use the assigned application port and the
provided MCP tools. Candidate daemon tests should use isolated temporary state and
mocked infrastructure, never the production database, Docker resources or secrets.

## Handoff and recovery

Commit the implementation and report its exact revision and checks. The control
plane owns branch publication and PR creation. A reported final summary is not a
PR, and `validated` does not necessarily mean that an externally merged PR was
reconciled. Check the provider's PR state separately when diagnosing delivery.

When a required command cannot finish or review input is incomplete, preserve the
source and evidence and report the specific infrastructure problem. Repeating the
same full suite or truncated review cannot fix missing capacity or missing input.
Use supported exact-source recovery after the cause is corrected; do not erase
unknown execution history or infer a waiver from “go on.”

For operator takeover, first pause active writers through supported controls,
export and verify the exact Git source (including newer container-only commits),
and inspect uncommitted files. A host worktree can lag its container. Integrate
current main and independently verify the recovered branch before publication.
Check migration prefixes across all rescued branches: separately valid branches
can allocate the same version. Never force-push over newer remote work to repair
a delivery rejection. Keep retained-source protections intact if cleanup is denied.

## Qualification is a delivery milestone

A usable self-development path requires all of the following, not just a green
unit test: qualified image and resources; admitted source; successful configured
checks and complete review; a real PR; Mac evidence where desktop code changed;
and an explicit rollout of any control-plane fix. Local checks and source PRs do
not certify a production rollout or retroactively settle a historical timeout.
