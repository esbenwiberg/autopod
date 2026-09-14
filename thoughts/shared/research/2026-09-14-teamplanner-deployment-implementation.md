# TeamPlanner access and isolated deployment candidate

The user explicitly retained deployment as a feature; retirement of the `guardian-deploy` profile is a separate decision. This local implementation leaves the hosted daemon and its profiles unchanged. No real ADO/log queries, PIM activation, provider inference or deployment was performed.

## Scoped service reads

`RepositorySetup.integrations.serviceAccess` stores complete ADO or Azure log rules, selected by stable rule ID. ADO supports file/code search, PR/threads/changes and work-item reads/search. Azure logs support selected workspace tables, an optional container-app constraint, bounded timespans and literal substring filters. The daemon constructs endpoints and queries; no agent-supplied organization/workspace override, raw WIQL or KQL is accepted.

The broker checks one rule's operation and resource together. Code search responses are checked against the selected project/repository; work-item responses must identify the selected project. The transport accepts fixed HTTPS origins, forbids redirects, acquires credentials on the daemon, limits response bodies to 2 MB and checks authorization after credential acquisition and before releasing data. Scoped pod tools also check the frozen configuration, running pod and current operator policy. Read audit records omit task queries and response bodies.

Desktop project setup forms now expose these rules. The CLI supports them through its existing typed configuration payloads. `serviceAccessByProfile` is an explicit offline conversion mapping. Deployment requires its own mapping; retired custom actions and test pipelines produce explicit conversion warnings and no executable configuration. PIM and package-feed credential boundaries remain separate.

Primary API references used for the implementation:

- [ADO Code Search API](https://learn.microsoft.com/en-us/rest/api/azure/devops/search/code-search-results/fetch-code-search-results?view=azure-devops-rest-7.1): fixed organization/project endpoint and explicit search filters.
- [Kusto string literals](https://learn.microsoft.com/en-us/kusto/query/scalar-data-types/string): escaped literal filters, not query interpolation.
- [AppTraces table](https://learn.microsoft.com/en-us/azure/azure-monitor/reference/tables/apptraces) and [AppRequests examples](https://learn.microsoft.com/en-us/azure/azure-monitor/reference/queries/apprequests): workspace table names and `TimeGenerated`.

## Published-default deployment

The isolated runner accepts a digest-checked, normalized source archive and exact script/arguments. Source preparation rejects Git metadata, links, path traversal and oversized bundles, normalizes ownership/modes and hashes the complete source plus script. The runner copies its input before asynchronous work, validates allowed environment keys, uses a cached image pinned by digest, drops capabilities, sets CPU/memory/process limits, uses no host mounts and defaults to no network. Credentials are supplied only to its execution process. Script output is drained but withheld from the pod; the result is an exit/cleanup receipt. Exact container removal terminates children and prevents late exec starts.

Migration 205 introduces retained deployment requests. Approval binds source commit/archive/script, arguments, image, launch and environment fingerprints to the requesting operator and an expiry. The ledger records container/exec identity before execution, claims once, and blocks another running/uncertain deployment against the same target across pods and request keys. Restart marks interrupted claims uncertain; it does not replay them. Cutover refuses unresolved deployment decisions.

The user authorized both source choices only if inexpensive; otherwise the latest default branch. The implemented source contract is **published-default only**. Supporting validated pod changes is deferred because it needs an attestation connecting exact source bytes to validation. GitHub discovery reads the repository's actual default branch, independently of setup/launch branch overrides, and resolves its commit using the branch endpoint. Preparation pins that commit; review and execution fetch only that SHA and verify the archive and script digests. Retries keep the original pin even when the branch advances.

The composed path now connects source preparation, owner-authenticated review/decision APIs, durable single execution, deployment-only credentials, and isolated Docker execution. Approval records credential revisions; rotation or revocation invalidates the approval. Decisions return the durable running state promptly; clients poll for the result. Pods expose only `deployment_request` and `deployment_status`; they cannot approve or execute directly. No source publication or managed authority is added.

Operator enrollment lives in `configuration-host.json` under `deploymentTargets`: target ID, repository/setup identity, pinned image, scripts, environment names, allowed HTTPS hosts, resource limits and deadline. Empty host lists mean no network. Networked targets reuse the daemon's restricted SNI firewall with defaults and daemon gateway access excluded. Only the daemon bootstraps that firewall as root before source/secrets are copied; deployment scripts run as UID 1000 with no effective capabilities and no privilege escalation. Native restricted-egress acceptance is still outstanding; the real Docker fixture uses no network.

Restart marks interrupted requests uncertain and removes owned containers by recorded ID plus the run label (including the create-before-record crash window). Cleanup does not establish the external outcome. The operator must verify the destination and record `deployed` or `not-deployed`, with a note, before the target lock is released. This creates a distinct reconciled result, not a fabricated script exit receipt. Recovery remains available when all target enrollments are removed.

The desktop configuration library has a Deployment section in repository setups and a Deployments page for exact-commit/script review, approval, denial, status and reconciliation. CLI `ap deployment` exposes request/list/review/approve/deny/status/reconcile. `deploymentByProfile` provides an explicit offline mapping to the new published-default semantics; unmapped legacy deployment stays blocked. `guardian-deploy` and all live configuration remain unchanged.

## Local evidence

- First scoped broker/integration/resolver run: 22 tests passed.
- Scoped/migration/deployment repository/source checks: 29 tests passed after adding the required whole-file SQL migration marker.
- Targeted TypeScript diagnostics for the new/changed access and deployment modules: zero.
- Cached-image real Docker run and timeout cleanup: two tests passed; invalid-input unit fixture also passed. The script can write its workspace/home, has zero effective capabilities, and receives only fake deployment credentials. No network or real credentials were used; the final Docker inventory contains no deployment fixture containers. Log: `/private/tmp/autopod-default-deployment-docker.log`.
- Final Swift package: 371 tests passed; unsigned macOS build passed with the deployment review, decision and reconciliation UI. Logs: `/private/tmp/autopod-default-deployment-swift.log` and `/private/tmp/autopod-default-deployment-xcode.log`.
- Final full repository pipeline passed: lint, build, supported typecheck, tests, configured dependency-audit threshold and secret scan. Daemon: 373 files passed/4 opt-in files skipped; 5786 tests passed/6 skipped. CLI 297, shared 405, escalation 114, mobile 150, validator 16 and pi-worker 9 passed. The real deployment Docker tests ran separately as recorded above. Log: `/private/tmp/autopod-default-deployment-validation-final.log`.
- The first concurrent full run hit one 5-second conversion-rehearsal timeout. The unchanged fixture passed in the focused rerun and the final full run without concurrent Xcode compilation. Focused deployment/credential/recovery/cutover checks: 6 files, 21 tests passed. Log: `/private/tmp/autopod-default-deployment-final-regressions.log`.
- Targeted TypeScript diagnostics for the changed deployment/configuration modules: zero. Log: `/private/tmp/autopod-default-deployment-types-final.log`.
- Expired approvals cannot execute, but the owner can still close them; the focused ledger/cutover run passed 10 tests. One moderate dependency finding remains below the configured high-severity threshold.

These fixtures do not establish live TeamPlanner access, live deployment egress, external credentials, native UI interaction or release acceptance. Production admission remains closed.
