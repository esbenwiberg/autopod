# Pod-manager rewrite: remaining roadmap, slices 19–34

Status: Slices 19–32 COMPLETE. Slices 1–32 complete; 2 milestones remain (33–34).
Date: 2026-10-18. Baseline: ecc324ca4a403d49397dd63cecb1a881e653ad06.
Branch: codex/pod-manager-workspace.

## Finite scope and count

2 remaining delivery milestones: Slice 33 through final qualification at 34.
The bounded baseline roadmap below included 16 (19–34); Slices 19–32 are complete.
The milestones define scope; their effort varies, and they do not provide a time estimate. Recent slices moved small helpers;
future milestones deliberately complete whole responsibilities and can contain
multiple independently tested implementation phases within their numbered slice.

At roadmap baseline the manager had 16,521 total lines and 73 public object members.
After Slice 32 it has 2,247 lines and the same public interface. A TypeScript
AST inventory below assigns every one of 327 non-import top-level declarations,
manager-closure declarations/statements and public members to an owning milestone.
Nested implementation blocks inherit their containing workflow; processPod has an
explicit provisioning/execution/completion split. Imports and the factory scaffold
belong to composition (33). This is a structural inventory, not a behavioral proof.

The original roadmap named workstreams without a fixed total. This roadmap replaces
that open-ended remainder. Each future detailed plan must fit one numbered outcome.
If evidence requires changing this scope/count, revise this roadmap visibly with the
reason; do not silently insert another sequence of helper slices or declare success
by moving a monolith into a different file. Independent product features, policy
corrections and unrelated bugs have their own work, outside this compatibility rewrite.

## Milestones and completion criteria

| Slice | Responsibility | Scope | Done when |
|---|---|---|---|
| 19 | Advisory execution and publication — COMPLETE | Moved both original functions; retained ownership checks, history, usage and slot behavior. | 33 public checks, 59 direct tests and final uncached qualification passed. |
| 20 | Validation workflows — COMPLETE | Move triggerValidation/revalidateSession coordination, retry/override/abort admission and update-from-base intent. Compose the validation modules already extracted. | Both validation entry points and five controls delegate; 1,192 public cases, 34 direct cases and full qualification pass. |
| 21 | Provider attempts and binding — COMPLETE | Own attempt identity, captured profiles/reasoning, target selection and attempt open/close. | Attempt/provenance tests cover original accounts and failure selection; manager holds no provider selection logic. |
| 22 | Continuation and Goal rework — COMPLETE | Own provider limit handoff, resume/continue, task feedback and native Goal rework through narrow dispatch/admission ports. | Legacy and immutable-launch continuation, rejection feedback and native Goal guards retain their effects and errors. |
| 23 | Provisioning — COMPLETE | Extract the provisioning portion of processPod, image/capability checks, materialized files, instructions/tools and sandbox session handover. | Complete provisioning returns prepared context/halted; nineteen helpers, eight constants and 140 statements preserved. 1,192 public cases, 37 direct cases and full qualification pass. |
| 24 | Agent dispatch and event consumption — COMPLETE | Own the remaining processPod execution loop, spawn/resume/recovery, consumeAgentEvents, activity and terminal-event accounting. | Complete process/stream owners preserve eleven bodies, four initializers, shared map identity and replay accounting; 1,192 public cases, 23 direct cases and full qualification pass. |
| 25 | Completion orchestration and shared transitions — COMPLETE | Compose the existing completion owners; own completion entry, transition/event helpers, termination/guidance checks and failure reporting. | Complete entry and original three owner constructors delegate through domain workflows;15 bodies, guards/reporting,1,192 public cases,37 direct cases and full qualification pass. |
| 26 | Approval and readiness — COMPLETE | Own approveSession, readiness waits/approvals, fact waivers, forced/bulk approval and approval snapshots. | Complete approval lifetime/readiness/controls retain17 bodies, shared references and decisions;1,192 public cases,25 direct cases and full qualification pass. |
| 27 | Delivery and merge polling — COMPLETE | Own manager delivery/scan/PR retry, shared queue/poller construction/startup and full inline approval/validation delivery. | Twelve bodies/four bindings and full stage recipes match; trigger size exception ends. 1,192 public cases,42 new direct cases and full frozen qualification pass. |
| 28 | Fix cycles — COMPLETE | Own complete canonical fix admission/recycling, task/binding, reply/delivery/parking lifetimes and three controls. | Twelve bodies/five initializers/export/startup recipes match;1,192 public cases,30new direct cases/five SQLite reopen cases and full frozen qualification pass. Original native alias limitation documented. |
| 29 | Operator lifecycle controls — COMPLETE | Own complete message/rejection/pause/kill lifetimes, nudge/escalation/bulk and credential/tool controls. | Ten bodies/two initializers/three receivers/shared state recipes match;1,192 public cases,33new direct cases/three SQLite reopens and full frozen qualification pass. |
| 30 | Resources, network and preview — COMPLETE | Own full cleanup/network/preview/polling/advisory lifetimes and shared state. |25bodies/13initializers/network protocol/construction recipes match;1,192 public cases,51new direct cases/four SQLite reopens and full frozen qualification pass. Original timeout/late-cleanup limits retained. |
| 31 | Workspace and recovery commands — COMPLETE | Own interactive completion, preservation/sync, promote/manual fix, artifact fences, delete/recover/kick/watchdog and host-fetch retries. | 27bodies/branch arrow/nine state bindings/full recipes match;1,192public cases,53new direct cases/six SQLite reopens and full frozen qualification pass. |
| 32 | Admission, queries and series — COMPLETE | Own session creation/derived launch, history/memory workspaces, dependent sessions, series and read/configuration projections. | All27bodies/12recipes and73public entries preserved;38new direct cases/six SQLite reopens and full frozen qualification pass.33finishes delegate size/type/construction gates. |
| 33 | Facade and dependency consolidation | Move public types to stable contracts, finish composition and narrow cross-workflow ports; remove residual implementation helpers. | Manager is composition plus delegates, at most 1,500 total lines; domain modules import no public PodManager or broad manager dependency bag. |
| 34 | Final architectural and regression qualification | Reconcile the complete inventory against delivered owners; qualify frozen source and document integration readiness. | Architecture checks, full uncached pipeline, database/recovery evidence and final clean pushed revision pass. PR/main/deploy remain separately authorized. |

## Ordering and contracts

19–20 finish the validation boundary around existing extracted components. 21–24
establish provider, continuation, preparation and execution owners. 25–28 finish
completion, approvals and delivery. 29–32 move remaining control/resource/workspace/
admission surfaces. 33 removes residual implementation and consolidates composition;
34 proves the final architecture and behavior. Owners may use explicit narrow ports
for later workflows; the entire public manager/dependency object is never a port.
Every intermediate slice must compile and pass its relevant public tests. Initialization
order, receiver binding, live versus captured dependency semantics and callback timing
are checked within each slice; cyclic imports or broken intermediate wiring cannot
be deferred to 33. Existing extracted modules remain reusable implementation units.

processPod is intentionally not moved whole: provisioning goes to 23, dispatch/stream
coordination to 24 and completion to 25. Similarly, validation and approval can be
split internally across cohesive files. New domain source files should remain below
1,000 lines; exceeding that requires an explicit responsibility/size review in that
slice's plan, never a hidden replacement for pod-manager.ts.

## Final finish line

- pod-manager.ts has at most 1,500 total lines and contains imports, construction and
  thin public delegates. Public delegate bodies are at most 10 lines. No provisioning,
  agent event loop, retry/validation policy, approval/delivery policy, timer callback or
  resource-cleanup algorithm remains there. Public types may move without changing
  consumer imports/exports. Line count supports, but does not replace, ownership review.
- Every inventory item has a delivered owner or an explicitly justified retained
  composition/projection entry. Each mutable timer/map/semaphore has one owner and a
  tested stop/cleanup path. No domain module imports PodManager or PodManagerDependencies.
- Preserve public APIs, state transitions, persisted snapshots, credential boundaries,
  error identity/timing, event and side-effect order, retry and usage accounting.
  Any discovered behavior correction requires its own explicit scope decision.
- Public characterization, owner contract tests, repository integration/reopen and
  relevant recovery/race tests pass. Full uncached validation passes with real SQLite,
  frozen install and no new skips, under the documented pinned environment.
- Final source/test hashes and the complete inventory are reconciled at a clean pushed
  revision. Summarize existing skipped infrastructure/live-provider coverage honestly.
  Slice 34 produces an integration-ready branch. It does not merge, deploy or claim
  live Docker/Azure/provider acceptance without execution evidence.

## Execution and approval

The later user goal “the rest of the slices” authorizes continuing the remaining
roadmap sequence together. Retain a concrete research/plan before implementation and
the established characterize → extract → qualify checkpoints for each numbered outcome.
These checkpoints now record progress without repetitive per-slice confirmation.
Preserve the agreed compatibility scope; ask for a decision when changing product/API/
persistence/credential policy or integration/deployment scope. The full goal remains
active until all Slice-34 finish gates pass. This continuation interpretation is also
recorded in the Slice 20 plan; earlier per-slice approval cadence is historical.

## Baseline declaration-to-milestone inventory

Generated from parsed TypeScript at the baseline above. Every row appears once.
Composition bindings are retained wiring, not claims that their underlying modules
need to be rewritten again. Lines refer to this baseline, not later relocated code.

| Kind | Name | Baseline lines | Owning slice |
|---|---|---|---|
| top | `summarizeValidationPhases` | 312–342 | 20 |
| top | `buildDetachedMcpFallbackMessage` | 344–356 | 29 |
| top | `failedValidationPhases` | 358–371 | 20 |
| top | `failedFactIds` | 373–379 | 20 |
| top-binding | `REWORK_IN_PROGRESS_PREFIX` | 381–381 | 22 |
| top | `sanitizeSecurityReworkValue` | 383–393 | 22 |
| top | `buildManualReworkReason` | 395–446 | 22 |
| top | `summarizeAgentCompletionBlocker` | 448–460 | 25 |
| top | `hasPendingFactDecision` | 462–470 | 20 |
| top | `actorLabel` | 472–476 | 26 |
| top | `legacyRespondedBy` | 478–480 | 26 |
| top | `buildValidationWaiver` | 482–496 | 26 |
| top | `formatRebaseConflictReason` | 501–505 | 27 |
| top | `resolveSpecFilePath` | 507–518 | 23 |
| top-binding | `SPEC_CONTEXT_CONTAINER_DIR` | 520–520 | 23 |
| top-binding | `POD_ARTIFACTS_CONTAINER_DIR` | 521–521 | 23 |
| top | `dataDir` | 523–525 | 23 |
| top | `safeFsSegment` | 527–529 | 23 |
| top | `materializeSpecContextFiles` | 531–553 | 23 |
| top | `ensureSeriesArtifactsDir` | 555–565 | 23 |
| top | `materializeSpecFiles` | 567–605 | 23 |
| top-binding | `APPROVAL_SNAPSHOT_EXCLUDES` | 610–621 | 26 |
| top | `renderPiHandoffFile` | 626–637 | 22 |
| top | `normalizeCommitEmail` | 642–647 | 23 |
| top | `allocateHostPort` | 651–653 | 30 |
| top-binding | `CONTAINER_APP_PORT` | 656–656 | 30 |
| top | `nativePreviewEmails` | 665–670 | 30 |
| top-binding | `AGENT_SHIM_PATH` | 673–673 | 23 |
| top-binding | `AGENT_ENV_PATH` | 674–674 | 23 |
| top-binding | `AGENT_SHIM_SCRIPT` | 687–717 | 23 |
| top | `buildAgentEnvFile` | 719–728 | 23 |
| top-binding | `SANDBOX_AGENT_HOME_DIRS` | 730–732 | 23 |
| top-binding | `SANDBOX_AGENT_HOME_FILES` | 734–734 | 23 |
| top | `repairSandboxAgentHomeOwnership` | 736–772 | 23 |
| top | `buildPrFixTask` | 784–876 | 28 |
| top | `buildActionableFailureSummary` | 886–926 | 28 |
| top-binding | `REVIEW_FEEDBACK_REPLY_MAX_CHARS` | 928–928 | 28 |
| top-binding | `SECURITY_SCAN_FINDING_LOG_LIMIT` | 929–929 | 25 |
| top | `formatReviewFeedbackReply` | 931–940 | 28 |
| top-binding | `PREVIEW_AUTO_STOP_MS` | 943–943 | 30 |
| top-binding | `execFileAsync` | 945–945 | 33 |
| top-binding | `MCP_INIT_PROBE_SCRIPT` | 952–977 | 23 |
| top | `loadCodeReviewSkill` | 980–996 | 20 |
| top | `captureDeployBaselineHashes` | 1008–1066 | 23 |
| top | `parseValidationOverrideResponse` | 1075–1122 | 26 |
| top | `warnIfSinglePrSeriesMissingSeriesMeta` | 1131–1143 | 32 |
| top | `resolvePrBaseBranch` | 1145–1151 | 27 |
| top | `resolvePodSpawnImage` | 1153–1179 | 23 |
| top | `isAcrQualifiedImage` | 1181–1184 | 23 |
| top | `verifySandboxWarmImageAccess` | 1186–1212 | 23 |
| top | `isSinglePrSeriesPod` | 1214–1216 | 27 |
| top | `mergeOverrides` | 1219–1227 | 32 |
| top | `ContainerManagerFactory` | 1229–1231 | 33 |
| top | `NetworkManager` | 1233–1247 | 33 |
| top | `PodManagerDependencies` | 1249–1374 | 33 |
| top | `PodCreator` | 1377–1380 | 33 |
| top | `AgentRunOutcome` | 1382–1382 | 24 |
| top | `ApproveSessionOptions` | 1384–1389 | 26 |
| top | `ApproveAllSkippedPod` | 1391–1395 | 26 |
| top | `PodManager` | 1397–1673 | 33 |
| top | `deriveAgentAttempt` | 1684–1694 | 24 |
| top | `agentPhaseBucketKey` | 1696–1698 | 24 |
| top | `hasLatestPersistedAgentTerminalEventComplete` | 1700–1719 | 24 |
| top | `agentCompleteEventKey` | 1721–1735 | 24 |
| top | `persistedAgentCompleteEventKeys` | 1737–1751 | 24 |
| top | `hasAlreadyCountedCompleteEvent` | 1753–1768 | 24 |
| top | `podMemoryScopeIds` | 1770–1772 | 32 |
| top | `approvedMemoriesForPod` | 1774–1780 | 32 |
| top | `getPodValidationSuite` | 1782–1784 | 20 |
| top | `isPodValidationDisabled` | 1786–1790 | 20 |
| top | `getPodValidationSkipPhases` | 1792–1794 | 20 |
| top | `selectMemoryBriefingForPod` | 1796–1848 | 32 |
| binding | `captured manager collaborators (destructuring)` | 1851–1880 | 33 |
| closure | `executionForPod` | 1881–1892 | 32 |
| closure | `executionCredentialsFor` | 1893–1904 | 32 |
| binding | `{ validationEnvironmentForPod }` | 1906–1909 | 33 |
| closure | `injectionsForPod` | 1911–1915 | 32 |
| binding | `prManagerFactory` | 1916–1919 | 27 |
| binding | `hostFetchRetryTimers` | 1920–1920 | 31 |
| closure | `scheduleHostFetchRetry` | 1922–1970 | 31 |
| closure | `providerForAttempt` | 1971–1985 | 21 |
| closure | `redactedProfileSnapshot` | 1987–2035 | 21 |
| closure | `profileReferenceForAttempt` | 2037–2043 | 21 |
| closure | `nativeSessionId` | 2045–2050 | 21 |
| closure | `reasoningEffortFromSnapshot` | 2052–2063 | 21 |
| closure | `resolvedReasoningEffort` | 2065–2070 | 21 |
| closure | `ensureProviderAttempt` | 2072–2134 | 21 |
| closure | `rotateProviderAttemptForFreshSegment` | 2136–2180 | 21 |
| closure | `closeProviderAttempt` | 2182–2206 | 21 |
| closure | `assertExecutionTerminationVerified` | 2208–2211 | 25 |
| closure | `assertGuidanceCollected` | 2213–2220 | 25 |
| closure | `appendDecisionContext` | 2222–2230 | 22 |
| closure | `buildRecoveryTask` | 2232–2234 | 22 |
| closure | `buildContinuationPrompt` | 2236–2238 | 22 |
| closure | `buildReworkTask` | 2240–2242 | 22 |
| closure | `hasDurableAgentExecutionEvidence` | 2244–2267 | 31 |
| closure | `sandboxInfrastructureFailure` | 2269–2291 | 31 |
| closure | `tryRecoverTransientSandboxFailure` | 2293–2435 | 31 |
| closure | `isCompatibleTarget` | 2437–2464 | 21 |
| closure-statement | `ProviderFailoverSelection` | 2466–2481 | 21 |
| closure | `selectProviderFailoverTarget` | 2483–2531 | 21 |
| closure | `escapeProviderTargetDiagnosticValue` | 2533–2540 | 21 |
| closure | `describeProviderFailoverTarget` | 2542–2550 | 21 |
| closure | `providerFailoverUnavailableActivity` | 2552–2575 | 21 |
| closure | `profileForProviderTarget` | 2577–2607 | 21 |
| closure | `resolveEffectiveBoundProfile` | 2609–2708 | 21 |
| closure | `openProviderTargetAttempt` | 2710–2743 | 21 |
| closure | `visibleProviderHandoffActivity` | 2745–2761 | 22 |
| closure | `prepareProviderContinuationHandoff` | 2763–2777 | 22 |
| closure | `queueProviderContinuation` | 2779–2839 | 22 |
| closure | `handleProviderLimit` | 2841–2906 | 22 |
| closure | `resolveGitCredential` | 2908–2925 | 32 |
| closure | `assertSandboxAgentStreamingExecSupported` | 2927–2945 | 23 |
| closure | `recordContinuationProvenance` | 2947–2957 | 22 |
| closure | `beginGoalTaskRework` | 2959–2983 | 22 |
| closure | `taskFeedbackEvents` | 2985–3010 | 22 |
| binding | `{ primeRuntimeForResume }` | 3012–3019 | 33 |
| closure | `syncSandboxRuntimeSessionState` | 3021–3074 | 23 |
| closure | `syncSandboxSeriesHandover` | 3076–3105 | 23 |
| binding | `mergeQueue` | 3119–3119 | 27 |
| binding | `haproxyDenyHandles` | 3125–3125 | 30 |
| binding | `maxCredentialLineageByPod` | 3126–3126 | 21 |
| binding | `readinessService` | 3127–3136 | 26 |
| closure | `refreshReadiness` | 3138–3166 | 26 |
| closure-statement | `ApprovalReadiness` | 3168–3174 | 26 |
| closure | `resolveApprovalReadiness` | 3176–3208 | 26 |
| closure | `normalizeApprovalReason` | 3210–3213 | 26 |
| closure | `readinessSkipReason` | 3215–3219 | 26 |
| closure | `assertApprovalAllowed` | 3221–3238 | 26 |
| closure | `persistReadinessApproval` | 3240–3275 | 26 |
| closure | `rememberMaxCredentialLineage` | 3277–3283 | 21 |
| closure | `forgetMaxCredentialLineage` | 3285–3287 | 21 |
| closure | `startHaproxyDenyReceiver` | 3292–3316 | 30 |
| closure | `stopHaproxyDenyReceiver` | 3319–3328 | 30 |
| closure | `destroyPodNetwork` | 3334–3342 | 30 |
| binding | `CONTAINER_CLEANUP_TIMEOUT_MS` | 3348–3348 | 30 |
| closure | `cleanupContainer` | 3360–3447 | 30 |
| closure | `runPushCheckpointScan` | 3458–3500 | 27 |
| closure | `getLatestPushFindings` | 3505–3516 | 27 |
| binding | `sandboxPreviewProxies` | 3518–3521 | 30 |
| binding | `nativePreviewPorts` | 3523–3523 | 30 |
| closure | `tryNativeSandboxPreview` | 3531–3563 | 30 |
| closure | `ensureSandboxPreviewProxy` | 3565–3623 | 30 |
| closure | `stopSandboxPreviewProxy` | 3625–3640 | 30 |
| closure | `parsePreviewPort` | 3642–3650 | 30 |
| closure | `killSidecarsForPod` | 3656–3695 | 30 |
| closure | `cleanupTestRunBranches` | 3702–3754 | 30 |
| binding | `previewTimers` | 3757–3757 | 30 |
| binding | `commitPolling` | 3760–3762 | 30 |
| binding | `COMMIT_POLL_INTERVAL_MS` | 3764–3764 | 30 |
| binding | `mergePolling` | 3766–3768 | 27 |
| binding | `DEFAULT_MERGE_POLL_INTERVAL_MS` | 3770–3770 | 27 |
| binding | `validationAbortControllers` | 3773–3773 | 20 |
| binding | `attemptExtensionRuns` | 3775–3775 | 20 |
| binding | `infrastructureResumeRuns` | 3776–3776 | 31 |
| binding | `artifactResumeRuns` | 3777–3777 | 31 |
| binding | `artifactCompletionRuns` | 3778–3778 | 31 |
| binding | `coordinateInteractiveCompletion` | 3779–3780 | 31 |
| binding | `pauseIntents` | 3781–3781 | 29 |
| binding | `activeAgentRuns` | 3782–3791 | 24 |
| binding | `activeAgentRunResolvers` | 3792–3792 | 24 |
| binding | `PAUSE_QUIESCENCE_TIMEOUT_MS` | 3793–3793 | 29 |
| closure | `ownsLifecycle` | 3796–3802 | 25 |
| binding | `advisoryRuns` | 3807–3807 | 30 |
| binding | `ADVISORY_QA_MAX_CONCURRENCY` | 3812–3812 | 30 |
| binding | `advisoryQaActive` | 3813–3813 | 30 |
| binding | `advisoryQaWaiters` | 3814–3814 | 30 |
| closure | `acquireAdvisoryQaSlot` | 3816–3822 | 30 |
| closure | `releaseAdvisoryQaSlot` | 3824–3831 | 30 |
| closure | `cleanupContainerAfterAdvisorySettles` | 3833–3855 | 30 |
| binding | `pendingUpdateFromBaseIntents` | 3859–3859 | 20 |
| binding | `forceWithLeaseAllowances` | 3863–3863 | 31 |
| binding | `lastEventWriteAt` | 3872–3872 | 24 |
| binding | `EVENT_TIMESTAMP_WRITE_THROTTLE_MS` | 3873–3873 | 24 |
| closure | `bumpActivityTimestamp` | 3881–3891 | 24 |
| binding | `stuckPodWatchdog` | 3894–3894 | 31 |
| binding | `unsubscribeWakeRecovery` | 3896–3896 | 31 |
| binding | `resolveBranchSource` | 3910–3954 | 31 |
| binding | `isFixCycleTerminal` | 3963–3964 | 28 |
| binding | `isFixPodRecyclable` | 3973–3974 | 28 |
| binding | `FIX_DELIVERY_FAILED_PREFIX` | 3976–3976 | 28 |
| closure | `providerBindingForFixPod` | 3978–3999 | 28 |
| closure | `parkFixPodDeliveryFailure` | 4001–4016 | 28 |
| closure | `isParkedHostPushRecovery` | 4018–4024 | 28 |
| closure | `isRetryableFixDeliveryFailure` | 4026–4033 | 28 |
| binding | `maybeSpawnFixSession` | 4050–4298 | 28 |
| closure | `postFixPodReviewFeedbackReplies` | 4300–4352 | 28 |
| closure | `completeFixPodAfterPush` | 4366–4475 | 28 |
| closure | `runUpdateFromBaseAfterAbort` | 4483–4525 | 20 |
| closure | `startMergePolling` | 4528–4759 | 27 |
| closure | `stopMergePolling` | 4762–4764 | 27 |
| closure | `resumeMergePolling` | 4767–4773 | 27 |
| closure-statement | `resumeMergePolling();` | 4776–4776 | 27 |
| closure | `startCommitPolling` | 4779–4862 | 30 |
| closure | `stopCommitPolling` | 4865–4867 | 30 |
| closure | `clearPreviewTimer` | 4870–4876 | 30 |
| closure | `schedulePreviewAutoStop` | 4879–4899 | 30 |
| binding | `{ getResumeEnv, persistRuntimeCredentialsForPod }` | 4901–4912 | 33 |
| binding | `{ buildReviewerExecEnv, getEffectiveReviewerConfig, getReviewerExecutor }` | 4914–4924 | 33 |
| closure | `touchHeartbeat` | 4926–4932 | 24 |
| binding | `{ syncWorkspaceBack, recoverWorktreeFromContainer }` | 4934–4934 | 33 |
| binding | `{ prepareWorkspaceForValidation }` | 4936–4939 | 33 |
| binding | `{ preservePodWorkspace, checkpointSandboxWorkspaceForPod }` | 4941–4948 | 33 |
| binding | `{ holdCompletionForHumanWork }` | 4950–4958 | 33 |
| binding | `{ prepareSourceForCompletion }` | 4960–4975 | 33 |
| binding | `{ applyCompletionDecision }` | 4977–4989 | 33 |
| binding | `{ startValidationAttempt }` | 4991–4999 | 33 |
| binding | `{ prepareValidationInputs }` | 5001–5016 | 33 |
| binding | `{ buildPhaseEventCallbacks, ownedValidationCallbacks }` | 5018–5020 | 33 |
| binding | `{ recordValidationProvenance, withReviewerLaunchPreflight }` | 5022–5026 | 33 |
| binding | `{ validateWithInfrastructureRetries }` | 5028–5043 | 33 |
| binding | `{ collectValidationEvidence }` | 5045–5054 | 33 |
| binding | `{ publishValidationResult }` | 5056–5060 | 33 |
| binding | `{ parkOnRetryAdmission, parkOnValidationInfrastructureFailure, parkOnReviewInfrastructureFailure, }` | 5062–5073 | 33 |
| closure | `preserveSandboxAfterAgentFailure` | 5075–5091 | 31 |
| closure | `installGhBinary` | 5095–5121 | 23 |
| closure | `installAzViaPip` | 5126–5151 | 23 |
| closure | `emitActivityStatus` | 5153–5164 | 25 |
| closure | `formatElapsedDuration` | 5166–5168 | 25 |
| closure | `emitActivityError` | 5170–5179 | 25 |
| closure | `emitBlockingSecurityScanFindings` | 5181–5208 | 25 |
| closure | `sanitizeSecurityScanLogValue` | 5210–5217 | 25 |
| closure-statement | `OperatorFailurePhase` | 5219–5219 | 25 |
| closure | `sanitizeFailureReason` | 5221–5228 | 25 |
| closure | `operatorErrorMessage` | 5230–5238 | 25 |
| closure | `describeSyncFailure` | 5240–5245 | 25 |
| closure | `tryRecoverAfterWorkspaceSyncFailure` | 5247–5280 | 31 |
| closure | `protectedOperationalPathReason` | 5282–5294 | 20 |
| closure | `podExplicitlyScopesOperationalPaths` | 5296–5320 | 20 |
| closure | `assertProtectedOperationalPathsInScope` | 5322–5330 | 20 |
| closure | `taskSummaryWithApprovedFactWaiver` | 5332–5361 | 26 |
| closure | `advisoryPublicationOwnership` | 5363–5391 | 19 |
| closure | `runAdvisoryAfterValidation` | 5393–5529 | 19 |
| closure | `parkOnCredentialFailure` | 5544–5576 | 27 |
| closure | `handleDeletionGuardError` | 5578–5597 | 31 |
| closure | `ownsArtifactCompletion` | 5599–5613 | 31 |
| closure | `failInteractivePreservation` | 5615–5622 | 31 |
| closure | `assertApprovalCurrent` | 5624–5655 | 26 |
| closure | `failBranchPreservation` | 5657–5664 | 31 |
| closure | `assertInteractiveCompletionCurrent` | 5666–5695 | 31 |
| binding | `{ preserveArtifacts, finalizeArtifactPod }` | 5697–5710 | 33 |
| closure | `parkOnWorktreeSyncFailure` | 5712–5726 | 31 |
| closure | `ensurePrBaseBranchOnOrigin` | 5728–5766 | 27 |
| closure | `pushAndCreatePr` | 5774–5887 | 27 |
| closure | `transition` | 5889–5921 | 25 |
| closure | `applySkipValidationDecision` | 5923–5949 | 20 |
| closure | `emitPodCompletedEvent` | 5951–5969 | 25 |
| closure | `makeUnexpectedValidationFailureResult` | 5971–5998 | 20 |
| closure | `claimValidation` | 6000–6019 | 20 |
| closure | `recordNotReportedMemoryUsage` | 6021–6023 | 24 |
| closure | `maybeTriggerDependents` | 6034–6142 | 32 |
| method | `getLaunchConfiguration` | 6145–6147 | 32 |
| method | `createResolvedSession` | 6148–6229 | 32 |
| method | `createSession` | 6230–6613 | 32 |
| method | `createHistoryWorkspace` | 6615–6634 | 32 |
| method | `createMemoryWorkspace` | 6636–6669 | 32 |
| method | `resumeNativeGoal` | 6671–6722 | 22 |
| method | `processPod` | 6723–9583 | 24; provisioning 23 / completion 25 |
| method | `consumeAgentEvents` | 9585–10229 | 24 |
| method | `handleCompletion` | 10231–10278 | 25 |
| method | `sendMessage` | 10280–10767 | 29 |
| method | `approveSession` | 10769–11562 | 26 |
| method | `rejectSession` | 11564–11661 | 29 |
| method | `pauseSession` | 11663–11736 | 29 |
| method | `nudgeSession` | 11738–11751 | 29 |
| method | `killSession` | 11753–11895 | 29 |
| method | `promoteToAuto` | 11907–12050 | 31 |
| method | `completeSession` | 12052–12274 | 31 |
| method | `syncWorkspaceBranch` | 12276–12391 | 31 |
| method | `preserveWorkspace` | 12393–12395 | 31 |
| method | `quiesceSandboxAgent` | 12397–12426 | 31 |
| method | `suspendSandboxForRecovery` | 12428–12433 | 31 |
| method | `cleanupPodResourcesForRecovery` | 12435–12438 | 31 |
| method | `assertCanRework` | 12440–12467 | 22 |
| method | `triggerValidation` | 12469–13571 | 20 |
| method | `revalidateSession` | 13573–14127 | 20 |
| method | `fixManually` | 14129–14218 | 31 |
| method | `notifyEscalation` | 14220–14228 | 29 |
| method | `touchHeartbeat` | 14230–14230 | 24 |
| method | `getReviewerConfig` | 14231–14236 | 33 |
| method | `getReviewerExecEnv` | 14237–14239 | 33 |
| method | `getReviewerExecutor` | 14240–14240 | 33 |
| method | `getProjectMemoryScope` | 14241–14243 | 32 |
| method | `getLaunchMemoryContext` | 14244–14265 | 32 |
| method | `deleteSession` | 14267–14359 | 31 |
| method | `startPreview` | 14361–14495 | 30 |
| method | `stopPreview` | 14497–14514 | 30 |
| method | `previewStatus` | 14516–14629 | 30 |
| method | `getSession` | 14631–14633 | 32 |
| method | `refreshReadinessAfterQualityScore` | 14635–14637 | 26 |
| method | `getValidationEnvironment` | 14639–14642 | 33 |
| method | `getDeploymentConfiguration` | 14644–14656 | 32 |
| method | `getInjectedMcpServer` | 14658–14673 | 32 |
| method | `getInjectedMcpServers` | 14675–14679 | 32 |
| method | `listSessions` | 14681–14683 | 32 |
| method | `getSessionStats` | 14685–14687 | 32 |
| method | `getSeriesPods` | 14689–14691 | 32 |
| method | `rehydrateDependentSessions` | 14693–14758 | 32 |
| method | `deleteSeriesWithCascade` | 14760–14776 | 32 |
| method | `getValidationHistory` | 14778–14782 | 32 |
| method | `approveAllValidated` | 14784–14806 | 26 |
| method | `killAllFailed` | 14808–14820 | 29 |
| method | `extendAttempts` | 14822–14866 | 20 |
| method | `applyOverridesInstant` | 14868–14913 | 20 |
| method | `approveFactWaiver` | 14915–14989 | 26 |
| method | `forceApprove` | 14991–15044 | 26 |
| method | `extendPrAttempts` | 15046–15092 | 28 |
| method | `interruptValidation` | 15094–15096 | 20 |
| method | `updateFromBase` | 15098–15177 | 20 |
| method | `setSkipValidation` | 15179–15235 | 20 |
| method | `refreshNetworkPolicy` | 15237–15348 | 30 |
| method | `injectCredential` | 15350–15356 | 29 |
| method | `installCliTool` | 15358–15386 | 29 |
| method | `spawnFixSession` | 15394–15449 | 28 |
| method | `requestFixSession` | 15451–15492 | 28 |
| method | `retryCreatePr` | 15494–15518 | 27 |
| method | `getArtifactResumeObservation` | 15520–15542 | 31 |
| method | `resumePod` | 15544–15820 | 22 |
| method | `continueProvider` | 15822–16061 | 22 |
| method | `forceComplete` | 16063–16111 | 31 |
| method | `kickPod` | 16113–16176 | 31 |
| method | `startStuckPodWatchdog` | 16178–16313 | 31 |
| method | `stopStuckPodWatchdog` | 16315–16324 | 31 |
| method | `recoverWorktree` | 16326–16439 | 31 |
| top | `hostnameFromUrl` | 16443–16449 | 30 |
| top | `portFromUrl` | 16451–16459 | 30 |
| top | `buildCodeIntelligenceServers` | 16466–16521 | 23 |

## Slice 19 completion record

The two functions moved unchanged to advisory-validation.ts. Public characterization
passes before/after (33 checks), direct contracts pass (59 including three file SQLite
reopen cases), 95 affected suites pass (3,368 checks, no skips), and the full uncached
pipeline passes (8,539 Vitest checks, 35 script checks, ten existing gated skips).
Exact movement and frozen-source checks pass. See the completed Slice 19 plan for
qualification revision, limits and evidence. Next: prepare Slice 20's validation
workflow plan. The baseline declaration inventory remains anchored to ecc324ca; the
two advisory declarations are now delivered, with composition retained in manager.

## Slice 20 completion and remaining size review

Validation trigger/revalidation, five controls, shared abort/recovery state and policy
helpers have explicit owners. All 22 original bodies/parameter lists and full recipes
match; the manager is 14,371 lines. Qualification passes: 1,192 full manager cases
before/after, 34 direct cases with two private SQLite reopen cases, 97 affected suites
(3,406 cases), full uncached 8,577 Vitest cases plus 35 script checks, ten existing skips.

The trigger owner is temporarily 1,273 lines to preserve original await/fence timing.
Slice 27 must extract its inline PR-delivery policy from trigger and revalidation and
review its size before final architecture qualification. This is recorded scope for
that numbered milestone, not an additional slice. Other new Slice-20 owners are below
1,000 lines. Next: Slice 21, provider attempts and binding.

## Slice 21 completion

Provider identity/redaction/reasoning and attempt/failover/binding algorithms have
explicit policy/context owners. Nineteen original bodies/parameters, selection type,
map constructor and full recipes match; the manager is 13,833 lines (538 fewer).
Qualification: 1,192 unchanged public cases, 44 direct cases with three private
encrypted SQLite reopen cases, 99 affected suites/3,450 cases, full uncached 8,621
Vitest cases plus 35 script checks; same ten existing skips. Both new owners are
below 1,000 lines (91/552). Next: Slice 22, continuation and Goal rework. The Slice-27
validation-trigger delivery/size review remains required.

## Slice 22 completion

Prompt policy, decision/rework context, provider handoff/continuation and native Goal/
resume controls have explicit owners. All eighteen bodies/parameters, constant and
complete recipes match. Manager: 12,995 lines (838 fewer); new owners below 500 lines.
Qualification: 1,192 unchanged public cases; 50 direct cases including three private
SQLite file reopen cases; 107 affected suites/3,551 cases; full uncached 8,671
Vitest cases plus 35 script checks, same ten inherited skips. Next: Slice 23 provisioning.
Shared recovery-map construction remains assigned 31, active-run ownership 24 and
validation-trigger delivery/size review 27. The complete goal remains active.

## Slice 23 qualification checkpoint (2026-10-19)

Complete provisioning extraction: implementation 38d70d53bf437e7920e92569a39143ddeae21c13.
Manager 12,995 → 10,296 lines; twelve new owners below 1,000 lines. All thirteen file
recipes, nineteen helper bodies, eight initializers and 140 statements match the
allowed extraction. Frozen 1,192 public cases and 37 direct cases pass; three actual
private SQLite reopen cases and private Git/filesystem cases are included. Expanded
137-suite run: 3,991 pass/three existing gated skips. Full frozen uncached pipeline:
8,708 Vitest pass, same ten gated skips, 523 passing files and 35 Node script tests.
2,026 package/script hashes and six root controls verified. Repository build/typecheck
passes; seven original supplemental source diagnostics remain unchanged. No live
provider/container/cloud acceptance or integration/deployment. Next incomplete: 24;
eleven milestones remain through 34. Detailed proof is in the Slice 23 plan and
.autopod-data/provisioning/proof.json. Goal remains active.

## Slice 24 qualification checkpoint (2026-10-19)

Complete process/event consumption and active-run/liveness ownership extraction:
implementation2e4ef206. Manager10,296 →8,812 lines; six new owners below1,000 lines.
Eleven complete bodies, four initializers, outcome union and all seven file recipes
match the allowed extraction. Public1,192 assertions unchanged;23 new direct cases
and three actual private-file SQLite reopen cases pass. Expanded169-suite run:
4,380 pass/four existing gated skips. Full frozen uncached pipeline:8,731 Vitest pass,
same ten full gated skips,528 passing files and35 Node script tests. Frozen2,038
package/script hashes and six root controls match. Build/typecheck passes; two moved
source diagnostics match original manager exactly. No live provider/container/cloud
acceptance or integration/deployment. Next incomplete:25; ten milestones remain.
Detailed evidence: Slice24 plan and .autopod-data/agent-execution/proof.json. Goal active.

## Slice25 qualification checkpoint (2026-10-19)

Complete completion/transition/guard/reporting boundary:implementation76ae75e1.
Manager8,812 →8,591 lines; five new owners30–144 lines. Fifteen complete bodies,
one constant/type union, three original owner constructors and seven full file recipes
preserve the allowed extraction. Frozen1,192 public assertions match;37 direct cases
and three actual private-file SQLite reopen cases pass. Expanded180-suite run:
4,442 pass/four existing gated skips. Full frozen uncached pipeline:8,768 Vitest pass,
same ten gated skips,533 passing files and35 Node script tests. Frozen2,049 package/
script hashes and six root controls match. New source/test semantics are clean;
repository build/typecheck passes. No live provider/container/cloud acceptance or
integration/deployment. Next incomplete:26; nine milestones remain through34. Detailed
proof:Slice25 plan and .autopod-data/completion-orchestration/proof.json. Goal active.

## Slice26 qualification checkpoint (2026-10-19)

Whole approval/readiness/waiver/snapshot extraction:implementation8a08d5a4.
Manager8,591 →7,399 lines; five owners135–835 lines. Seventeen complete bodies, three
types, both original initializers/readiness construction and six full recipes match.
Public1,192 assertions unchanged;25 direct cases, four real SQLite file-reopen cases
and a real private snapshot/receipt case pass. Expanded196-suite run:4,683 pass/four
inherited gates. Full frozen uncached pipeline:8,793 Vitest pass, same ten full gates,
538 passing files and35 Node script tests. Frozen2,060 package/script hashes and six
root controls match. Build/typecheck passes; six moved source diagnostics are unchanged
from baseline and all new test/fixture semantics are clean. No live external acceptance
or integration/deployment. Next incomplete:27; eight milestones remain. Delivery27
explicitly includes approval/validation inline delivery and the trigger size review.
Evidence:Slice26 plan and .autopod-data/approval-readiness/proof.json. Goal remains active.

## Slice31 qualification checkpoint (2026-10-19)

Complete workspace/recovery/completion/promotion/manual-fix/deletion/watchdog ownership:
implementation33a5fc9c. Manager4,447→3,096lines; sixteen new source owners30–265lines.
All27complete bodies/defaults, complete branch-source arrow, eight exact initializers,
equivalent coordinator runtime/result protocol, exact PodCreator and17full recipes
match. Same73public members/fifteen thin delegates/three dynamic receivers and original
per-instance state/construction/startup. Public1,192assertions unchanged;53new direct
cases/fifteen suites,573total direct cases/72suites and six actual SQLite reopens.
Real local Git commitFiles preserves unrelated staged code; remote effects controlled.
Expanded272-suite run:5,229pass/four inherited gates. Full frozen uncached pipeline:
9,002Vitest pass/587passing files plus35Node script cases; same ten full gated cases.
Frozen2,169package/script hashes and six root controls match. Pinned22.23.3/9.15.4/
SQLite3.49.2, frozen install without fallback, all Turbo groups uncached. Build/
declarations/typecheck pass;21supplemental source diagnostics are inherited and
sixteen new test/fixture files have zero. Existing82lint warnings/input-size allowance
retained. No live provider/container/cloud acceptance or PR/main/deployment. Original
timeout/late-operation/native-fix-alias limits persist. Evidence:Slice31plan and
.autopod-data/workspace-recovery/proof.json. Three milestones32–34remain; goal ACTIVE.
Complete current-source32research saved in2026-10-19-pod-manager-admission-queries.md.

## Slice32 qualification checkpoint (2026-10-19)

Complete admission/query/memory-analysis/dependent-series responsibility:
implementation2bbc454a. Manager3,096→2,247lines; eleven new source files25–420lines.
All27whole bodies/runtime/defaults, seven explicit contextual annotations/sixteen
declared public-owner protocols and12fullrecipes pass. Same73members/order with
17thin delegates/four dynamic receivers; original construction/startup statements
and effect-free new constructors preserve service identity/timing. Public1,192
assertions unchanged;38new direct cases/ten suites and680total direct/91suites pass.
Six actual private-file SQLite reopens cover metadata/commit/rollback/frozen native
configuration after preset edits/dependent healing and authenticated rerun receipts.
Expanded304-suite run:5,450pass/four identical inherited gates. Full frozen uncached
pipeline:9,040Vitest pass/597passing files plus35Node cases; same ten full gated cases.
Frozen2,191package/script hashes and six roots match. Node22.23.3/pnpm9.15.4/SQLite3.49.2,
frozen install without fallback and all Turbo groups uncached. All18changed-source
supplemental diagnostics match18original baseline; eleven new test/fixture files have
zero diagnostics. Existing82rootlint warnings/input allowance retained. No live external
acceptance/PR/main/deployment. Existing policy/alias/reviewer/interface limitations
remain. Evidence:Slice32plan and .autopod-data/admission-queries/proof.json. Two milestones
33–34remain; goal ACTIVE.33research records109construction statements/73members,13line
trigger delegate and two remaining broad domain manager type consumers. Required final
size/type/owner inventory gates remain outstanding rather than waived.
