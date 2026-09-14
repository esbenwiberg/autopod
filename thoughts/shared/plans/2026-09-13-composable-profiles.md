# Composable profiles and native Goals — implementation plan

Status: full plan explicitly approved by the user on 2026-09-13. Local implementation of all six phases is authorized and underway.
Implementation is in progress across the configuration, execution, AI/Goal and scoped-access foundations. No phase is marked complete. No live conversion, launch, publication or deployment has run.

Source baseline: `fcf9a6c81ed39ec9ac43fc90584868aa5165008a`, inspected 2026-09-13.
The working tree was clean when planning began. Recheck HEAD and local changes before implementation.

## Implementation evidence so far

Updated 2026-09-14. This records the approved local implementation, not release acceptance. Production admission remains source-gated off. No production database conversion, provider launch, PIM activation, external GitHub mutation, publication or deployment has run. The six-phase plan is not complete.

The candidate now includes:

- TeamPlanner-oriented scoped ADO and Azure log reads in repository setups, dedicated MCP tools, daemon-held credentials, fixed-origin transport, response scope checks, current operator-policy checks, desktop forms and explicit offline service-access mappings. Deployment now supports published-default source only: exact-commit/script review, owner approval, credential-version binding, asynchronous isolated Docker execution, retained target claims, restart cleanup and explicit operator reconciliation (migration 205). CLI and desktop controls are wired; live credentials/egress and release acceptance remain outstanding. Details: `thoughts/shared/research/2026-09-14-teamplanner-deployment-implementation.md`.

- Revisioned repositories/setups, profiles, environments, AI/workflow/GitHub/tool presets, explicit overrides, credential references, one resolver and immutable launch/worker/derived snapshots. Repository memory and history are separated from reusable profiles. Images use software identity; references use admitted source revisions and read-only archives.
- CLI and native desktop configuration, launch preview, allocations and sidecar choices, PIM discovery/selection, save-as-profile, original/current reruns, analysis workspaces, schedules, series and watcher bindings. Desktop startup uses the configuration library and never falls back to old profile configuration when the new API fails. The standalone native preview keeps edits in memory without daemon/provider access.
- Composed pod admission inserts from the effective configuration directly, without constructing or storing a legacy Profile. Creation, dependency checks, task context, overlap policy and commit-before-enqueue have fixtures. Worker activation and Goal-to-Task rework no longer persist duplicate legacy profile snapshots. The temporary snapshot-to-Profile adapter has been removed: execution, validation, reviewer, provider and delivery consumers use an explicit PodExecutionSettings contract. Diff and Podsitter readers use the frozen source identity. Legacy Profile fallback remains confined to older execution/history paths and test factories.
- Isolated AI reviewer routes, account/revocation checks, per-attempt usage/failover and whole-pod accounting; scoped daemon GitHub read/comment/workflow brokers and uncertain-operation records; same-account PIM discovery and shared activation leases. Agent-requested source publication remains unavailable. Managed protocol/grant authority stays separate.
- Native Codex Goal transport/controller/state, attempt fences, cumulative accounting, pause/cancel and achievement-to-Task rework. Docker exec identities are saved before start and tied to the original attempt, account, configuration and container. Recovery confirms termination, inspects unloaded native state without credentials or continuation, reconciles cumulative usage, and releases the old task run only with durable stop evidence. Lost inspection processes are also recovered. The create-before-start-acknowledgement crash window now closes only after Docker proves the exact recorded exec has exited; failed ownership/exit checks retain the claim. Ordinary pod recovery preserves paused Goals and uses validation-only recovery after achievement. Resuming an earlier Goal requires explicit intent. Claude and Sandbox adapters remain unavailable regardless of supplied acceptance receipts.
- Scheduled scans freeze the collection configuration; repair admission independently reconstructs and verifies the saved human selection. The judge uses the selected explicit account with bounded preflight and no ambient credential fallback. Older reports without frozen configuration require recollection.
- Workspace handoff includes exact NUL-delimited Markdown/contract paths, preserves unrelated staged files, and propagates commit/push failures. Authenticated daemon Git now uses an environment excluding unrelated account secrets, disables repository hooks and credential helpers, and blocks executable transport rewrites. Real disposable Git fixtures ran without any remote push. Custom advanced actions and test pipelines are retired from composable schemas; composed deployment uses its separate isolated adapter.
- Offline conversion/cutover/restore commands with source identity, verified private database/key backups, stale-input and drained-work checks, transactional conversion receipts and a separate closed release gate. Both API fixtures and built-command rehearsal/apply-once/restore fixtures passed on disposable databases; restore refused subsequent effects. Migrations through 205 have only been applied to fixtures. Legacy account links and live profile network changes are retired; profile warming is no longer scheduled.

### Current observed evidence

| Check | Latest observed result |
| --- | --- |
| Full repository pipeline, latest retirement/Goal-recovery/deployment candidate | All checks passed: lint, build, supported type generation, tests, configured audit threshold and secret scan. Daemon: 373 files passed/4 opt-in files skipped, 5786 tests passed/6 skipped; CLI: 297; shared: 405; mobile: 150; escalation: 114; validator: 16; pi-worker: 9. Custom advanced actions and test pipelines are absent from composable schemas; focused conversion tests prove legacy instances yield explicit warnings without copying custom-action credentials. The two slower integration tests retain their test-only 15-second budgets. One moderate dependency finding remains below the configured threshold. Log: `/private/tmp/autopod-composable-retirement-final.log`. |
| Swift package | 371 tests passed after the new scoped ADO/Azure log setup forms and final table choices. Log: `/private/tmp/autopod-service-access-swift-final.log`. |
| macOS app | Unsigned Xcode Debug build succeeded after the scoped service-access forms. Log: `/private/tmp/autopod-service-access-xcode-final.log`. Native interaction remains unverified. |
| Built offline commands | Disposable source-byte-preserving rehearsal, apply once, restore to a new candidate, and refusal after subsequent effects passed. No live database was touched. |
| Git authority | 778 focused tests passed, including disposable Git commits and an executable remote-rewrite rejection. Full suite above includes these changes. |
| Direct admission | All 26 configuration files/88 tests passed; two additional task-context/dependency fixtures then passed after fixing their missing request digests. The full pipeline includes the final fixtures. |
| Execution contract | All 5742 daemon tests passed after removing the Profile projection. Targeted compiler analysis reported no execution-contract diagnostics; this does not claim that unrestricted raw tsc has no unrelated diagnostics. |
| Docker Goal process recovery | A real disposable container using cached Node image `sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e`, no network, no mounts, no credentials, UID 1000 and limited resources passed exact-exec termination through a fresh manager. The fixture removes its own container. This is backend process proof, not provider Goal acceptance. |
| Reference source ownership | A real Docker fixture with the normal writable root filesystem, all capabilities dropped, UID 1000, no network, no host mounts and the same cached Node image installed a frozen archive through the actual manager. The agent could read it but could not append, chmod, delete or replace the root-owned source; no `.git` was present. Fixture containers were removed. Sandbox ownership remains unverified. |
| Sidecar isolation | Two PostgreSQL 17 containers using cached image `sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73` passed daemon readiness checks and SQL queries from their respective pod networks. Each worker could reach its own `db` alias but not the other database IP. No database ports were published to the host. The fixture resolved the launch through the actual configuration resolver and generated the production sidecar spec, verified 256 MiB/0.5 CPU allocation, and used the actual sidecar/network/container managers; task-owned containers and networks were removed. |
| Native Codex storage protocol | Installed Codex 0.152.1 passed a local fixture with isolated homes and a rejecting local provider: a fresh app-server read and paused a saved Goal while the loaded-thread list stayed empty and provider requests stayed at zero. No inference or account access occurred. |
| Native Claude observation | Installed Claude 2.1.270 ran one native Goal against a fake local provider with no tools or real credentials. Native `goal_status` transcript attachments distinguished the sentinel and completion. The ordinary result `usage` counted 10 fixture tokens; `modelUsage` included 10 main plus 10 evaluator tokens. The completion attachment's `tokens` value was 6, so it is not complete input/output accounting. Crash-time evaluator usage recovery remains unproven and the adapter stays unavailable. |
| Native UI interaction | Unverified: CUA failed with `CUA_REPL_ENABLED_SURFACES is required`. Owned offscreen SwiftUI bounds checks passed for seven forms, but rasterized native controls were incomplete; these images are not visual acceptance. This is tool unavailability, not an approval rejection. |
| Provider/backend/live acceptance | Not run: no authorized fixture accounts/budgets, PIM assignments or external-write repositories have been exercised. Docker/sandbox/reference ownership, managed execution, cross-provider review, native Goal recovery and live conversion remain separate release gates. |

### Remaining implementation and release blockers

1. Complete the functional-preservation and external deployment review. The direct legacy caller review is recorded in `thoughts/shared/research/2026-09-14-legacy-configuration-callers.md`; it found and fixed end-of-run credential persistence through old profile links. The regression failed before the fix, then all 638 pod-manager tests passed. The concrete Pi and managed consumer report is `thoughts/shared/research/2026-09-14-external-configuration-migration.md`. Actual external enrollment and live conversion mappings still require review.
2. Complete full native Goal/provider acceptance and an observable Claude lifecycle/accounting adapter. Local Docker now covers the unacknowledged-start recovery window, but the complete provider journey remains unobserved. Claude 2.1.270 and Sandbox native Goals are explicitly unavailable.
3. Complete native interaction and real backend/provider journeys with explicitly scoped test accounts, budgets, repositories and PIM assignments. Mocked transcripts or local structural checks cannot enable those capabilities.
4. Review the real conversion manifest and external consumer migration report before separately authorized live cutover/publication/deployment. Keep admission closed until the above gates are met.

Candidate operator documentation: `docs/composable-configuration.md`. No phase is marked complete by this progress record.

## Outcome

One repository can run with different configurations, and one configuration can serve many repositories. The usual launch should require only a repository and task. Repository defaults fill in the profile; the user can change the profile, preset choices, or individual values for that launch.

The user is the sole operator and accepts breaking changes. Replace profile inheritance with shared preset references and explicit launch overrides. Do not preserve a second configuration system indefinitely.

## Decisions agreed in the conversation

| Piece | Owns |
| --- | --- |
| Repository | Source identity, branches, project commands, working directory, project-specific validation paths, usual profile |
| Environment preset | Installed software, toolchain and browser tooling, preparation steps, sidecar definitions |
| Execution settings | Docker or hosted sandbox, main-container CPU/memory, sidecar allocations where supported; remembered in the profile, overridden at launch |
| AI preset | Main agent and independent reviewer, each with account/runtime/model/reasoning and optional failover; reviewer can follow main |
| Workflow preset | Agent/interactive operation, Task/Goal execution, validation selection, AI review, output, daemon delivery/approval, budgets, escalation |
| GitHub access preset | Multiple rules pairing repository scope with permitted agent-requested reads/actions |
| Tool packs | Multiple selectable packs of skills, MCP servers and reusable instructions |
| PIM settings | Selected eligible assignments for the same user account, exact scope, duration, justification, startup/on-demand activation |
| Profile | Saved references to the above presets plus execution and PIM defaults; no parent |

### Composition and launch

- Select one environment, AI setup, workflow, and GitHub access rule set; select multiple tool packs and PIM assignments.
- Repository usual profile is a default, not a restriction. Explicit profile selection wins; explicit launch selections and value overrides win over that profile.
- A preset switch replaces that category coherently. In particular, an AI switch cannot keep an old account with a new runtime/model accidentally.
- An omitted choice uses defaults; explicit removal/none/empty clears it. No legacy null/empty inheritance semantics in the new API.
- Editing a shared preset changes future launches, not the configuration of queued or running pods. Persist the effective launch configuration and provenance at creation, with credential references rather than secrets.
- CLI and desktop use the same daemon resolution and compatibility checks.
- Repository instructions remain repository-owned. Tool packs do not grant access; conflicting tool definitions are surfaced rather than silently overwritten.
- Environment images are reusable across repositories. Optional prepared repository caches depend on repository + environment + relevant preparation inputs. Main AI selection and CPU/memory changes do not, by themselves, invalidate a software image.
- Backend capabilities determine available allocations and supported sidecars. The mockup's sample resource sizes are not a claim that hosted sandbox supports them.

### GitHub authority — hard boundary

The pod edits and commits locally. Only the AutoPod daemon performs push, branch publication, PR creation/editing and merge. A pod must not receive direct credentials or operations enabling those delivery effects. This applies to both regular and managed pods.

Agent-requested GitHub operations go through daemon tools:

- Read code; read issues, PRs, diffs and reviews; read Actions runs, jobs, logs and artifacts.
- Separately selected issue management, issue comments, PR comments, workflow dispatch, rerun and cancellation.
- PR comments are explicitly distinct from PR lifecycle/content changes owned by delivery.
- Scope can be the current repository, explicit repositories, or all/selected repositories under the actual personal owner or an organization such as `context-and` or `context-and-sandbox`.
- Do not use the ambiguous label “My repos.” Personal ownership and private visibility are different concepts.
- Support selected workflows or all workflows within the matching repositories. Branch restrictions remain independent. Overlapping rules add only their explicitly scoped permissions.
- Workflow delivery policy is not an agent access permission. An agent can have read-only GitHub access while the daemon is authorized to publish its completed branch and PR.
- Managed mode retains Dispatcher ownership of grants and verification; AutoPod executes bounded delivery. New presets cannot widen a managed grant or bypass its configured capability ceiling.

### PIM experience

- Discover eligible access and show a searchable multi-select with readable role/group and scope labels.
- Save exact identifiers internally; do not require the user to enter GUIDs.
- Selection does not activate anything during configuration. The selected startup/on-demand policy governs later daemon activation.
- Preserve active/pending/failed distinctions and surface provider-required interaction. Reuse the Pi discovery approach, not an interactive Pi command as a backend subprocess.
- Same account throughout; no multi-account PIM abstraction.

### Native Goal scope

- Optional Task/Goal choice in Workflow; the profile can default to Goal, while the objective is supplied for this launch.
- One native goal per pod. No cross-pod goal scheduler or goals requiring a daemon-created PR to exist before the agent can finish.
- Native Codex/Claude continuation, lifecycle reporting and cancellation/resume. Unsupported runtime/backend combinations are visibly unavailable, not silently emulated with repeated prompts.
- Budget covers the whole pod, including main/reviewer/failover and goal evaluation usage. Native resets must not reset daemon accounting.
- Native goal achievement is not pod completion. Required AutoPod validation, review and daemon delivery still follow.
- Claude's native goal evaluator is distinct from AutoPod's independently selected reviewer.

## Current source findings

| Evidence | Consequence for implementation |
| --- | --- |
| `packages/shared/src/types/profile.ts:58` and `packages/daemon/src/profiles/inheritance.ts:36` | Profile owns unrelated categories and has special merge rules. Migration must resolve the old chain before splitting it. |
| `packages/shared/src/types/pod.ts:556`, `packages/shared/src/schemas/pod.schema.ts:82` | Creation is profile-first; replace its contract and validate both client paths against the same schema. |
| `packages/daemon/src/pods/pod-manager.ts:7852`, `:8708` | Creation resolves a profile, but the full profile snapshot is written at provisioning. Snapshot timing and repeated live-profile reads need explicit changes. |
| `packages/daemon/src/pods/pod-manager.ts:5055` | Reviewer configuration currently follows profile/provider-attempt binding. Independent review requires independent credential, runtime and accounting paths. |
| `packages/daemon/src/images/image-builder.ts:54`, `packages/daemon/src/images/dockerfile-generator.ts:75` | Warm images are named by profile and may contain cloned source. Split shared software identity from repository preparation/cache identity. |
| `packages/daemon/src/containers/sidecar-resolver.ts:18`, `packages/shared/src/types/sidecar.ts:13` | The implemented sidecar is Dagger. PostgreSQL/Redis in the sketch are desired additions, not existing generic support. |
| `packages/daemon/src/containers/docker-container-manager.ts:325`, `packages/daemon/src/containers/sandbox-container-manager.ts:205` | Docker maps explicit resource caps; sandbox maps supported tiers and rejects excessive memory. New selectors must reflect actual capabilities. |
| `packages/daemon/src/api/routes/pods.ts:1399`, `packages/daemon/src/pods/pod-manager.ts:6125` | Explicit credential injection can install Git authentication in a pod. The agreed delivery boundary requires removing this escape path, including escalation and client callers. |
| `packages/daemon/src/github/daemon-github-auth.ts:46` | Current GitHub auth is daemon-owned. Do not assume old per-profile PAT fields are the active credential source. |
| `packages/daemon/src/actions/action-engine.ts:149` | Existing policy aggregation uses allowed resource lists. New scope/operation/workflow/branch tuples need a dedicated evaluator to prevent accidental cross-combination of grants. |
| `packages/daemon/src/managed/github-read-gateway.ts:7`, `packages/daemon/src/managed/grants.ts:45`, `packages/daemon/src/managed/source-delivery.ts:124` | Managed reads are currently narrow; admission and verified source delivery are separate. Preserve those boundaries and reject unsupported capabilities. |
| `packages/daemon/src/actions/handlers/azure-pim-handler.ts:24` | Eligibility matching has an exact-scope preference followed by a same-role fallback. New selections must bind the exact assignment and scope, not take that fallback. |
| `packages/shared/src/types/memory.ts:1`, `packages/daemon/src/pods/memory-selector.ts:72` | Project memory is profile-scoped. Shared profiles must not spread repository-specific memory to other repositories. |
| `packages/shared/src/types/scheduled-job.ts:37`, `packages/shared/src/types/issue-watcher.ts:6` | Scheduled work and issue watching carry profile identity. They need explicit repository/launch bindings. |
| `packages/daemon/src/runtimes/claude-runtime.ts:387`, `packages/daemon/src/runtimes/codex-runtime.ts:617` | Current adapters invoke Claude print mode and Codex exec. Native Goals need runtime-specific integration. |
| `packages/daemon/src/runtimes/codex-stream-parser.ts:637`, `packages/daemon/src/runtimes/stream-grace.ts:46` | Goal updates are ignored and completion/grace behavior assumes terminal work. Native multi-turn goals must not be stopped on an intermediate turn or task summary. |
| `packages/daemon/src/db/migrate.ts:9` | Migration runner already detects duplicate prefixes and supports verified backups for destructive cutovers. Extend this mechanism; do not rely on the older guide's silent-collision description. Highest observed SQL prefix: 185; select numbers again during implementation. |

The user's Pi picker was located at `/Users/ewi/repos/pilot/extensions/azure-pim.ts` and read without executing it. `getAllPages` handles pagination; `getResourceRoles` returns Azure resource role/scope/eligibility identities; `getEntraRoles` discovers directory roles for the signed-in user. Its status classification distinguishes pending approval from active access. AutoPod currently models groups and Azure RBAC roles, so the detailed plan must explicitly map those role families rather than conflate groups and directory roles.

## Implementation approach

Build one typed daemon resolver and migrate consumers to its result. Introduce the new storage and resolver alongside the old system for fixture testing; expose the new launch path only after its authority checks and clients are complete. The transition adapter is internal and temporary, not a second public configuration model.

The following are implementation choices proposed by this detailed plan. They make the agreed design concrete without adding more top-level preset categories.

### Entities and revisions

| Entity | Contract |
| --- | --- |
| `RepositoryConfig` | Stable ID, source provider and canonical remote identity, named project setups, default setup, optional usual profile, repository integrations and separately controlled trust. |
| `RepositorySetup` | Commands, working directory, branch defaults, paths and validation timeouts. Ordinary repositories have one setup. Named alternatives preserve cases where old profiles used different commands/subdirectories for the same repository. These live inside the repository editor, not in another preset picker. |
| `EnvironmentPreset` | Base image/template and tool versions, software preparation, optional sidecars identified by stable instance IDs. Repository preparation commands remain in the project setup. |
| `AiPreset` | `main: AgentRoute`, `reviewer: {mode: 'follow-main'} | {mode: 'independent', route: AgentRoute}`. Each route has account ID, runtime, model, reasoning and ordered failover routes. No secrets. |
| `WorkflowPreset` | Mode, Task/Goal default, output, selected validation phases, review requirement, completion/delivery policy, budget/attempt limits and escalation. |
| `GitHubAccessPreset` | A list of complete scope-and-operation rules; an empty list means no agent GitHub access. |
| `ToolPack` | Ordered instructions and skill/MCP definitions with required environment capabilities and credential references where permitted. |
| `LaunchProfile` | Environment/AI/workflow/GitHub preset IDs, ordered tool-pack IDs, execution defaults, PIM defaults and optional worker-profile ID. No repository or parent. |
| `EffectiveLaunchConfig` | Schema version, resolved repository/setup, complete nonsecret settings, immutable selected revisions, artifact/content digests, access scope, provenance and configuration digest. |

Each editable entity has a stable opaque ID, unique human-readable name, integer revision and timestamps. Store immutable revision payloads and a current-revision pointer; validate JSON payloads with strict shared schemas. References in saved profiles select the current revision for future launches. Resolution pins every revision for this launch. Rename does not break IDs; archive is the normal deletion operation. Refuse deletion of referenced configuration; historical revisions remain readable.

Do not flatten credentials into revisions. Existing provider accounts remain the AI credential authority. Add daemon credential references only where existing registry/other integrations need them. Secret values in legacy MCP headers, URLs, build/deployment environments or injected configuration must be extracted into encrypted storage, or reported as a conversion blocker when their delivery would violate the new boundary. Typed secret references are allowed in the internal snapshot; public projections show safe labels/presence only. Use schema-aware projections, not a blacklist that mistakes `tokenBudget` for a secret or misses a nested header.

### Resolution and API contract

New shared definitions belong in `packages/shared/src/types/launch-config.ts` and `packages/shared/src/schemas/launch-config.schema.ts`. The conceptual request is:

```typescript
interface LaunchOptions {
  profileId?: string; // otherwise repository.usualProfileId
  task: string;
  intent?: 'task' | 'goal'; // otherwise workflow default
  selections?: {
    environmentId?: string;
    aiId?: string;
    workflowId?: string;
    githubAccessId?: string | null;
    toolPackIds?: string[];
  };
  overrides?: LaunchOverrides; // explicit typed fields; no arbitrary object merge
  referenceRepositories?: ReferenceRepositorySelection[];
  expectedDigest?: string;
  requestId?: string;
}
type LaunchRequest = LaunchOptions & (
  | { repositoryId: string; repositorySetupId?: string; emptyWorkspace?: never }
  | { emptyWorkspace: true; repositoryId?: never; repositorySetupId?: never }
);
```

`LaunchOverrides` has typed category patches (`repositorySetup`, `environment`, `ai`, `workflow`, `githubAccess`, `execution`, `pim`, `toolPacks`). Only settings allowed at launch appear in these schemas: repository trust, daemon identities and managed grant ceilings cannot be overridden. Arrays replace whole arrays. Scalars replace individual values. Optional clearable values accept explicit `null`; required values reject it. An empty collection means empty. No append/deep-merge magic. Patches apply after selected presets, so editing a field changes the currently selected category. Removing an override restores that selected preset's value.

New daemon routes:

- `GET /configuration/capabilities`: schema/API version, supported backend allocations, sidecars and runtime features, with reasons for disabled combinations.
- CRUD `/repositories`, `/presets/:kind`; replace `/profiles` payloads with `LaunchProfile`. List/get/editor projections are nonsecret and revision-aware. Updates require an expected revision, returning `409` on concurrent edits.
- `POST /launch/resolve`: validate and return effective preview, provenance, compatibility errors and digest. Performs discovery reads only; no pod, credential minting, image build, role activation or external write.
- `POST /pods`: accept `LaunchRequest`; use the same resolver. When `expectedDigest` is supplied, changed selections/discovery return `409 CONFIG_CHANGED` and a new preview. When omitted, resolve the current configuration atomically as a direct scriptable launch.
- `POST /profiles/from-launch`: atomically save a named combination. Unchanged categories reuse references; changed categories become explicitly named new presets/packs. Return the complete save proposal before mutation. Never silently edit a shared preset or hide override data inside a saved profile.

Resolution order: schema defaults → selected repository setup → explicit/usual profile → selected category replacements → launch field overrides → capability/policy validation. Repository settings and category settings have disjoint ownership, so this order is not an inheritance chain. Missing usual profile requires an explicit choice. Missing required validation commands are an actionable error unless the chosen workflow does not request that phase.

Discovery happens before the database transaction. The transaction verifies all selected revisions and discovery binding/digest, inserts the pod plus snapshot and initial attempt identity together, then enqueues it. Concurrent create retries with the same request ID and payload return the existing pod; a changed payload with that ID is rejected. No database transaction remains open during provider/network calls.

Provisioning, retry, validation, review and delivery read the pod snapshot. Credentials may rotate behind the same reference, but a missing/revoked account blocks the operation; no borrowing another account. Current revocation/trust/managed ceilings may reduce authority at execution, never expand the snapshot. Tool content from files/GitHub is resolved to a recorded content digest before enqueueing; later source edits cannot change queued tools. If content cannot be resolved, creation fails with the missing item.

Rerun defaults to the original snapshot. “Use current settings” explicitly re-resolves a new launch and shows the differences. A dependent or fix pod gets its own snapshot from the parent's pinned settings plus its bounded task/branch changes. Workspace worker-profile selection is pinned as a resolved worker launch template when the workspace is created; reject cyclic worker-profile references.

### Complete legacy field ownership and migration

Resolve each legacy inheritance chain using today's semantics before transforming it. The table covers every top-level `Profile` field; maintain a compile-time exhaustive migration map so later source additions cannot disappear silently.

| Legacy fields | Destination / conversion |
| --- | --- |
| `name`, `createdAt`, `updatedAt`, `version` | `LaunchProfile` identity/revision metadata; preserve original identifiers/version in the migration manifest and historical snapshots. |
| `repoUrl` | Canonical `RepositoryConfig` identity; strip URL credentials before comparison or display. Retain provider-specific identity; do not blindly lowercase case-sensitive paths. |
| `defaultBranch`, `buildCommand`, `startCommand`, `buildWorkDir`, `healthPath`, `healthTimeout`, `smokePages`, `testCommand`, `validationSetupCommand`, `buildEnv`, `buildTimeout`, `testTimeout`, `lintCommand`, `lintTimeout`, `sastCommand`, `sastTimeout`, `hasWebUi` | `RepositorySetup`; preserve exact resolved values, including intentionally disabled commands. Secret build environment values become references. Distinct setups get explicit names derived from the old profile. |
| `template` | Environment base/toolchain choice. Preserve the actual installed capabilities of each template; a `pg` template does not automatically imply a new database sidecar. |
| `sidecars` | Environment sidecar definitions; resource allocations move to execution settings keyed by sidecar instance ID. Preserve Dagger disabled/enabled/auto behavior. |
| `executionTarget`, `containerMemoryGb`, `networkPolicy` | Profile execution defaults. Preserve unlimited vs explicit limits where the backend supports them. CPU/sidecar sizing added with capability validation. |
| `defaultModel`, `defaultRuntime`, `reasoningEffort`, `modelProvider`, `providerAccountId`, `providerFailover` | AI main route. Resolve account-default failover into the launch snapshot; editing the account's default later affects future launches only. |
| `reviewerModel` | Preserve current effective reviewer route, usually main account/runtime plus the old reviewer model. Use follow-main only when semantically equivalent; otherwise materialize an independent route. |
| `providerCredentials`, `openrouterApiKey` | Deduplicated encrypted provider-account storage and AI route reference. Preserve valid existing account IDs; never put credentials in preset JSON. |
| `pod`, `outputMode` | Canonical workflow mode/output/validation/advisory/promotable settings. Resolve current `PodOptions` first; retire the lossy `outputMode` mirror from new APIs. |
| `maxValidationAttempts`, `mergePollIntervalSec`, `preflightConflictPolicy`, `branchPrefix` | Workflow attempt/delivery/conflict settings. |
| `tokenBudget`, `tokenBudgetWarnAt`, `tokenBudgetPolicy`, `maxBudgetExtensions` | Workflow whole-pod budget policy; preserve explicit unlimited and extension behavior. |
| `escalation`, `agentDonePrompt` | Workflow escalation and completion guidance. Existing ask-AI model selection remains preserved and its usage joins the shared budget. |
| `skipValidationPhases`, `securityScan` | Workflow phase selection/security policy. Convert actual effective skip set; provisioning/pre-push security checks remain distinct from optional validation SAST. |
| `customInstructions`, `mcpServers`, `claudeMdSections`, `skills` | Generated tool pack with resolved content/order and credential references. Repo-specific packs stay selected only by migrated profiles that used them. |
| `codeIntelligence` | Tool-pack enablement and declared environment prerequisites; migrate required installed software into the environment. |
| `actionPolicy` | GitHub rules for representable GitHub operations; preserve non-GitHub action policy as a workflow advanced field. Unknown/custom credentialed effects require explicit conversion, not a broad wildcard grant. Existing sanitization/approval requirements remain enforced. |
| `prProvider`, `privateRegistries`, `deployment` | Repository integration settings. Different legacy integration configurations are attached to the corresponding repository setup; credentials remain daemon-side references. ADO delivery stays daemon-owned. Legacy test pipelines are retired. |
| `githubPat`, `githubPatExpiresAt` | Retire from profiles. Preserve encrypted legacy material in backup/quarantined migration storage and expiry metadata for review; use canonical daemon GitHub auth. Do not silently switch daemon auth to a legacy PAT. |
| `registryPat`, `registryPatExpiresAt` | Encrypted registry credential reference and expiry metadata. Broad ADO/GitHub tokens cannot be delivered into the pod; use scoped feed access or daemon mediation. |
| `workerProfile` | Profile worker-profile ID; migrate by ID and pin the worker launch template at workspace creation. |
| `pimActivations` | Exact PIM selections in profile defaults. Preserve existing group startup behavior and effective durations/justification; preserve RBAC action use without inventing startup activation. Resolve eligibility IDs during preview and block ambiguous matches. |
| `trustedSource` | Separate repository/setup trust authorization. Conflicting legacy values do not make the whole repository trusted; require an explicit mapping before enabling privileged sidecars. |
| `issueWatcherEnabled`, `issueWatcherLabelPrefix` | Repository-bound watcher configuration with explicit launch profile/setup. Preserve target-profile label behavior through migrated bindings. |
| `warmImageTag`, `warmImageBuiltAt` | Legacy cache inventory only; never relabel a source-containing image as shared. Rebuild new images under new cache keys. |
| `extends`, `mergeStrategy` | Used only to resolve old values during conversion; retire from editable configuration and new launch APIs. Keep raw legacy data in the migration manifest. |

Deduplicate environment/AI/workflow/access/tool-pack payloads by canonical content and credential identity, not by similar names. Preserve one migrated profile per old profile initially; consolidation is an explicit later edit. Profiles with no repository can become reusable bundles; callers that previously had no source use an explicit empty-workspace launch variant restricted to artifact/none. This preserves existing scratch/research capability without inventing a fake repository.

The migration manifest maps `legacyProfileName -> repositoryId | emptyWorkspace, setupId, profileId`. CLI migration output uses this mapping; the new CLI never guesses whether a positional string is a repository or an old profile. If a repository has several legacy choices, leave its usual profile unset until selected. Named setups preserve differences; they do not choose a winner.

### Delivery and policy enforcement

Treat agent tools and daemon delivery as separate entry points with separate typed operations. No generic `push`, `create_pr`, `update_pr` or `merge` agent tool is introduced. Delivery receives a verified candidate/source reference, repository identity, output policy and current authorization; it never takes an arbitrary pod-provided shell command with host credentials.

Remove Git/gh credential injection from API, CLI, desktop and escalation. Review provider setup, registry injection, MCP headers, the isolated deployment adapter and mounted Git config for equivalent bypasses. Custom HTTP actions and test pipelines are retired from the composable contract. A credential usable for source publication cannot be exposed to the pod just because it came from an AI account or package registry. An unsafe combination is unsupported until its broker/scoped-auth path exists.

Repository preparation must not run untrusted repository scripts in the daemon host credential context. Isolate builds; fetch source/dependencies with bounded credentials or broker access. Preserve safe existing deployment/pipeline contracts but ensure their explicit outputs do not let agent input select arbitrary publication effects. This is an enforcement requirement, not a claim that text instructions or scanning arbitrary secret strings make hostile code safe.

## Phase 1: Resolve and migrate configuration

### Changes required

- **New shared files:** `packages/shared/src/types/launch-config.ts`, `packages/shared/src/schemas/launch-config.schema.ts`. Export entity/request/snapshot/editor types through `packages/shared/src/index.ts`; update `packages/shared/src/types/profile.ts`, `packages/shared/src/schemas/profile.schema.ts`, `packages/shared/src/types/pod.ts` and `packages/shared/src/schemas/pod.schema.ts` for the new contract. Keep legacy parsing private to migration.
- **New daemon modules:** `packages/daemon/src/configuration/configuration-store.ts`, `launch-resolver.ts`, `launch-snapshot.ts`, `legacy-profile-migration.ts`. Implement revision CAS, deterministic resolution, provenance, secret-safe projections, request deduplication and conversion manifests. Add co-located tests.
- **Existing daemon integration:** `packages/daemon/src/profiles/profile-store.ts`, `profile-validator.ts`, `inheritance.ts`, `packages/daemon/src/api/profile-redaction.ts`, `packages/daemon/src/api/routes/profiles.ts`, `pods.ts`, `packages/daemon/src/api/server.ts`. New routes in `packages/daemon/src/api/routes/configuration.ts`. Wire the creation transaction and snapshot access through `packages/daemon/src/pods/pod-manager.ts` and `pod-repository.ts`; use a temporary read-only adapter from the snapshot where old consumers still require a resolved `Profile`.
- **Database:** new uniquely numbered SQL files in `packages/daemon/src/db/migrations/` for entities/revisions, pod launch snapshots and conversion manifests. Recheck the highest prefix at implementation time; do not reserve the observed next number in this document. Extend `packages/daemon/src/db/migrate.ts` and `cutover-backup.ts` for the final destructive cutover. Add a dry-run conversion entry point usable on a copied database.

### Success criteria

**Automated**

- [ ] `npx pnpm --filter @autopod/shared test` — schema cases distinguish missing/null/empty; reject unknown fields, illegal clear operations and cyclic worker references.
- [ ] `npx pnpm --filter @autopod/daemon test src/configuration src/profiles` — two repositories share one profile; preset switch is atomic; conflicting commands survive as separate setups; every legacy top-level field is classified.
- [ ] Snapshot integration tests create a queued pod, edit/delete/archive referenced entities, restart daemon, and prove settings/provenance unchanged. Revoked credentials block without selecting a replacement account. Stale preview and duplicate create requests behave as specified.
- [ ] Conversion tests include inheritance arrays/text, explicit empty replacement, profile-level credentials, ambiguous defaults/trust, scratch profiles and unknown action policies. Conversion failure leaves source data intact and preview contains no secret values.
- [ ] `npx pnpm --filter @autopod/shared build` and `npx pnpm --filter @autopod/daemon typecheck` pass after the adapter is wired.

**Manual**

- [ ] Inspect a redacted conversion preview: the old launch and new effective launch agree for representative real profiles. Review only unresolved migration mappings; no live migration is part of this phase.

## Phase 2: Launch reusable environments

### Changes required

- **Images:** update `packages/daemon/src/images/image-builder.ts`, `dockerfile-generator.ts`, `acr-client.ts`; add `environment-image-key.ts` and `repository-cache-key.ts` alongside them. Software identity includes base digest, OS/architecture, tool versions, environment preparation and builder version. Include shared agent launch tooling as a versioned layer so changing account/model does not rebuild software.
- Repository cache identity includes canonical repository, environment digest, source/preparation inputs and setup identity. Use source revision initially for correctness; optimize toward lockfile/input digests only with proven invalidation coverage. Never put one repository's checkout or credentials in the shared software image. Scope mounts/caches to repository and private-feed identity; token rotation alone need not invalidate public software layers.
- **Containers:** update `packages/shared/src/types/sidecar.ts`, `packages/daemon/src/containers/sidecar-resolver.ts`, `sidecar-manager.ts`, `docker-container-manager.ts`, `sandbox-container-manager.ts`, `packages/daemon/src/interfaces/container-manager.ts`. Add capability reporting under `packages/daemon/src/configuration/backend-capabilities.ts`.
- Sidecar definitions carry ID, type, pinned image, required environment, startup policy and health check. Execution settings carry main allocation and per-sidecar allocation. Preserve Dagger and add explicit PostgreSQL/Redis implementations with private pod networking, generated per-pod credentials where required, readiness and cleanup. No arbitrary privileged sidecar/image editor in this version. Database data is ephemeral for the pod, not a reusable volume preset.
- Start sidecars and await readiness before dependent preparation/validation; on partial failure clean up created containers/networks. Kill/recovery reconciles all labeled resources. Missing optional sidecars stay absent; a required disabled/incompatible sidecar is a launch error. Selecting a preset cannot elevate repository/host trust.
- Integrate `packages/daemon/src/pods/registry-injector.ts` with secret-free environment builds and bounded package access. Private dependency preparation fails visibly when no safe credential path exists.

### Success criteria

**Automated**

- [ ] `npx pnpm --filter @autopod/daemon test src/images src/containers` — equal software configurations reuse keys across repositories; source/setup changes separate repository caches; AI/allocation changes leave software identity unchanged; generated build context/history contain no secret fixtures.
- [ ] Sidecar tests cover readiness timeout, partial-spawn cleanup, daemon restart cleanup, separate pod networks, database credential isolation and total resource validation. Unsupported sandbox sizes/sidecars fail before allocation; privileged Dagger fails without independent trust.
- [ ] Fixture provisioning and snapshot tests prove repository preparation uses the selected setup and cannot read another repository cache.

**Backend/manual**

- [ ] On local Docker, launch two fixture repositories on one environment; observe software reuse and separate workspaces. Verify Dagger and PostgreSQL/Redis readiness and teardown.
- [ ] On hosted sandbox, verify its advertised allocations and supported sidecar subset using an explicitly authorized fixture. Disabled choices remain disabled if backend support is absent; do not treat mocked success as hosted proof.

## Phase 3: Independent AI review and native Goals

### Changes required

- **AI routing:** add `packages/daemon/src/pods/agent-route-resolver.ts`; update `provider-preflight.ts`, `provider-attempt-repository.ts`, `pod-manager.ts` (`resolveEffectiveBoundProfile`, `getEffectiveReviewerConfig`) and `packages/shared/src/types/provider-account.ts`. Distinguish main/reviewer/ask-AI usage and failover records. Reviewer attempts must not replace the active main attempt or overwrite its native session.
- Update `packages/daemon/src/interfaces/reviewer-launch.ts`, `packages/daemon/src/validation/container-reviewer-runner.ts`, `reviewer-launch-preflight.ts`, `reviewer-api-budget.ts` and `packages/daemon/src/pods/reviewer-api-provenance.ts`. Route review through its explicit runtime/account; preserve schema checking, admission deadlines and confirmed termination. Use isolated runtime credential homes/process environments, with a separate reviewer container when isolation cannot be enforced in the backend. Never replace the main agent's credential files to run review.
- Follow-main resolves to the current authorized main attempt at reviewer launch and records that concrete route; independent review retains its pinned route despite main failover. Each route fails over only along its own configured list. Disallowed/revoked routes stop; authentication failure never silently switches identity outside that list.
- **Goal types/storage:** new `packages/shared/src/types/goal.ts`, `packages/daemon/src/pods/goal-repository.ts`, `goal-controller.ts`; extend `types/runtime.ts`, `types/events.ts`, pod responses and WebSocket events. Persist objective, native runtime/session/thread identity, attempt fence, native status, daemon goal state, observed usage and timestamps. Goal states are separate from `PodStatus`: active, paused, achieved, blocked, budget-exhausted, cancelled, failed. Do not add a pod lifecycle state just to display a goal.
- **Codex:** new `packages/daemon/src/runtimes/codex-app-server-runtime.ts` and `codex-app-server-client.ts`. Use documented thread goal set/get/clear APIs and notifications; scope stdio transport/process lifetime to one pod, persist thread identity and reconnect/reconcile before continuing. Existing `codex exec` task mode can remain initially. Never equate an intermediate `turn.completed` with a goal terminal event.
- **Claude:** update `packages/daemon/src/runtimes/claude-runtime.ts` to pass native `/goal <objective>` in print mode, preserve native session identity and parse supported native lifecycle evidence. Extend the co-located Claude parser and `packages/daemon/src/runtimes/codex-stream-parser.ts` to retain goal events where applicable. Update `stream-grace.ts` and task-summary/completion consumers so native continuation is not killed after its first turn.
- **Capability gate:** record tested runtime versions and feature checks. A combination must demonstrate native start, continuation, terminal-state evidence, cancellation, resume/recovery and usable budget telemetry before advertising Goal support. Unsupported or unobservable native behavior is unavailable with a specific reason. Never infer achievement from a clean exit or invent an AutoPod repeated-prompt loop.
- Objective is immutable within this first-version pod goal; editing it starts a new pod. Keep the objective within the supported provider limit (Codex currently 4,000 characters) and validate before provisioning. Interactive mode cannot start a native goal until explicitly promoted to a supported agent workflow.
- Pause suspends native continuation and records durable intent; resume restores the same goal/session where supported. Cancel stops runtime execution, confirms exit and enters the existing pod cancellation path. Recovery reconciles native state before sending anything; stale events from superseded attempts cannot revive the goal.
- Goal failover may automatically resume only where native session continuity is proven for the selected target. Cross-runtime/provider handoff pauses with a visible explanation in version one; the user may explicitly start a replacement native attempt from recorded task/context, preserving the daemon goal identity and total budget. No claim of provider-native session portability.
- Keep a single authoritative usage ledger across main/reviewer/ask-AI/native evaluator and retries. An optional reviewer token sublimit is an additional cap within the whole-pod budget, never a separate allowance. Dedupe cumulative vs delta telemetry using attempt identity; evaluator tokens already included in provider totals are not counted twice. Native counters resetting on resume are offsets, not daemon budget resets. If evaluator usage cannot be established for budgeted Goal mode, that combination stays unavailable. Budgets stop at observed provider boundaries with any in-flight overrun reported; do not promise a provider-enforced hard token ceiling where none exists.
- Achieved goals proceed to the same configured validation/review/approval/delivery path as tasks. Blocked, cancelled, budget-limited or unknown goals do not publish automatically. Validation failure may enter existing bounded rework with an explicitly tracked continuation; it does not silently change the objective or erase goal history.

### Success criteria

**Automated**

- [ ] `npx pnpm --filter @autopod/daemon test src/pods src/runtimes src/validation` — main Anthropic/reviewer OpenAI and inverse route fixtures; correct independent credentials, reviewer failover, stale preflight rejection and confirmed timeout termination.
- [ ] Native transcript/transport tests cover multiple turns, duplicate/out-of-order events, disconnect/restart, pause/resume/cancel, stale attempt events, achieved then validation failure, and no terminal evidence. Task-mode behavior remains covered.
- [ ] Extend `packages/daemon/src/pods/pod-token-budget.test.ts` for main + reviewer + evaluator totals, cumulative replay, native baseline resets, budget extensions and failover. No duplicate work after uncertain termination.
- [ ] API/WebSocket tests expose goal state independently from pod completion and never mark a cancelled/blocked goal successful.

**Provider/manual**

- [ ] With explicitly authorized accounts and bounded fixtures, observe a real multi-turn native Goal in Codex and Claude; pause/resume and cancel it, restart the daemon, and verify accumulated usage and terminal evidence.
- [ ] Observe one supported cross-provider implementation/review run. Verify goal achievement still waits for configured validation and daemon delivery.
- [ ] Record exact runtime versions/backend/account route and any unavailable combinations. These observations are release evidence; mocked transcripts alone do not enable the capability.

## Phase 4: Scoped actions, tool packs and discoverable PIM

### GitHub changes

New shared rule definitions in `packages/shared/src/types/github-access.ts` and daemon modules `packages/daemon/src/github/access-policy.ts`, `discovery.ts`, `operation-ledger.ts`. Update `packages/daemon/src/actions/action-engine.ts`, `action-registry.ts`, `handlers/github-handler.ts`, `packages/daemon/src/api/mcp-handler.ts` and escalation bridge/tool schemas.

A rule contains:

```text
repositories: current | selected(repository IDs) | owner(owner ID, all | selected IDs)
operations: code.read, issues.read, prs.read, actions.read,
            issues.create/edit/close/labels, issues.comment, prs.comment,
            workflows.dispatch, runs.rerun, runs.cancel
workflows: all | selected(repository ID + workflow path/ID pairs)
branches: all | selected(exact branch names)
```

Workflow and branch selectors constrain workflow/run operations only. UI defaults are current repository and read operations; writes require explicit selection. Selecting all workflows never selects all branches. Version one uses exact branch names, not implicit glob matching. For owner scopes, show the actual owner login and resolved repository count; discover all pages, and report unavailable/incomplete discovery rather than silently accepting a partial list.

At launch, freeze explicit repository IDs and selected workflow identities. Owner-all covers repositories discovered for that launch; later additions appear on future launches. All-workflows deliberately means any workflow in those pinned repositories, including newly added ones; show this meaning in the editor. Selected-files remain bound to their selected paths/IDs, not a reused numeric index. Recheck current ownership/access and authoritative workflow/run repository/ref before effects. A moved repository does not retain owner-scoped access by accident.

Evaluate each complete rule against the complete requested operation, then permit if at least one matches. Never union repository/workflow/branch arrays first. Fetch rerun/cancel metadata server-side; refuse when a trustworthy branch/ref cannot be established. Issue mutation handlers must reject PR-backed issue IDs; PR comments have their own permission. Input IDs and URLs cannot redirect privileged calls to another repository/host.

Implement Actions runs/jobs/logs/artifacts read with bounded pagination, download size and retention. Do not forward Authorization across arbitrary redirects, extract unsafe archive paths or expose service tokens in output. Add precise typed handlers for approved writes; reserve daemon delivery mutations for existing delivery code.

Audit requested effect, matching rule/revision, caller/pod, repository and result. Persist an operation key before write dispatch. Recheck authorization when delayed approvals execute. Retry read failures normally; after an uncertain write, reconcile using provider evidence when possible. An uncertain workflow dispatch without reliable correlation becomes attention-required instead of a blind duplicate dispatch.

Remove credential-injection paths in `packages/daemon/src/pods/pod-manager.ts`, `packages/daemon/src/api/routes/pods.ts`, `packages/cli/src/commands/workspace.ts` and `packages/escalation-mcp/src/tools/request-credential.ts`. Other credential requests can survive only for genuinely scoped non-delivery services. Audit system instruction generation and all UI affordances so removed actions are not suggested.

Managed integration updates `packages/daemon/src/managed/github-read-gateway.ts`, `grants.ts`, `source-delivery.ts`, `workspaces.ts`, `profile-set-config.ts`. The shared policy evaluator can further restrict managed reads, but existing protocol grants remain authoritative. Keep currently unsupported comment/workflow/Goal capabilities disabled in managed mode unless the existing protocol and backend can enforce them. Do not broaden the Dispatcher protocol or alter its external repository in this work. Preserve exact candidate verification and granted branch/draft-PR delivery.

### Tool-pack changes

New `packages/daemon/src/configuration/tool-pack-resolver.ts`; update `packages/daemon/src/pods/skill-resolver.ts`, `injection-merger.ts`, `system-instructions-generator.ts`. Deduplicate identical definitions by digest; reject conflicting MCP/skill names with both sources named. Instructions concatenate in explicit user-visible pack order; repository instructions keep their own origin. Missing binary prerequisites point to the required environment capability. Secrets and broker policy are validated independently of pack selection. Per-launch injected files obey the same rules.

### PIM changes

New `packages/shared/src/types/pim.ts`, `packages/daemon/src/pim/eligibility-service.ts`, `activation-service.ts`, `activation-repository.ts` and `packages/daemon/src/api/routes/pim.ts`. Reuse/refactor `packages/daemon/src/actions/handlers/azure-pim-handler.ts`; remove role/scope fallback matching.

- Discovery endpoints return paginated eligible `group`, `azure-role` and `directory-role` assignments with tenant/principal/eligibility identity, role/group label, exact scope and provider-supported duration constraints. Directory role discovery/activation is a new explicit adapter, distinct from Groups. If provider grants do not permit a family, show its availability reason.
- Settings store exact assignment, timing (`startup` or `when-needed`), duration and justification. New selections default to when-needed and one hour, subject to provider policy; migration preserves actual existing defaults. No activation on list/resolve/save.
- Determine the authenticated principal server-side and bind the selection to it; do not accept an arbitrary principal from pod input. Recheck exact eligibility/scope at activation. Expired/revoked/ambiguous assignments fail without choosing another.
- Startup activation gates the operations that need it; pending external approval stays pending. On-demand tools can request only selected assignments, within saved duration/policy. A denied or failed role must not appear usable.
- Track shared leases by account/assignment/scope and provider request ID. Reuse pre-existing activation without claiming ownership; never deactivate it. For AutoPod-created activations, release only after all AutoPod leases are done and provider ownership is provable. Where ownership is uncertain, allow provider expiry rather than revoke somebody else's access. Expiry/revocation blocks subsequent protected actions; renewal beyond the chosen policy requires a new explicit request.
- PIM broadens the daemon account's available access, not the pod's policy. Every broker operation still checks the pod's exact permitted resources/effects.

### Success criteria

**Automated**

- [ ] `npx pnpm --filter @autopod/daemon test src/github src/actions src/pim src/managed` — rule matrix covers current/selected/personal/org repositories, overlapping rules, all/selected workflows, independent branches, transferred repos and incomplete discovery.
- [ ] Mutation tests cover PR-via-issue endpoint bypass, rerun/cancel spoofed metadata, custom HTTP bypass, delayed approval revocation, duplicate requests and uncertain dispatch. Daemon delivery succeeds independently of agent read-only permissions; managed effects outside grants fail.
- [ ] Credential-isolation fixtures cover Git remote/helper, gh/az login injection, mounted config, registry credentials, provider authentication and MCP headers. Direct publication cannot obtain daemon source credentials; removed endpoints/tools fail explicitly.
- [ ] Tool-pack resolver tests cover name conflicts, ordering, identical deduplication, missing prerequisites, content pinning and secret redaction.
- [ ] PIM tests cover all three families, pagination, exact IDs/scope, account mismatch, revoked eligibility, pending approval, no activation during preview, shared leases, pre-existing activation and expiry across restart.
- [ ] `npx pnpm --filter @autopod/escalation-mcp test` and affected bridge tests pass.

**Provider/manual**

- [ ] In a designated test repository, read a failed workflow's jobs/logs/artifacts; exercise selected dispatch/rerun/cancel and issue/PR comments. Verify a denied repository/workflow/branch stays denied. Use an explicitly authorized fixture for external writes.
- [ ] Against the same user account, discover readable PIM choices and observe activation/pending/expiry behavior for authorized test assignments. Configuring selections alone produces no activation.
- [ ] Demonstrate direct pod publication rejection and successful daemon-controlled publication after validation, in regular and supported managed fixtures.

## Phase 5: CLI and desktop parity

### Changes required

- **CLI:** update `packages/cli/src/commands/profile.ts`, `pod.ts`, `workspace.ts`, `research.ts`, `series.ts`, `schedule.ts`. New `repository.ts` and `preset.ts` commands plus a shared launch-request builder. Route all creation through `/launch/resolve` and `/pods`; remove local inheritance/default logic. Preview and CRUD accept/emit JSON for complete scripting. Never require an interactive picker to represent an option.
- New canonical examples (names resolved to stable IDs by the daemon/client lookup):

```sh
ap run --repo autopod --profile development --task "Fix the startup error"
ap run --repo autopod --ai alternate --execution local --memory-gb 8 --task "Investigate"
ap run --repo autopod --goal "The failing startup test passes"
ap run --config launch.json --preview --json
ap run --config launch.json
ap repository list --json
ap preset list --kind ai --json
ap profile show development --json
ap pim eligible --json
```

`launch.json` is the full shared `LaunchRequest` including exact PIM selections, sidecar sizing and access rules. Add explicit `--environment`, `--workflow`, `--github-access`, repeated `--tool-pack` and `--repository-setup` flags, plus clear flags such as `--no-github-access` and `--no-tool-packs`. Reject conflicting flag/file values unless an explicit documented flag override is supplied; preview the resulting value sources. `--task` uses workflow intent by default; add `--intent task` to override a Goal default. `--goal` supplies the objective and selects Goal mode.

- **Swift six-layer coverage:** update `packages/desktop/Sources/AutopodClient/Types/ProfileResponse.swift`, `AutopodUI/Models/Profile.swift`, `AutopodDesktop/Mapping/ProfileMapper.swift`, `AutopodDesktop/Stores/ProfileStore.swift`, `AutopodUI/Views/Profiles/ProfileFieldCatalog.swift`, `ProfileEditorView.swift`. Replace inherited/raw/resolved-parent models with selected/edited/provenance state. Replace `NewProfileKindSheet.swift` and retire `InheritanceChip.swift` once unused.
- Add `LaunchConfigurationTypes.swift` under `AutopodClient/Types/` and `LaunchConfigurationStore.swift` under `AutopodDesktop/Stores/`. Update `AutopodClient/DaemonAPI.swift`, `AutopodClient/Types/PodResponse.swift` (`CreateSessionRequest`), and `AutopodUI/Models/PodActions.swift` to pass one typed request rather than extending a long positional closure.
- Update `packages/desktop/Sources/AutopodUI/Views/Creation/CreatePodSheet.swift` (`CreateSessionSheet`), `CreateSeriesSheet.swift`, `SpawnDependentSheet.swift`. Repository + profile + task at the top; expandable preset rows show selection and “edited” state. Backend/size are execution settings. Main/reviewer/failover are explicit inside AI; multiple tool packs/PIM choices are supported.
- Repository editor exposes usual profile and project setup; setup selector appears at launch only when alternatives exist. Profile editor shows references and links to edit shared presets with usage counts. “Save as profile” names changed presets without changing their shared originals. “Reset” restores the selected preset; “switch preset” discards that category's unsaved overrides with a clear visible result.
- GitHub rule editor uses explicit owner/repository selection, grouped reads/writes, workflow all/selected toggle and independent branch choices. PIM picker shows role + scope + timing/duration, searchable multi-select; IDs are in advanced details. Show unavailable combinations with reasons returned by daemon.
- Reference repositories have explicit source/ref/read intent; adding one does not grant unrelated GitHub actions or daemon publication. Freeze their bindings in the same launch snapshot.
- Add `GoalStatusView.swift` under `AutopodUI/Views/Detail/` and integrate it into `packages/desktop/Sources/AutopodUI/Views/Detail/OverviewTab.swift`. Goal detail UI shows objective, native state, usage and pause/resume/cancel separately from validation/delivery status. A native goal may read “Achieved” while pod reads “Validating”. Stale preview refresh preserves user edits and shows changed choices instead of submitting silently.

### Success criteria

**Automated**

- [ ] `npx pnpm --filter @autopod/cli test` — positional legacy syntax gets an actionable migration message; flags/JSON/pickers construct equivalent requests; explicit clearing and conflicting values are tested.
- [ ] `swift test --package-path packages/desktop` — update mapper/editor/catalog fixtures and add request parity, revision conflict, reset/save, unsupported choices and goal event mapping tests.
- [ ] `xcodebuild -project packages/desktop/Autopod.xcodeproj -scheme Autopod -destination 'platform=macOS' -configuration Debug build` succeeds.
- [ ] Use shared JSON fixtures decoded by Swift and TypeScript to cover every editable setting, including non-default false/empty/null values and secrets-redacted responses.

**Manual**

- [ ] Launch the same repository through CLI and native desktop; compare daemon effective digests. Switch AI without changing environment, change allocation without changing software identity, and save a reusable profile for a second repository.
- [ ] Exercise keyboard navigation, search, long names, loading/error states and window resizing in native pickers. Demonstrate all-workflows/selected-branches and same-account PIM multi-selection.
- [ ] Verify editing a shared preset is visibly different from a launch-only override and does not change an already queued pod. Screenshots/mockups are guidance, not native acceptance evidence.

## Phase 6: Remaining callers, cutover and acceptance

### Changes required

- **Schedules/watchers:** update `packages/shared/src/types/scheduled-job.ts`, `types/issue-watcher.ts`, `packages/daemon/src/api/routes/scheduled-jobs.ts`, `packages/daemon/src/issue-watcher/issue-watcher-repository.ts`, `issue-watcher-service.ts`, and `packages/daemon/src/scheduled-jobs/scheduled-job-repository.ts`, `scheduled-job-manager.ts`, `scheduled-job-scheduler.ts`. Persist repository/setup/profile IDs plus launch overrides. Each future scheduled run resolves current referenced presets into a fresh snapshot; retries of an already created run use its existing snapshot. Preserve paused/enabled state through migration.
- **Series/dependent/fix/workspace/research:** update `packages/daemon/src/api/routes/series.ts`, creation/spawn/rerun paths in `packages/daemon/src/pods/pod-manager.ts`, and the CLI/Swift callers from Phase 5. A series pins its launch template at creation; child task/branch data is explicit. No child silently rereads a mutable live profile. Conflicts involving intentional new delivery settings require a new resolved launch.
- **Memory:** extend `packages/shared/src/types/memory.ts`, `packages/daemon/src/pods/memory-repository.ts`, `memory-selector.ts` and memory API/MCP consumers with repository scope. Migrate legacy profile memory to the legacy repository/setup binding, never to all repositories sharing the new profile. Keep explicit global memory global. Ambiguous/no-repository legacy memory remains visible in a restricted migration scope until mapped; do not guess or drop it.
- **History/mobile/desktop:** read stored launch labels/revisions and goal data, including archived definitions. Update `packages/mobile-web/src/lib/api.ts` and consumers, `packages/desktop/Sources/AutopodClient/Types/ScheduledJobTypes.swift`, `AutopodDesktop/Stores/ScheduledJobStore.swift`, and `AutopodUI/Views/ScheduledJobs/` editors. Mobile need not gain the entire preset editor but every existing action must use the new contract correctly.
- **Managed:** keep the existing managed protocol snapshot and grant identity as the authoritative outer envelope. Bind local reusable configuration only through reviewed profile-set mappings; preserve protocol digest validation. Report unsupported native configuration features instead of treating managed admission as a native `/pods` launch. Run the full managed regression suite.
- Update repository docs and examples, generated API/client artifacts where present, and all `profileName`/`extends`/legacy injection call sites found by a final source search. External `.pi/autopod.json` or Dispatcher consumers receive a concrete migration report; do not edit unrelated repositories or silently change enrolled grants.
- Remove the temporary snapshot-to-legacy adapter, inheritance editor/routes and new-pod dependence on old profile tables. Retain a narrow historical decoder and migration fixtures only. Stale clients receive `CONFIG_API_VERSION_UNSUPPORTED` with upgrade instructions instead of lossy compatibility behavior.

### Cutover sequence

1. Inventory legacy profiles/chains, credentials by safe reference, active/queued pods, managed attempts, schedules/watchers, images and memory. Produce a redacted manifest and deterministic conversion report against a copied database. Resolve missing identities, differing trust and repository default mappings before applying; record retired custom actions and test pipelines as warnings.
2. Rehearse conversion and restore on disposable copies with the exact candidate binaries. Verify database integrity, record counts, original snapshots and credential-reference lookup without printing values.
3. During an explicitly authorized live cutover, stop new admissions and pause scheduler/watcher dispatch, preserving prior state. Require zero nonterminal regular and managed attempts. Drain instead of killing by default; if work remains, cutover is blocked until it completes or the user explicitly handles it. Do not rewrite live attempts under a new authority model.
4. Create and verify an online backup through `cutover-backup.ts`, plus a versioned manifest and compatible encrypted secret-store backup references. Confirm database path and fingerprint. Backup/manifest must correspond to the same stopped-writer state.
5. Apply conversion transactionally; verify every legacy binding and credential mapping, and register a cutover marker/schema capability. Do not delete old source-containing images or historical raw data as part of conversion.
6. Run local health and non-mutating resolution probes with upgraded CLI/desktop. Resume only previously enabled dispatchers after mapped configurations pass. New scheduled admissions use the new resolver. Retain conversion/restore evidence.
7. After operational acceptance, archive obsolete image references and remove obsolete write paths. Actual cache deletion is a separate maintenance action.

### Rollback

Before new admissions/external effects: stop the new daemon, restore the verified matching database and secret-store state, run the previous binary, verify integrity/health, then restore saved scheduler/watcher state. Do not run the old binary against the new schema.

After new pods or external effects exist: first stop admissions and reconcile/retain their attempt, delivery and action ledgers. Never blindly restore a snapshot that would forget a push, PR, workflow dispatch or PIM request and repeat it. Prefer a forward fix; an explicit restore requires preserving those effects and adopting/reconciling them before dispatch resumes. Rehearsal tests include this refusal path.

### Success criteria

**Automated**

- [ ] `./scripts/validate.sh` passes install/lint/build/typecheck/test/audit/secret-scan for the candidate. Report environment/network failures separately rather than marking an unexecuted gate passed.
- [ ] `npx pnpm --filter @autopod/daemon test src/managed` passes with no grant widening or changed admission/delivery identity.
- [ ] Migration/caller integration fixtures cover schedule retry, watcher targets, series pinning, workspace worker template, dependent/fix pods, original/current rerun, scratch workspaces and historical reads after archive.
- [ ] Memory tests prove repo A's migrated private context is absent from repo B even when both use one profile. Referenced-repo reads do not implicitly broaden memory selection.
- [ ] `swift test --package-path packages/desktop` and the Phase 5 native build pass for the final source; mobile tests/build pass via the full pipeline.
- [ ] Search remaining legacy references and classify every hit as migration/history/test or remove it. No production creation/execution/delivery path depends on inheritance or live legacy-profile rereads.
- [ ] Restore rehearsal proves backup integrity, idempotent conversion, preserved dispatch state and refusal to forget post-cutover effects.

**Manual/provider/backend**

- [ ] Complete the Phase 2–5 real backend/provider/native UI journeys on the final candidate, with exact results and versions recorded.
- [ ] Inspect the real migration preview before any live apply. Confirm usual profiles, preserved alternate project setups, memory mappings and credential replacements.
- [ ] Demonstrate an ordinary launch, one override launch, a schedule/series child, a native Goal and a supported managed attempt through their intended terminal paths. Record validation, daemon delivery and external provider results independently.
- [ ] Publication, live cutover and deployment receive their own explicit authorization. Completing this plan or local tests does not perform them.

## Testing strategy and execution boundaries

Write behavioral tests around the resolver, migration, authority, native lifecycle and side-effect recovery; avoid tests that merely mirror object assignment. Reuse existing `createTestDb()`/fixture infrastructure and co-located Vitest suites. New modules get corresponding `.test.ts` files. Run focused suites during each phase and the full validation pipeline at the final integrated state; broaden earlier when a failing boundary warrants it.

Track acceptance as separate columns: source/unit, local integration, native desktop, provider, Docker, hosted sandbox, managed integration, live migration. Use PASS only for observed evidence, FAIL for an observed failed assertion, and BLOCKED/NOT RUN with the actual reason for unavailable execution. Provider capability availability follows that evidence, not an optimistic mockup.

Approval of this full plan authorizes local implementation of all six phases together. Automated phase checks are progression gates; manual/provider checks are collected at the relevant integration point and remain release gates. No routine request to reapprove the already agreed phase order. Implementation must stop before an unapproved live activation, paid fixture, publication or deployment, while completing independent local work.

## Performance considerations

Resolve configuration once and keep the snapshot on the pod's hot path. Revision/content-addressed caches reduce repeated hashing and tool downloads. GitHub/PIM discovery uses bounded pagination, short-lived account-scoped caches and explicit freshness metadata; failed/incomplete pages do not grant partial authority silently. Never hold a SQLite transaction while contacting a provider. Index revisions, pod/request identity, action operation keys and PIM lease keys. Bound retained logs/artifacts/native transport buffers and reclaim them with pod retention; do not let reusable presets turn temporary data into permanent storage.

## Scope exclusions

No profile inheritance, arbitrary stack of competing whole-profile presets, cross-pod goal scheduler, multi-account PIM, general privileged sidecar editor, persistent database service product or automatic deployment. No attempt to recreate every native agent feature. No changes to Dispatcher ownership or external managed protocol permissions without a separate reviewed contract. Existing ADO integration behavior is preserved through the new ownership mapping, not expanded into a new ADO access-preset product.

## References

- Agreed product decisions and approved six-phase structure: this conversation, 2026-09-13.
- Interactive mockup: `/Users/ewi/.codex/visualizations/2026/09/13/01a09a90-d354-7a23-9238-d723a991f773/new-pod.html` (illustrative data; no live operations).
- Pi discovery reference: `/Users/ewi/repos/pilot/extensions/azure-pim.ts` (read only; no external repository changes planned).
- [Claude native Goals](https://code.claude.com/docs/en/goal), [Codex app-server goal API](https://learn.chatgpt.com/docs/app-server#manage-a-thread-goal), [Codex Goals behavior](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex): inspected during this conversation. Verify installed-runtime compatibility during implementation; documentation is not runtime acceptance.
- Planning workflow: `/Users/ewi/.codex/skills/rpi/references/plan.md`.
- Coverage checklist: `.agents/skills/add-profile-field/SKILL.md`; use its layer coverage while replacing inheritance-specific UI.

## Approval boundary

The user explicitly approved the full implementation plan on 2026-09-13. Continue the authorized six-phase local implementation without another plan approval. Live effects remain governed by the boundaries above.

Planning verification: baseline HEAD unchanged; all 73 legacy top-level `Profile` fields have an explicit migration destination or retirement entry; referenced existing repository paths were checked (new files are identified as new); Markdown fence/whitespace checks passed. Runtime, provider, native UI and migration acceptance checks above are specified, not executed.
