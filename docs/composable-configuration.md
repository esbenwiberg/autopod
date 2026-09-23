# Composable configuration — candidate guide

This is the implementation candidate's interface, not a released feature. Production admission remains disabled while caller conversion, preserved integrations and provider/backend acceptance are incomplete. The commands below are examples; no live conversion or provider launch has been performed.

A repository owns source identity and project setups. An environment owns software and sidecar definitions. A profile selects reusable environment, AI, workflow, GitHub and tool-pack presets, plus execution and same-account PIM defaults. There is no profile inheritance. Repository defaults choose the usual profile; each launch can select another profile or override individual categories.

Images are identified by software configuration. Changing repository, AI account or container size does not create a different software identity. Repository preparation and caches remain scoped to the enrolled repository and selected setup.

## Launch and inspect

```sh
ap repository list --json
ap preset list --kind ai --json
ap profile show development --json
ap run --repo autopod --task 'Investigate startup' --preview --json
ap run --repo autopod --profile development --ai alternate --execution local --memory-gb 8 --task 'Investigate startup'
ap run --repo autopod --task 'Read the integration contract' --reference 'contracts=main'
ap run --repo autopod --spec ./specs/startup-fix --preview --json
ap workspace autopod scratch --profile development --instructions 'Implement the reviewed brief'
ap shell autopod --ai alternate
```

`start` and `pod create` use the same flags as `run`. `workspace` and `shell` take a repository positionally; `shell` offers an enrolled-repository picker when omitted. All creation uses the shared resolver. Workspace preview prints the effective configuration without creating or attaching.

Select presets with `--environment`, `--ai`, `--workflow`, `--github-access` and repeated `--tool-pack`. Clear optional selections with `--no-github-access`, `--no-tool-packs` and `--no-references`. A reference requires an enrolled repository and explicit ref; admission freezes its resolved revision and read-only archive. It does not grant that repository's memory or GitHub actions.

Use `--sidecar <instance-id>` repeatedly to require configured environment sidecars. `--no-sidecars` clears the request's required list; it does not disable sidecars that the environment itself requires. Unsupported backend sizes and sidecars fail during resolution.

Full `LaunchRequest` JSON supports settings without dedicated flags, including exact PIM assignments and detailed allocations. `--config` rejects conflicting flags; `--override-config` explicitly creates a new request from those edits.

Before admission, the CLI saves the exact request in a private launch journal and prints its path. Retry a lost response with `ap run --config <saved-request.json>`. Retrying this file preserves the request ID and frozen digest. Do not edit a retry file to request different work. Previewing again deliberately reads current configuration and can report a stale digest.

## Follow-up work

```sh
ap run --from-pod POD_ID --source-config original --task 'Continue this investigation'
ap run --from-pod POD_ID --source-config current --ai alternate --task 'Try the other provider'
ap complete POD_ID --pr --instructions 'Implement the reviewed brief'
ap research --repo autopod --task 'Investigate the parser' --preview --json
ap history --repo autopod --failures --limit 100 --preview --json
ap memory-workspace --repo autopod --preview --json
```

`original` reuses frozen settings and rejects category changes. `current` resolves today's repository/profile/preset choices and records the source. `worker` selects an interactive workspace's frozen worker template for a separate child. In-place handoff preserves pod identity and cumulative usage. Desktop worker creation synchronizes the workspace branch through the daemon before submitting; failed synchronization leaves the workspace available for repair.

History defaults to the selected repository's recorded launch identity. `--all-repositories` is explicit and can include older history without that identity. Memory workspaces export approved global and matching repository/setup entries. Selecting a shared profile does not combine private repository memories.

Create recurring tasks with `ap schedule create '0 9 * * *' --repo autopod --template 'Daily work'`. For an inline task, use `--name` and `--task` instead of `--template`. `create-launch` remains an alias for the same command. Create a report schedule with `ap schedule scan-create autopod 'Daily scan' '0 8 * * *' --base main --head main`. Both commands accept preset and allocation overrides.

Scheduled scans retain the configuration used when collecting each report. A human-selected repair uses those saved choices after preset edits and requires approval before delivery. Retrying the same selection returns the same repair pod. Older reports without a configuration snapshot require a new collection before launching a repair.

The native library offers forms for project setups, tools, sidecars, instructions, skills and MCP connections; complete JSON remains available for advanced fields. For an isolated local interaction preview, run `swift run --package-path packages/desktop ConfigurationPreview`. It keeps edits in memory and connects to no daemon or provider.

## Access and Goals

GitHub rules pair repository scope with operations. Workflows and branches have independent all/selected choices. Agent-requested reads, comments and workflow operations go through the daemon broker. Pods do not receive daemon GitHub/ADO publication credentials; source push, PR creation and merge remain control-plane operations.

PIM selections belong to the one configured user account and identify exact eligible assignments and scopes. `ap pim eligible` discovers choices. Preview and saving selections do not activate them. Activation can require provider approval and can expire independently of the pod.

Provider accounts are selected in AI preset routes. In desktop Settings, Provider Accounts handles authentication; “Open AI setups” opens account selection and fallback routes in the configuration library. Legacy profile-account links are rejected on the composable daemon. Custom advanced actions and test-repository pipelines are retired and are absent from composable schemas; conversion reports their legacy presence as a warning. Composed deployment uses the separately enrolled isolated runner described below; a legacy deployment configuration alone does not enable it.

Repository setups now support `integrations.serviceAccess` for scoped ADO reads and Azure logs. The desktop setup editor has service selectors, ADO operation checkboxes and workspace/table fields. Agents receive `service_access_list` and `service_read`; organization, project, repository and workspace come from the selected saved rule, not arbitrary request destinations. Operator suspension/repository revocation is checked before requests and again before results are released.

```json
{
  "serviceAccess": [
    {
      "id": "project-source",
      "service": "ado",
      "organization": "example",
      "project": "Example project",
      "repository": "Example repository",
      "operations": ["code.file", "code.search", "pr.read", "pr.threads", "pr.changes"]
    },
    {
      "id": "application-logs",
      "service": "azure-logs",
      "workspaceId": "11111111-1111-4111-8111-111111111111",
      "tables": ["ContainerAppConsoleLogs_CL"],
      "containerApp": "example-app"
    }
  ]
}
```

These are placeholders for explicit project setup values. ADO work-item reads/search can use a project-only rule; code and PR operations require a repository. Log reads select a table, bounded timespan and literal text filter. They do not accept arbitrary KQL, extra workspaces or cross-resource unions. Application Insights data uses the workspace tables `AppTraces`, `AppExceptions` and `AppRequests`. PIM remains a separate selected assignment; reading or listing these rules never activates it.

Offline conversion accepts a reviewed `serviceAccessByProfile` mapping. This explicitly replaces legacy ADO/log action choices; it does not silently preserve arbitrary query syntax or custom HTTP actions. Composed deployment now connects immutable source preparation, owner approval, deployment-only credentials, and an isolated Docker runner. The legacy host runner remains unavailable for composed pods.

Native Goals are capability-gated and currently unavailable in production. A Goal's achievement is separate from pod validation/delivery. Post-achievement rework becomes a tracked Task phase, retaining the original Goal and usage. Mocked transport tests do not enable a provider/runtime combination.

The Docker/Codex candidate records process identity before starting. After a daemon restart it stops the recorded process, reads the saved native Goal without loading its thread, reconciles usage and leaves paused work for explicit Resume. Missing process identity, uncertain termination or an unacknowledged start blocks continuation. Claude and Sandbox Goals remain unavailable while their adapters lack the required recovery and usage evidence.

The installed Claude 2.1.270 local fixture exposed native completion in transcript attachments and evaluator usage in final per-model totals. It did not establish reliable evaluator accounting after an interrupted run. Claude's documented native resume also resets its token-spend baseline, so that evidence cannot be treated as a durable whole-pod budget. See [Claude Goal behavior](https://code.claude.com/docs/en/goal).

## Offline conversion and restore

Rehearse first against a copied database with the existing protected encryption key. The mapping file contains account/credential references and policy choices, not secret values.

```sh
node packages/daemon/dist/configuration/conversion-cli.js --source DATABASE --output-directory EXISTING_DIRECTORY --secrets-key ORIGINAL_KEY --owner OPERATOR_ID --bindings MAPPINGS_JSON
```

The result includes source path identity, source content fingerprint, a redacted conversion manifest, blockers and its digest. Supply `--expected-digest REVIEWED_DIGEST` to rehearse applying on another private copy. Resolve all blockers and inspect the report before live apply.

The following operation is a separate, explicitly authorized cutover. Stop the daemon first; the tool requires an exclusive database connection and drained regular/managed work. It does not kill work or manage service processes.

```sh
node packages/daemon/dist/configuration/cutover-cli.js --operation apply-reviewed --database DATABASE --secrets-key ORIGINAL_KEY --source-identity REVIEWED_ID --source-fingerprint REVIEWED_FINGERPRINT --conversion-digest REVIEWED_DIGEST --owner OPERATOR_ID --bindings MAPPINGS_JSON
```

It verifies database/key backups and repeats conversion on a disposable copy before applying. Configuration conversion and its immutable cutover receipt commit together. It preserves dispatcher settings and does not start dispatchers or enable admission. The candidate's source release gate remains closed even after a successful conversion.

Before admitting new work, restore rehearsal can produce a separate database/key candidate:

```sh
node packages/daemon/dist/configuration/cutover-cli.js --operation restore-candidate --database DATABASE --secrets-key ORIGINAL_KEY --conversion-digest REVIEWED_DIGEST --output-directory EXISTING_DIRECTORY
```

It refuses any changed operational database or key state after cutover, including changes without new pods. Reconcile and retain those effects before considering rollback. It never replaces the active database. Selecting a restored database/key with the compatible prior binary is a separate operator action; do not run that binary against the converted schema.

## Deployments

Deployment supports the **latest published default branch**, pinned to an exact commit when requested. It does not deploy an unmerged pod worktree. A later branch push cannot change a pending approval. GitHub source discovery and local Docker execution are currently supported, regardless of the requesting pod's backend.

Isolated reviewers run in a digest-pinned image named per backend by `reviewerImages.local` / `reviewerImages.sandbox` in `configuration-host.json`. When a backend names none and ACR is configured, the daemon resolves the `autopod-node22` base (runtime CLIs, no repository content) to its current digest, re-resolving every 10 minutes; without either, review-enabled launches fail with `REVIEWER_IMAGE_UNAVAILABLE` (503).

Enroll a `deploymentTargets` entry in the operator's `configuration-host.json` with `id`, `repositoryId`, `setupId`, `image` (an already cached digest-pinned image), `allowedScripts`, `allowedEnv`, `allowedHosts`, `memoryBytes`, `cpus`, and `timeoutMs`. For networked execution the image must provide the daemon's firewall dependencies (iptables/ip6tables, HAProxy and dnsmasq); bootstrap failure prevents execution. Empty `allowedHosts` gives no network. There are no host mounts, daemon gateway exemption, implicit package/provider hosts, or source-push credentials.

In the repository setup, select the enrolled `targetId` under `integrations.deployment`, set `enabled: true`, `source: "published-default"`, and select `allowedScripts`. `env` uses normal value/secret references; only `deployment-env` credentials are resolved. Both setup and operator target must allow the script. Deployment credentials are version-bound to approval, separate from ordinary pod credential rotation. Launch overrides cannot edit integrations.

The pod's `deployment_request` takes `operationKey`, `scriptPath`, and `args`. It returns an approval request, not permission to execute; `deployment_status` observes its result. Keep the operation key when retrying. In the desktop configuration library, **Deployments** lists requests and shows the exact source, script, arguments and runner before approval. The CLI equivalent is:

```sh
ap deployment request POD_ID scripts/deploy.sh --key release-1 --args-json '["--production"]'
ap deployment review RUN_ID
ap deployment approve RUN_ID --digest REVIEW_DIGEST
ap deployment status RUN_ID
```

Only the owning operator can approve or deny. The daemon records the decision and starts the isolated execution once. Pods receive a script-exit/cleanup receipt; raw script output is withheld because it may contain credentials. A successful script exit does not independently verify the deployed service.

An uncertain execution blocks the target across pods and request keys. After checking the destination, use the desktop's **Reconcile** action or `ap deployment reconcile RUN_ID --digest REVIEW_DIGEST --outcome deployed --note 'What was checked'` (or `not-deployed`). AutoPod first confirms cleanup, then records the operator's external observation. It never automatically repeats an uncertain deployment.

Offline conversion requires an explicit `deploymentByProfile` mapping containing `source: "published-default"`, `targetId`, and `allowedScripts`; enroll the resulting repository/setup IDs on the target before launch. This does not modify any hosted profile by itself. Production admission remains closed pending the overall configuration cutover and live acceptance.
