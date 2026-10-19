# Pod manager rewrite — final qualification

**PROVEN. All 34 slices are complete within the approved local compatibility scope.**

Qualified implementation: `234a3da83b0d54913d88a299a71b63e189e5d33b` on `codex/pod-manager-workspace`.
Slice 34 adds seven state-lifetime assertions in one suite. Every one of the 2,199
predecessor package/script files remains byte-identical to Slice 33. Product source
therefore remains `0501aa6826dc80d0a42e74a866f233cd3de76e8b`; no API, schema or policy change
was introduced by final qualification.

| Claim | Evidence from the final tree | Result |
|---|---|---|
| Every original unit has an owner | 327 rows below; 319 exact body/initializer/type matches, eight explicit partition/composition proofs | Proven |
| Every public entry remains accounted for | 73 runtime entries, 72 unchanged declared protocols; 1,192 unchanged public cases | Proven |
| Mutable state has explicit ownership and cleanup | 26 bindings below; 80 executed cleanup cases | Proven for stated local contracts |
| Manager is composition and thin delegation | 1,421 lines, public bodies at most 10 lines; 109 original construction statements and 43 references preserved | Proven |
| No residual algorithms, broad domain manager dependencies or new runtime cycle | Final AST, original recipes, protocol checks and runtime import graph | Proven |
| Final frozen regression | 920 direct tests / 108 suites; 9,060 full Vitest tests / 601 passing files; 35 Node tests | Passed |

## What was checked

The original inventory is anchored to the actual 16,521-line manager at
`ecc324ca4a403d49397dd63cecb1a881e653ad06`. Each row is checked against the final
source, rather than inferred from current facade delegates. Actual runtime import
paths reach the modules containing 318 inventory rows. Nine further declaration rows
use type-only paths. Every value owner has a runtime import path.
Every public entry also maps to its original inventory row.

The eight special rows cover the captured destructuring, merge-polling startup,
`processPod`, `approveSession`, both validation entry workflows and the two original
public shorthand references. The process proof covers all 140 contiguous provisioning
statements plus the entire remainder/catch/finally. Approval covers all 44 original
statements across preparation, execution and remainder. Both validation workflows
preserve their full original bodies through the first extraction, then prove exhaustive
pass-branch partitions and unchanged remainder. Thirty-one complete final source
recipes additionally check stage wiring, captured/live ports, imports and projections.
The final facade check preserves defaults, async/promise/error timing, lazy receivers,
original shorthand identity and construction order.

Full qualification ran `./scripts/validate.sh` with `TURBO_FORCE=true` and
`SKIP_DB_TESTS=0` under Node 22.23.3, pnpm 9.15.4 and native SQLite 3.49.2.
Frozen installation succeeded without fallback. Build, declarations, typecheck, lint,
tests, dependency audit and secret scan passed. All Turbo groups were uncached
(7 build, 11 typecheck, 15 test tasks). All 2,200 package/script hashes and six root
controls match the final frozen tree. The original public test bytes and all 1,192
case names/statuses match. Relevant owner suites include actual private SQLite
close/reopen, integrity/foreign-key checks, recovery races, local HTTP proxy shutdown,
queue serialization and native/legacy frozen admission. External adapters remain controlled.

The new suite exercises actual composed trigger and revalidation workflows with a
controlled validation-execution boundary. Successful and superseded settlement releases
the current controller; replacement controllers remain owned and un-aborted. A failed
accepted extension clears its deferred coalescing state. The new suite has zero
supplemental TypeScript semantic diagnostics. Original source semantic debt is unchanged.

## Limits retained

There are still ten inherited infrastructure/live test gates and 82 existing lint
warnings. The inherited task-local lint input allowance is 2 MiB; no lint rule or
repository control was relaxed. No live Docker/Azure/paid-provider execution, PR/main
integration, deployment or external message is implied by this local proof.

Polling stop clears registrations and timers without aborting an already running remote
operation. Watchdog stop unsubscribes and clears the interval without draining dispatched
work. Host-fetch retries release on replacement/fire without a new cancel-all operation.
Deletion retains one 25-second deadline and its original late-operation limits.
Coalescing is in-process. Native fix alias policy and the stale memory reviewer protocol
remain the established compatibility scope. The public interface historically omits
`deleteSeriesWithCascade`, so 72 declared protocols and 73 runtime entries remain intact.

## Complete original inventory

Paths in this table are relative to `packages/daemon/src/pods/`. Original line ranges
refer to the baseline Git source above. Exact rows retain the original runtime body,
initializer or type tokens; special rows have the exhaustive proof described above.
Retained manager/facade rows are construction or small public projections, justified by
the final no-algorithm and original-reference checks.

| # | Original unit | Original lines | Planned slice | Delivered owner | Proof |
|---|---|---|---|---|---|
| 1 | `summarizeValidationPhases` | 312–342 | 20 | `validation-workflow-policy.ts` | Exact + wiring |
| 2 | `buildDetachedMcpFallbackMessage` | 344–356 | 29 | `operator-policy.ts` | Exact + wiring |
| 3 | `failedValidationPhases` | 358–371 | 20 | `validation-workflow-policy.ts` | Exact + wiring |
| 4 | `failedFactIds` | 373–379 | 20 | `validation-workflow-policy.ts` | Exact + wiring |
| 5 | `REWORK_IN_PROGRESS_PREFIX` | 381–381 | 22 | `continuation-policy.ts` | Exact + wiring |
| 6 | `sanitizeSecurityReworkValue` | 383–393 | 22 | `continuation-policy.ts` | Exact + wiring |
| 7 | `buildManualReworkReason` | 395–446 | 22 | `continuation-policy.ts` | Exact + wiring |
| 8 | `summarizeAgentCompletionBlocker` | 448–460 | 25 | `completion-diagnostics.ts` | Exact + wiring |
| 9 | `hasPendingFactDecision` | 462–470 | 20 | `validation-workflow-policy.ts` | Exact + wiring |
| 10 | `actorLabel` | 472–476 | 26 | `approval-policy.ts` | Exact + wiring |
| 11 | `legacyRespondedBy` | 478–480 | 26 | `approval-policy.ts` | Exact + wiring |
| 12 | `buildValidationWaiver` | 482–496 | 26 | `approval-policy.ts` | Exact + wiring |
| 13 | `formatRebaseConflictReason` | 501–505 | 27 | `delivery-policy.ts` | Exact + wiring |
| 14 | `resolveSpecFilePath` | 507–518 | 23 | `provisioning-materials.ts` | Exact + wiring |
| 15 | `SPEC_CONTEXT_CONTAINER_DIR` | 520–520 | 23 | `provisioning-materials.ts` | Exact + wiring |
| 16 | `POD_ARTIFACTS_CONTAINER_DIR` | 521–521 | 23 | `provisioning-materials.ts` | Exact + wiring |
| 17 | `dataDir` | 523–525 | 23 | `provisioning-materials.ts` | Exact + wiring |
| 18 | `safeFsSegment` | 527–529 | 23 | `provisioning-materials.ts` | Exact + wiring |
| 19 | `materializeSpecContextFiles` | 531–553 | 23 | `provisioning-materials.ts` | Exact + wiring |
| 20 | `ensureSeriesArtifactsDir` | 555–565 | 23 | `provisioning-materials.ts` | Exact + wiring |
| 21 | `materializeSpecFiles` | 567–605 | 23 | `provisioning-materials.ts` | Exact + wiring |
| 22 | `APPROVAL_SNAPSHOT_EXCLUDES` | 610–621 | 26 | `approval-policy.ts` | Exact + wiring |
| 23 | `renderPiHandoffFile` | 626–637 | 22 | `continuation-policy.ts` | Exact + wiring |
| 24 | `normalizeCommitEmail` | 642–647 | 23 | `provisioning-materials.ts` | Exact + wiring |
| 25 | `allocateHostPort` | 651–653 | 30 | `resource-policy.ts` | Exact + wiring |
| 26 | `CONTAINER_APP_PORT` | 656–656 | 30 | `resource-policy.ts` | Exact + wiring |
| 27 | `nativePreviewEmails` | 665–670 | 30 | `resource-policy.ts` | Exact + wiring |
| 28 | `AGENT_SHIM_PATH` | 673–673 | 23 | `provisioning-runtime-files.ts` | Exact + wiring |
| 29 | `AGENT_ENV_PATH` | 674–674 | 23 | `provisioning-runtime-files.ts` | Exact + wiring |
| 30 | `AGENT_SHIM_SCRIPT` | 687–717 | 23 | `provisioning-runtime-files.ts` | Exact + wiring |
| 31 | `buildAgentEnvFile` | 719–728 | 23 | `provisioning-runtime-files.ts` | Exact + wiring |
| 32 | `SANDBOX_AGENT_HOME_DIRS` | 730–732 | 23 | `provisioning-runtime-files.ts` | Exact + wiring |
| 33 | `SANDBOX_AGENT_HOME_FILES` | 734–734 | 23 | `provisioning-runtime-files.ts` | Exact + wiring |
| 34 | `repairSandboxAgentHomeOwnership` | 736–772 | 23 | `provisioning-runtime-files.ts` | Exact + wiring |
| 35 | `buildPrFixTask` | 784–876 | 28 | `fix-policy.ts` | Exact + wiring |
| 36 | `buildActionableFailureSummary` | 886–926 | 28 | `fix-policy.ts` | Exact + wiring |
| 37 | `REVIEW_FEEDBACK_REPLY_MAX_CHARS` | 928–928 | 28 | `fix-policy.ts` | Exact + wiring |
| 38 | `SECURITY_SCAN_FINDING_LOG_LIMIT` | 929–929 | 25 | `completion-diagnostics.ts` | Exact + wiring |
| 39 | `formatReviewFeedbackReply` | 931–940 | 28 | `fix-policy.ts` | Exact + wiring |
| 40 | `PREVIEW_AUTO_STOP_MS` | 943–943 | 30 | `resource-policy.ts` | Exact + wiring |
| 41 | `execFileAsync` | 945–945 | 33 | `pod-manager.ts` | Exact + wiring |
| 42 | `MCP_INIT_PROBE_SCRIPT` | 952–977 | 23 | `provisioning-runtime-files.ts` | Exact + wiring |
| 43 | `loadCodeReviewSkill` | 980–996 | 20 | `validation-workflow-policy.ts` | Exact + wiring |
| 44 | `captureDeployBaselineHashes` | 1008–1066 | 23 | `provisioning-materials.ts` | Exact + wiring |
| 45 | `parseValidationOverrideResponse` | 1075–1122 | 26 | `approval-policy.ts` | Exact + wiring |
| 46 | `warnIfSinglePrSeriesMissingSeriesMeta` | 1131–1143 | 32 | `admission-policy.ts` | Exact + wiring |
| 47 | `resolvePrBaseBranch` | 1145–1151 | 27 | `delivery-policy.ts` | Exact + wiring |
| 48 | `resolvePodSpawnImage` | 1153–1179 | 23 | `provisioning-image-policy.ts` | Exact + wiring |
| 49 | `isAcrQualifiedImage` | 1181–1184 | 23 | `provisioning-image-policy.ts` | Exact + wiring |
| 50 | `verifySandboxWarmImageAccess` | 1186–1212 | 23 | `provisioning-image-policy.ts` | Exact + wiring |
| 51 | `isSinglePrSeriesPod` | 1214–1216 | 27 | `delivery-policy.ts` | Exact + wiring |
| 52 | `mergeOverrides` | 1219–1227 | 32 | `admission-policy.ts` | Exact + wiring |
| 53 | `ContainerManagerFactory` | 1229–1231 | 33 | `pod-manager-contracts.ts` | Exact + wiring |
| 54 | `NetworkManager` | 1233–1247 | 33 | `resource-contracts.ts` | Exact + wiring |
| 55 | `PodManagerDependencies` | 1249–1374 | 33 | `pod-manager-contracts.ts` | Exact + wiring |
| 56 | `PodCreator` | 1377–1380 | 33 | `workspace-contracts.ts` | Exact + wiring |
| 57 | `AgentRunOutcome` | 1382–1382 | 24 | `agent-execution-contracts.ts` | Exact + wiring |
| 58 | `ApproveSessionOptions` | 1384–1389 | 26 | `approval-contracts.ts` | Exact + wiring |
| 59 | `ApproveAllSkippedPod` | 1391–1395 | 26 | `approval-contracts.ts` | Exact + wiring |
| 60 | `PodManager` | 1397–1673 | 33 | `pod-manager-contracts.ts` | Exact + wiring |
| 61 | `deriveAgentAttempt` | 1684–1694 | 24 | `agent-execution-policy.ts` | Exact + wiring |
| 62 | `agentPhaseBucketKey` | 1696–1698 | 24 | `agent-execution-policy.ts` | Exact + wiring |
| 63 | `hasLatestPersistedAgentTerminalEventComplete` | 1700–1719 | 24 | `agent-execution-policy.ts` | Exact + wiring |
| 64 | `agentCompleteEventKey` | 1721–1735 | 24 | `agent-execution-policy.ts` | Exact + wiring |
| 65 | `persistedAgentCompleteEventKeys` | 1737–1751 | 24 | `agent-execution-policy.ts` | Exact + wiring |
| 66 | `hasAlreadyCountedCompleteEvent` | 1753–1768 | 24 | `agent-execution-policy.ts` | Exact + wiring |
| 67 | `podMemoryScopeIds` | 1770–1772 | 32 | `admission-memory-briefing.ts` | Exact + wiring |
| 68 | `approvedMemoriesForPod` | 1774–1780 | 32 | `admission-memory-briefing.ts` | Exact + wiring |
| 69 | `getPodValidationSuite` | 1782–1784 | 20 | `validation-workflow-policy.ts` | Exact + wiring |
| 70 | `isPodValidationDisabled` | 1786–1790 | 20 | `validation-workflow-policy.ts` | Exact + wiring |
| 71 | `getPodValidationSkipPhases` | 1792–1794 | 20 | `validation-workflow-policy.ts` | Exact + wiring |
| 72 | `selectMemoryBriefingForPod` | 1796–1848 | 32 | `admission-memory-briefing.ts` | Exact + wiring |
| 73 | `captured manager collaborators (destructuring)` | 1851–1880 | 33 | `pod-manager.ts` | Partition / composition |
| 74 | `executionForPod` | 1881–1892 | 32 | `admission-execution-context.ts` | Exact + wiring |
| 75 | `executionCredentialsFor` | 1893–1904 | 32 | `admission-execution-context.ts` | Exact + wiring |
| 76 | `{ validationEnvironmentForPod }` | 1906–1909 | 33 | `pod-manager.ts` | Exact + wiring |
| 77 | `injectionsForPod` | 1911–1915 | 32 | `admission-execution-context.ts` | Exact + wiring |
| 78 | `prManagerFactory` | 1916–1919 | 27 | `delivery-state.ts` | Exact + wiring |
| 79 | `hostFetchRetryTimers` | 1920–1920 | 31 | `workspace-host-fetch-retry.ts` | Exact + wiring |
| 80 | `scheduleHostFetchRetry` | 1922–1970 | 31 | `workspace-host-fetch-retry.ts` | Exact + wiring |
| 81 | `providerForAttempt` | 1971–1985 | 21 | `provider-attempt-context.ts` | Exact + wiring |
| 82 | `redactedProfileSnapshot` | 1987–2035 | 21 | `provider-attempt-policy.ts` | Exact + wiring |
| 83 | `profileReferenceForAttempt` | 2037–2043 | 21 | `provider-attempt-policy.ts` | Exact + wiring |
| 84 | `nativeSessionId` | 2045–2050 | 21 | `provider-attempt-policy.ts` | Exact + wiring |
| 85 | `reasoningEffortFromSnapshot` | 2052–2063 | 21 | `provider-attempt-policy.ts` | Exact + wiring |
| 86 | `resolvedReasoningEffort` | 2065–2070 | 21 | `provider-attempt-policy.ts` | Exact + wiring |
| 87 | `ensureProviderAttempt` | 2072–2134 | 21 | `provider-attempt-context.ts` | Exact + wiring |
| 88 | `rotateProviderAttemptForFreshSegment` | 2136–2180 | 21 | `provider-attempt-context.ts` | Exact + wiring |
| 89 | `closeProviderAttempt` | 2182–2206 | 21 | `provider-attempt-context.ts` | Exact + wiring |
| 90 | `assertExecutionTerminationVerified` | 2208–2211 | 25 | `completion-guards.ts` | Exact + wiring |
| 91 | `assertGuidanceCollected` | 2213–2220 | 25 | `completion-guards.ts` | Exact + wiring |
| 92 | `appendDecisionContext` | 2222–2230 | 22 | `continuation-context.ts` | Exact + wiring |
| 93 | `buildRecoveryTask` | 2232–2234 | 22 | `continuation-context.ts` | Exact + wiring |
| 94 | `buildContinuationPrompt` | 2236–2238 | 22 | `continuation-context.ts` | Exact + wiring |
| 95 | `buildReworkTask` | 2240–2242 | 22 | `continuation-context.ts` | Exact + wiring |
| 96 | `hasDurableAgentExecutionEvidence` | 2244–2267 | 31 | `workspace-infrastructure-recovery.ts` | Exact + wiring |
| 97 | `sandboxInfrastructureFailure` | 2269–2291 | 31 | `workspace-infrastructure-recovery.ts` | Exact + wiring |
| 98 | `tryRecoverTransientSandboxFailure` | 2293–2435 | 31 | `workspace-infrastructure-recovery.ts` | Exact + wiring |
| 99 | `isCompatibleTarget` | 2437–2464 | 21 | `provider-attempt-context.ts` | Exact + wiring |
| 100 | `ProviderFailoverSelection` | 2466–2481 | 21 | `provider-attempt-context.ts` | Exact + wiring |
| 101 | `selectProviderFailoverTarget` | 2483–2531 | 21 | `provider-attempt-context.ts` | Exact + wiring |
| 102 | `escapeProviderTargetDiagnosticValue` | 2533–2540 | 21 | `provider-attempt-context.ts` | Exact + wiring |
| 103 | `describeProviderFailoverTarget` | 2542–2550 | 21 | `provider-attempt-context.ts` | Exact + wiring |
| 104 | `providerFailoverUnavailableActivity` | 2552–2575 | 21 | `provider-attempt-context.ts` | Exact + wiring |
| 105 | `profileForProviderTarget` | 2577–2607 | 21 | `provider-attempt-context.ts` | Exact + wiring |
| 106 | `resolveEffectiveBoundProfile` | 2609–2708 | 21 | `provider-attempt-context.ts` | Exact + wiring |
| 107 | `openProviderTargetAttempt` | 2710–2743 | 21 | `provider-attempt-context.ts` | Exact + wiring |
| 108 | `visibleProviderHandoffActivity` | 2745–2761 | 22 | `provider-continuation.ts` | Exact + wiring |
| 109 | `prepareProviderContinuationHandoff` | 2763–2777 | 22 | `provider-continuation.ts` | Exact + wiring |
| 110 | `queueProviderContinuation` | 2779–2839 | 22 | `provider-continuation.ts` | Exact + wiring |
| 111 | `handleProviderLimit` | 2841–2906 | 22 | `provider-continuation.ts` | Exact + wiring |
| 112 | `resolveGitCredential` | 2908–2925 | 32 | `admission-execution-context.ts` | Exact + wiring |
| 113 | `assertSandboxAgentStreamingExecSupported` | 2927–2945 | 23 | `provisioning-sandbox-state.ts` | Exact + wiring |
| 114 | `recordContinuationProvenance` | 2947–2957 | 22 | `continuation-context.ts` | Exact + wiring |
| 115 | `beginGoalTaskRework` | 2959–2983 | 22 | `continuation-context.ts` | Exact + wiring |
| 116 | `taskFeedbackEvents` | 2985–3010 | 22 | `continuation-context.ts` | Exact + wiring |
| 117 | `{ primeRuntimeForResume }` | 3012–3019 | 33 | `pod-manager.ts` | Exact + wiring |
| 118 | `syncSandboxRuntimeSessionState` | 3021–3074 | 23 | `provisioning-sandbox-state.ts` | Exact + wiring |
| 119 | `syncSandboxSeriesHandover` | 3076–3105 | 23 | `provisioning-sandbox-state.ts` | Exact + wiring |
| 120 | `mergeQueue` | 3119–3119 | 27 | `delivery-state.ts` | Exact + wiring |
| 121 | `haproxyDenyHandles` | 3125–3125 | 30 | `resource-denials.ts` | Exact + wiring |
| 122 | `maxCredentialLineageByPod` | 3126–3126 | 21 | `provider-attempt-context.ts` | Exact + wiring |
| 123 | `readinessService` | 3127–3136 | 26 | `approval-readiness.ts` | Exact + wiring |
| 124 | `refreshReadiness` | 3138–3166 | 26 | `approval-readiness.ts` | Exact + wiring |
| 125 | `ApprovalReadiness` | 3168–3174 | 26 | `approval-contracts.ts` | Exact + wiring |
| 126 | `resolveApprovalReadiness` | 3176–3208 | 26 | `approval-readiness.ts` | Exact + wiring |
| 127 | `normalizeApprovalReason` | 3210–3213 | 26 | `approval-policy.ts` | Exact + wiring |
| 128 | `readinessSkipReason` | 3215–3219 | 26 | `approval-policy.ts` | Exact + wiring |
| 129 | `assertApprovalAllowed` | 3221–3238 | 26 | `approval-policy.ts` | Exact + wiring |
| 130 | `persistReadinessApproval` | 3240–3275 | 26 | `approval-readiness.ts` | Exact + wiring |
| 131 | `rememberMaxCredentialLineage` | 3277–3283 | 21 | `provider-attempt-context.ts` | Exact + wiring |
| 132 | `forgetMaxCredentialLineage` | 3285–3287 | 21 | `provider-attempt-context.ts` | Exact + wiring |
| 133 | `startHaproxyDenyReceiver` | 3292–3316 | 30 | `resource-denials.ts` | Exact + wiring |
| 134 | `stopHaproxyDenyReceiver` | 3319–3328 | 30 | `resource-denials.ts` | Exact + wiring |
| 135 | `destroyPodNetwork` | 3334–3342 | 30 | `resource-network.ts` | Exact + wiring |
| 136 | `CONTAINER_CLEANUP_TIMEOUT_MS` | 3348–3348 | 30 | `resource-policy.ts` | Exact + wiring |
| 137 | `cleanupContainer` | 3360–3447 | 30 | `resource-cleanup.ts` | Exact + wiring |
| 138 | `runPushCheckpointScan` | 3458–3500 | 27 | `delivery-scan.ts` | Exact + wiring |
| 139 | `getLatestPushFindings` | 3505–3516 | 27 | `delivery-scan.ts` | Exact + wiring |
| 140 | `sandboxPreviewProxies` | 3518–3521 | 30 | `resource-preview.ts` | Exact + wiring |
| 141 | `nativePreviewPorts` | 3523–3523 | 30 | `resource-preview.ts` | Exact + wiring |
| 142 | `tryNativeSandboxPreview` | 3531–3563 | 30 | `resource-preview.ts` | Exact + wiring |
| 143 | `ensureSandboxPreviewProxy` | 3565–3623 | 30 | `resource-preview.ts` | Exact + wiring |
| 144 | `stopSandboxPreviewProxy` | 3625–3640 | 30 | `resource-preview.ts` | Exact + wiring |
| 145 | `parsePreviewPort` | 3642–3650 | 30 | `resource-policy.ts` | Exact + wiring |
| 146 | `killSidecarsForPod` | 3656–3695 | 30 | `resource-auxiliary.ts` | Exact + wiring |
| 147 | `cleanupTestRunBranches` | 3702–3754 | 30 | `resource-auxiliary.ts` | Exact + wiring |
| 148 | `previewTimers` | 3757–3757 | 30 | `resource-preview-timers.ts` | Exact + wiring |
| 149 | `commitPolling` | 3760–3762 | 30 | `resource-commit-polling.ts` | Exact + wiring |
| 150 | `COMMIT_POLL_INTERVAL_MS` | 3764–3764 | 30 | `resource-policy.ts` | Exact + wiring |
| 151 | `mergePolling` | 3766–3768 | 27 | `delivery-state.ts` | Exact + wiring |
| 152 | `DEFAULT_MERGE_POLL_INTERVAL_MS` | 3770–3770 | 27 | `delivery-state.ts` | Exact + wiring |
| 153 | `validationAbortControllers` | 3773–3773 | 20 | `validation-workflow-state.ts` | Exact + wiring |
| 154 | `attemptExtensionRuns` | 3775–3775 | 20 | `validation-workflow-state.ts` | Exact + wiring |
| 155 | `infrastructureResumeRuns` | 3776–3776 | 31 | `workspace-recovery-state.ts` | Exact + wiring |
| 156 | `artifactResumeRuns` | 3777–3777 | 31 | `workspace-recovery-state.ts` | Exact + wiring |
| 157 | `artifactCompletionRuns` | 3778–3778 | 31 | `workspace-recovery-state.ts` | Exact + wiring |
| 158 | `coordinateInteractiveCompletion` | 3779–3780 | 31 | `workspace-recovery-state.ts` | Exact + wiring |
| 159 | `pauseIntents` | 3781–3781 | 29 | `operator-state.ts` | Exact + wiring |
| 160 | `activeAgentRuns` | 3782–3791 | 24 | `agent-run-registry.ts` | Exact + wiring |
| 161 | `activeAgentRunResolvers` | 3792–3792 | 24 | `agent-run-registry.ts` | Exact + wiring |
| 162 | `PAUSE_QUIESCENCE_TIMEOUT_MS` | 3793–3793 | 29 | `operator-state.ts` | Exact + wiring |
| 163 | `ownsLifecycle` | 3796–3802 | 25 | `completion-guards.ts` | Exact + wiring |
| 164 | `advisoryRuns` | 3807–3807 | 30 | `resource-advisory.ts` | Exact + wiring |
| 165 | `ADVISORY_QA_MAX_CONCURRENCY` | 3812–3812 | 30 | `resource-advisory.ts` | Exact + wiring |
| 166 | `advisoryQaActive` | 3813–3813 | 30 | `resource-advisory.ts` | Exact + wiring |
| 167 | `advisoryQaWaiters` | 3814–3814 | 30 | `resource-advisory.ts` | Exact + wiring |
| 168 | `acquireAdvisoryQaSlot` | 3816–3822 | 30 | `resource-advisory.ts` | Exact + wiring |
| 169 | `releaseAdvisoryQaSlot` | 3824–3831 | 30 | `resource-advisory.ts` | Exact + wiring |
| 170 | `cleanupContainerAfterAdvisorySettles` | 3833–3855 | 30 | `resource-advisory.ts` | Exact + wiring |
| 171 | `pendingUpdateFromBaseIntents` | 3859–3859 | 20 | `validation-workflow-state.ts` | Exact + wiring |
| 172 | `forceWithLeaseAllowances` | 3863–3863 | 31 | `workspace-recovery-state.ts` | Exact + wiring |
| 173 | `lastEventWriteAt` | 3872–3872 | 24 | `agent-activity.ts` | Exact + wiring |
| 174 | `EVENT_TIMESTAMP_WRITE_THROTTLE_MS` | 3873–3873 | 24 | `agent-activity.ts` | Exact + wiring |
| 175 | `bumpActivityTimestamp` | 3881–3891 | 24 | `agent-activity.ts` | Exact + wiring |
| 176 | `stuckPodWatchdog` | 3894–3894 | 31 | `workspace-watchdog.ts` | Exact + wiring |
| 177 | `unsubscribeWakeRecovery` | 3896–3896 | 31 | `workspace-watchdog.ts` | Exact + wiring |
| 178 | `resolveBranchSource` | 3910–3954 | 31 | `workspace-branch-source.ts` | Exact + wiring |
| 179 | `isFixCycleTerminal` | 3963–3964 | 28 | `fix-policy.ts` | Exact + wiring |
| 180 | `isFixPodRecyclable` | 3973–3974 | 28 | `fix-policy.ts` | Exact + wiring |
| 181 | `FIX_DELIVERY_FAILED_PREFIX` | 3976–3976 | 28 | `fix-policy.ts` | Exact + wiring |
| 182 | `providerBindingForFixPod` | 3978–3999 | 28 | `fix-provider-binding.ts` | Exact + wiring |
| 183 | `parkFixPodDeliveryFailure` | 4001–4016 | 28 | `fix-parking.ts` | Exact + wiring |
| 184 | `isParkedHostPushRecovery` | 4018–4024 | 28 | `fix-parking.ts` | Exact + wiring |
| 185 | `isRetryableFixDeliveryFailure` | 4026–4033 | 28 | `fix-parking.ts` | Exact + wiring |
| 186 | `maybeSpawnFixSession` | 4050–4298 | 28 | `fix-admission.ts` | Exact + wiring |
| 187 | `postFixPodReviewFeedbackReplies` | 4300–4352 | 28 | `fix-feedback.ts` | Exact + wiring |
| 188 | `completeFixPodAfterPush` | 4366–4475 | 28 | `fix-delivery.ts` | Exact + wiring |
| 189 | `runUpdateFromBaseAfterAbort` | 4483–4525 | 20 | `validation-workflow-controls.ts` | Exact + wiring |
| 190 | `startMergePolling` | 4528–4759 | 27 | `delivery-polling.ts` | Exact + wiring |
| 191 | `stopMergePolling` | 4762–4764 | 27 | `delivery-polling.ts` | Exact + wiring |
| 192 | `resumeMergePolling` | 4767–4773 | 27 | `delivery-polling.ts` | Exact + wiring |
| 193 | `resumeMergePolling();` | 4776–4776 | 27 | `pod-manager.ts` | Partition / composition |
| 194 | `startCommitPolling` | 4779–4862 | 30 | `resource-commit-polling.ts` | Exact + wiring |
| 195 | `stopCommitPolling` | 4865–4867 | 30 | `resource-commit-polling.ts` | Exact + wiring |
| 196 | `clearPreviewTimer` | 4870–4876 | 30 | `resource-preview-timers.ts` | Exact + wiring |
| 197 | `schedulePreviewAutoStop` | 4879–4899 | 30 | `resource-preview-timers.ts` | Exact + wiring |
| 198 | `{ getResumeEnv, persistRuntimeCredentialsForPod }` | 4901–4912 | 33 | `pod-manager.ts` | Exact + wiring |
| 199 | `{ buildReviewerExecEnv, getEffectiveReviewerConfig, getReviewerExecutor }` | 4914–4924 | 33 | `pod-manager.ts` | Exact + wiring |
| 200 | `touchHeartbeat` | 4926–4932 | 24 | `agent-activity.ts` | Exact + wiring |
| 201 | `{ syncWorkspaceBack, recoverWorktreeFromContainer }` | 4934–4934 | 33 | `pod-manager.ts` | Exact + wiring |
| 202 | `{ prepareWorkspaceForValidation }` | 4936–4939 | 33 | `pod-manager.ts` | Exact + wiring |
| 203 | `{ preservePodWorkspace, checkpointSandboxWorkspaceForPod }` | 4941–4948 | 33 | `pod-manager.ts` | Exact + wiring |
| 204 | `{ holdCompletionForHumanWork }` | 4950–4958 | 33 | `completion-workflow.ts` | Exact + wiring |
| 205 | `{ prepareSourceForCompletion }` | 4960–4975 | 33 | `completion-workflow.ts` | Exact + wiring |
| 206 | `{ applyCompletionDecision }` | 4977–4989 | 33 | `completion-workflow.ts` | Exact + wiring |
| 207 | `{ startValidationAttempt }` | 4991–4999 | 33 | `pod-manager.ts` | Exact + wiring |
| 208 | `{ prepareValidationInputs }` | 5001–5016 | 33 | `pod-manager.ts` | Exact + wiring |
| 209 | `{ buildPhaseEventCallbacks, ownedValidationCallbacks }` | 5018–5020 | 33 | `pod-manager.ts` | Exact + wiring |
| 210 | `{ recordValidationProvenance, withReviewerLaunchPreflight }` | 5022–5026 | 33 | `pod-manager.ts` | Exact + wiring |
| 211 | `{ validateWithInfrastructureRetries }` | 5028–5043 | 33 | `pod-manager.ts` | Exact + wiring |
| 212 | `{ collectValidationEvidence }` | 5045–5054 | 33 | `pod-manager.ts` | Exact + wiring |
| 213 | `{ publishValidationResult }` | 5056–5060 | 33 | `pod-manager.ts` | Exact + wiring |
| 214 | `{ parkOnRetryAdmission, parkOnValidationInfrastructureFailure, parkOnReviewInfrastructureFailure, }` | 5062–5073 | 33 | `pod-manager.ts` | Exact + wiring |
| 215 | `preserveSandboxAfterAgentFailure` | 5075–5091 | 31 | `workspace-preservation-recovery.ts` | Exact + wiring |
| 216 | `installGhBinary` | 5095–5121 | 23 | `provisioning-tool-installation.ts` | Exact + wiring |
| 217 | `installAzViaPip` | 5126–5151 | 23 | `provisioning-tool-installation.ts` | Exact + wiring |
| 218 | `emitActivityStatus` | 5153–5164 | 25 | `completion-events.ts` | Exact + wiring |
| 219 | `formatElapsedDuration` | 5166–5168 | 25 | `completion-diagnostics.ts` | Exact + wiring |
| 220 | `emitActivityError` | 5170–5179 | 25 | `completion-events.ts` | Exact + wiring |
| 221 | `emitBlockingSecurityScanFindings` | 5181–5208 | 25 | `completion-diagnostics.ts` | Exact + wiring |
| 222 | `sanitizeSecurityScanLogValue` | 5210–5217 | 25 | `completion-diagnostics.ts` | Exact + wiring |
| 223 | `OperatorFailurePhase` | 5219–5219 | 25 | `completion-diagnostics.ts` | Exact + wiring |
| 224 | `sanitizeFailureReason` | 5221–5228 | 25 | `completion-diagnostics.ts` | Exact + wiring |
| 225 | `operatorErrorMessage` | 5230–5238 | 25 | `completion-diagnostics.ts` | Exact + wiring |
| 226 | `describeSyncFailure` | 5240–5245 | 25 | `completion-diagnostics.ts` | Exact + wiring |
| 227 | `tryRecoverAfterWorkspaceSyncFailure` | 5247–5280 | 31 | `workspace-preservation-recovery.ts` | Exact + wiring |
| 228 | `protectedOperationalPathReason` | 5282–5294 | 20 | `validation-workflow-policy.ts` | Exact + wiring |
| 229 | `podExplicitlyScopesOperationalPaths` | 5296–5320 | 20 | `validation-workflow-policy.ts` | Exact + wiring |
| 230 | `assertProtectedOperationalPathsInScope` | 5322–5330 | 20 | `validation-workflow-policy.ts` | Exact + wiring |
| 231 | `taskSummaryWithApprovedFactWaiver` | 5332–5361 | 26 | `approval-policy.ts` | Exact + wiring |
| 232 | `advisoryPublicationOwnership` | 5363–5391 | 19 | `advisory-validation.ts` | Exact + wiring |
| 233 | `runAdvisoryAfterValidation` | 5393–5529 | 19 | `advisory-validation.ts` | Exact + wiring |
| 234 | `parkOnCredentialFailure` | 5544–5576 | 27 | `delivery-credentials.ts` | Exact + wiring |
| 235 | `handleDeletionGuardError` | 5578–5597 | 31 | `workspace-fences.ts` | Exact + wiring |
| 236 | `ownsArtifactCompletion` | 5599–5613 | 31 | `workspace-fences.ts` | Exact + wiring |
| 237 | `failInteractivePreservation` | 5615–5622 | 31 | `workspace-fences.ts` | Exact + wiring |
| 238 | `assertApprovalCurrent` | 5624–5655 | 26 | `approval-readiness.ts` | Exact + wiring |
| 239 | `failBranchPreservation` | 5657–5664 | 31 | `workspace-fences.ts` | Exact + wiring |
| 240 | `assertInteractiveCompletionCurrent` | 5666–5695 | 31 | `workspace-fences.ts` | Exact + wiring |
| 241 | `{ preserveArtifacts, finalizeArtifactPod }` | 5697–5710 | 33 | `pod-manager.ts` | Exact + wiring |
| 242 | `parkOnWorktreeSyncFailure` | 5712–5726 | 31 | `workspace-fences.ts` | Exact + wiring |
| 243 | `ensurePrBaseBranchOnOrigin` | 5728–5766 | 27 | `delivery-pr.ts` | Exact + wiring |
| 244 | `pushAndCreatePr` | 5774–5887 | 27 | `delivery-pr.ts` | Exact + wiring |
| 245 | `transition` | 5889–5921 | 25 | `completion-events.ts` | Exact + wiring |
| 246 | `applySkipValidationDecision` | 5923–5949 | 20 | `validation-workflow-controls.ts` | Exact + wiring |
| 247 | `emitPodCompletedEvent` | 5951–5969 | 25 | `completion-events.ts` | Exact + wiring |
| 248 | `makeUnexpectedValidationFailureResult` | 5971–5998 | 20 | `validation-workflow-policy.ts` | Exact + wiring |
| 249 | `claimValidation` | 6000–6019 | 20 | `validation-workflow-controls.ts` | Exact + wiring |
| 250 | `recordNotReportedMemoryUsage` | 6021–6023 | 24 | `agent-activity.ts` | Exact + wiring |
| 251 | `maybeTriggerDependents` | 6034–6142 | 32 | `admission-dependents.ts` | Exact + wiring |
| 252 | `getLaunchConfiguration` | 6145–6147 | 32 | `admission-queries.ts` | Exact + wiring |
| 253 | `createResolvedSession` | 6148–6229 | 32 | `admission-resolved.ts` | Exact + wiring |
| 254 | `createSession` | 6230–6613 | 32 | `admission-legacy.ts` | Exact + wiring |
| 255 | `createHistoryWorkspace` | 6615–6634 | 32 | `admission-analysis-workspaces.ts` | Exact + wiring |
| 256 | `createMemoryWorkspace` | 6636–6669 | 32 | `admission-analysis-workspaces.ts` | Exact + wiring |
| 257 | `resumeNativeGoal` | 6671–6722 | 22 | `continuation-controls.ts` | Exact + wiring |
| 258 | `processPod` | 6723–9583 | 24; provisioning 23 / completion 25 | `agent-process-workflow.ts` | Partition / composition |
| 259 | `consumeAgentEvents` | 9585–10229 | 24 | `agent-event-consumption.ts` | Exact + wiring |
| 260 | `handleCompletion` | 10231–10278 | 25 | `completion-workflow.ts` | Exact + wiring |
| 261 | `sendMessage` | 10280–10767 | 29 | `operator-messages.ts` | Exact + wiring |
| 262 | `approveSession` | 10769–11562 | 26 | `approval-workflow.ts` | Partition / composition |
| 263 | `rejectSession` | 11564–11661 | 29 | `operator-rejection.ts` | Exact + wiring |
| 264 | `pauseSession` | 11663–11736 | 29 | `operator-pause.ts` | Exact + wiring |
| 265 | `nudgeSession` | 11738–11751 | 29 | `operator-controls.ts` | Exact + wiring |
| 266 | `killSession` | 11753–11895 | 29 | `operator-kill.ts` | Exact + wiring |
| 267 | `promoteToAuto` | 11907–12050 | 31 | `workspace-promotion.ts` | Exact + wiring |
| 268 | `completeSession` | 12052–12274 | 31 | `workspace-completion.ts` | Exact + wiring |
| 269 | `syncWorkspaceBranch` | 12276–12391 | 31 | `workspace-branch-sync.ts` | Exact + wiring |
| 270 | `preserveWorkspace` | 12393–12395 | 31 | `workspace-recovery-commands.ts` | Exact + wiring |
| 271 | `quiesceSandboxAgent` | 12397–12426 | 31 | `workspace-recovery-commands.ts` | Exact + wiring |
| 272 | `suspendSandboxForRecovery` | 12428–12433 | 31 | `workspace-recovery-commands.ts` | Exact + wiring |
| 273 | `cleanupPodResourcesForRecovery` | 12435–12438 | 31 | `workspace-recovery-commands.ts` | Exact + wiring |
| 274 | `assertCanRework` | 12440–12467 | 22 | `continuation-controls.ts` | Exact + wiring |
| 275 | `triggerValidation` | 12469–13571 | 20 | `validation-trigger-workflow.ts` | Partition / composition |
| 276 | `revalidateSession` | 13573–14127 | 20 | `validation-revalidation-workflow.ts` | Partition / composition |
| 277 | `fixManually` | 14129–14218 | 31 | `workspace-manual-fix.ts` | Exact + wiring |
| 278 | `notifyEscalation` | 14220–14228 | 29 | `operator-controls.ts` | Exact + wiring |
| 279 | `touchHeartbeat` | 14230–14230 | 24 | `agent-activity.ts` | Partition / composition |
| 280 | `getReviewerConfig` | 14231–14236 | 33 | `pod-manager-facade.ts` | Exact + wiring |
| 281 | `getReviewerExecEnv` | 14237–14239 | 33 | `pod-manager-facade.ts` | Exact + wiring |
| 282 | `getReviewerExecutor` | 14240–14240 | 33 | `reviewer-context.ts` | Partition / composition |
| 283 | `getProjectMemoryScope` | 14241–14243 | 32 | `admission-memory-context.ts` | Exact + wiring |
| 284 | `getLaunchMemoryContext` | 14244–14265 | 32 | `admission-memory-context.ts` | Exact + wiring |
| 285 | `deleteSession` | 14267–14359 | 31 | `workspace-deletion.ts` | Exact + wiring |
| 286 | `startPreview` | 14361–14495 | 30 | `resource-preview-controls.ts` | Exact + wiring |
| 287 | `stopPreview` | 14497–14514 | 30 | `resource-preview-controls.ts` | Exact + wiring |
| 288 | `previewStatus` | 14516–14629 | 30 | `resource-preview-controls.ts` | Exact + wiring |
| 289 | `getSession` | 14631–14633 | 32 | `admission-queries.ts` | Exact + wiring |
| 290 | `refreshReadinessAfterQualityScore` | 14635–14637 | 26 | `approval-controls.ts` | Exact + wiring |
| 291 | `getValidationEnvironment` | 14639–14642 | 33 | `pod-manager-facade.ts` | Exact + wiring |
| 292 | `getDeploymentConfiguration` | 14644–14656 | 32 | `admission-queries.ts` | Exact + wiring |
| 293 | `getInjectedMcpServer` | 14658–14673 | 32 | `admission-queries.ts` | Exact + wiring |
| 294 | `getInjectedMcpServers` | 14675–14679 | 32 | `admission-queries.ts` | Exact + wiring |
| 295 | `listSessions` | 14681–14683 | 32 | `admission-queries.ts` | Exact + wiring |
| 296 | `getSessionStats` | 14685–14687 | 32 | `admission-queries.ts` | Exact + wiring |
| 297 | `getSeriesPods` | 14689–14691 | 32 | `admission-queries.ts` | Exact + wiring |
| 298 | `rehydrateDependentSessions` | 14693–14758 | 32 | `admission-dependents.ts` | Exact + wiring |
| 299 | `deleteSeriesWithCascade` | 14760–14776 | 32 | `admission-series-deletion.ts` | Exact + wiring |
| 300 | `getValidationHistory` | 14778–14782 | 32 | `admission-queries.ts` | Exact + wiring |
| 301 | `approveAllValidated` | 14784–14806 | 26 | `approval-controls.ts` | Exact + wiring |
| 302 | `killAllFailed` | 14808–14820 | 29 | `operator-controls.ts` | Exact + wiring |
| 303 | `extendAttempts` | 14822–14866 | 20 | `validation-workflow-controls.ts` | Exact + wiring |
| 304 | `applyOverridesInstant` | 14868–14913 | 20 | `validation-workflow-controls.ts` | Exact + wiring |
| 305 | `approveFactWaiver` | 14915–14989 | 26 | `approval-controls.ts` | Exact + wiring |
| 306 | `forceApprove` | 14991–15044 | 26 | `approval-controls.ts` | Exact + wiring |
| 307 | `extendPrAttempts` | 15046–15092 | 28 | `fix-controls.ts` | Exact + wiring |
| 308 | `interruptValidation` | 15094–15096 | 20 | `validation-workflow-controls.ts` | Exact + wiring |
| 309 | `updateFromBase` | 15098–15177 | 20 | `validation-workflow-controls.ts` | Exact + wiring |
| 310 | `setSkipValidation` | 15179–15235 | 20 | `validation-workflow-controls.ts` | Exact + wiring |
| 311 | `refreshNetworkPolicy` | 15237–15348 | 30 | `resource-network.ts` | Exact + wiring |
| 312 | `injectCredential` | 15350–15356 | 29 | `operator-tools.ts` | Exact + wiring |
| 313 | `installCliTool` | 15358–15386 | 29 | `operator-tools.ts` | Exact + wiring |
| 314 | `spawnFixSession` | 15394–15449 | 28 | `fix-controls.ts` | Exact + wiring |
| 315 | `requestFixSession` | 15451–15492 | 28 | `fix-controls.ts` | Exact + wiring |
| 316 | `retryCreatePr` | 15494–15518 | 27 | `delivery-pr.ts` | Exact + wiring |
| 317 | `getArtifactResumeObservation` | 15520–15542 | 31 | `workspace-artifact-observation.ts` | Exact + wiring |
| 318 | `resumePod` | 15544–15820 | 22 | `continuation-controls.ts` | Exact + wiring |
| 319 | `continueProvider` | 15822–16061 | 22 | `provider-continuation.ts` | Exact + wiring |
| 320 | `forceComplete` | 16063–16111 | 31 | `workspace-escape-controls.ts` | Exact + wiring |
| 321 | `kickPod` | 16113–16176 | 31 | `workspace-escape-controls.ts` | Exact + wiring |
| 322 | `startStuckPodWatchdog` | 16178–16313 | 31 | `workspace-watchdog.ts` | Exact + wiring |
| 323 | `stopStuckPodWatchdog` | 16315–16324 | 31 | `workspace-watchdog.ts` | Exact + wiring |
| 324 | `recoverWorktree` | 16326–16439 | 31 | `workspace-recovery-commands.ts` | Exact + wiring |
| 325 | `hostnameFromUrl` | 16443–16449 | 30 | `resource-policy.ts` | Exact + wiring |
| 326 | `portFromUrl` | 16451–16459 | 30 | `resource-policy.ts` | Exact + wiring |
| 327 | `buildCodeIntelligenceServers` | 16466–16521 | 23 | `provisioning-runtime-files.ts` | Exact + wiring |

## Mutable ownership and cleanup

Each row identifies the single creating owner. Cooperating workflow/control consumers
receive its original references; they do not allocate replacement trackers. The local
evidence records all consumers, exact executed case names and actual assertion source.

| Original binding | Creating owner | Tested release/stop contract |
|---|---|---|
| `hostFetchRetryTimers` | `workspace-host-fetch-retry.ts` / `createWorkspaceHostFetchRetry` | Replacement clears prior timer; fire deletes registration before checking current state/queueing. No cancel-all or abort/drain contract. |
| `mergeQueue` | `delivery-state.ts` / `createDeliveryMergeQueue` | One MergeQueue per manager; inherited KeyedPromiseQueue releases matching tail on settlement, advances after rejection and preserves per-key serialization. |
| `haproxyDenyHandles` | `resource-denials.ts` / `createResourceDenials` | Delete handle authority before awaited stop; repeated cleanup stops once; startup/stop failure remains best-effort. |
| `maxCredentialLineageByPod` | `provider-attempt-context.ts` / `createProviderAttemptContext` | Same MAX credential-lineage references; absence and explicit forget delete entry; per-owner isolation. |
| `sandboxPreviewProxies` | `resource-preview.ts` / `createResourcePreview` | One proxy cache; reuse matching target; stop deletes cache/closes actual local HTTP server; native cache replacement follows original contract. |
| `nativePreviewPorts` | `resource-preview.ts` / `createResourcePreview` | One native-port cache; reuse matching container, replace target, stop removes cached current target and unexposes once. No new guarantee of cleaning historical remote exposure. |
| `previewTimers` | `resource-preview-timers.ts` / `createResourcePreviewTimers` | One timer map; replacement/cancel clears timer; fire removes entry before cleanup even if cleanup rejects; unref retained. |
| `commitPolling` | `resource-commit-polling.ts` / `createResourceCommitPollingState` | Single commit coordinator; stop clears schedule; draining old operation cannot publish/stop replacement and replacement waits for drain. Running remote work is not aborted. |
| `mergePolling` | `delivery-state.ts` / `createDeliveryPollingState` | Single merge coordinator; replace fences old owner and stop clears schedule; failed operation releases running entry, permitting next tick. No remote abort/drain promise. |
| `validationAbortControllers` | `validation-workflow-state.ts` / `createValidationWorkflowState` | One controller registry shared with controls/trigger/revalidation; finally deletes only matching invocation, including rejected/superseded validation; replacement retained. |
| `attemptExtensionRuns` | `validation-workflow-state.ts` / `createValidationWorkflowState` | One accepted-extension map; concurrent acknowledgements coalesce; matching detached recovery finally clears on success/failure. |
| `infrastructureResumeRuns` | `workspace-recovery-state.ts` / `createWorkspaceRecoveryState` | One infrastructure-resume map shared with continuation controls; repeat request coalesces while settling and entry is released on settlement. In-process only. |
| `artifactResumeRuns` | `workspace-recovery-state.ts` / `createWorkspaceRecoveryState` | One artifact-resume map shared with continuation controls; coalescing releases after completion success or original collection error. |
| `artifactCompletionRuns` | `workspace-recovery-state.ts` / `createWorkspaceRecoveryState` | One artifact-completion map shared with completion workflow; same cycle coalesces, finally clears only its matching promise; errors/replacement generations remain isolated. |
| `coordinateInteractiveCompletion` | `workspace-recovery-state.ts` / `createWorkspaceRecoveryState` | One interactive-completion coordinator per manager; same request coalesces, conflicts reject while active; success/error release admits later request. In-process only. |
| `pauseIntents` | `operator-state.ts` / `createOperatorPauseState` | One pause-intent registry shared with message/pause/event owners; pause finally releases matching intent after quiescence; timeout/failed suspension retains pending ownership until actual settlement and preserves replacement token. |
| `activeAgentRuns` | `agent-run-registry.ts` / `createAgentRunRegistry` | One run registry shared with event consumer/process/provider/operator owners; stream finalization settles/removes matching run, retaining a superseding token. |
| `activeAgentRunResolvers` | `agent-run-registry.ts` / `createAgentRunRegistry` | One resolver registry; settle own waiter then delete matching token; replacement resolver is retained and not invoked by stale run. |
| `advisoryRuns` | `resource-advisory.ts` / `createResourceAdvisoryState` | One advisory-run registry shared with advisory execution/cleanup; runner finally releases map entry; resource cleanup waits for advisory resolution/rejection. |
| `advisoryQaActive` | `resource-advisory.ts` / `createResourceAdvisoryState` | One active counter inside advisory semaphore; release transfers existing slot FIFO, decrements only without waiter; runner failure releases permit. |
| `advisoryQaWaiters` | `resource-advisory.ts` / `createResourceAdvisoryState` | One FIFO waiter array inside same semaphore; release shifts/resolves next waiter, retains active capacity until no waiters. Counter/waiter state is private to this single owner. |
| `pendingUpdateFromBaseIntents` | `validation-workflow-state.ts` / `createValidationWorkflowState` | One base-update intent Set shared with workflow/control/deletion owners; skip/pass/deletion consume intent; queued abort retains intent until follow-up. |
| `forceWithLeaseAllowances` | `workspace-recovery-state.ts` / `createWorkspaceLeaseState` | One lease allowance Set from createWorkspaceLeaseState; shared with rebase/approval/deletion; deletion removes only after verified cleanup. Native approval consumption preserves qualified27behavior. |
| `lastEventWriteAt` | `agent-activity.ts` / `createAgentActivity` | One throttle map shared with event consumption; matching current run finalization deletes liveness entry; superseded finalizer preserves replacement state. |
| `stuckPodWatchdog` | `workspace-watchdog.ts` / `createWorkspaceWatchdog` | One watchdog interval; idempotent start; stop clears interval. No drain guarantee for work already dispatched. |
| `unsubscribeWakeRecovery` | `workspace-watchdog.ts` / `createWorkspaceWatchdog` | One wake subscription; stop unsubscribes, later host-resumed event does not dispatch; already-dispatched wake continuation retains original behavior. |

The merge queue's private keyed locks, both polling coordinators' registration/running
maps and intervals, and the interactive coordinator's coalescing state are covered
through their actual owners and primitive contracts. `createReadinessService` retains
no mutable tracker; immutable policy Sets and ephemeral computation Sets remain separate.
Injected repositories, pending human request maps and queue/service instances remain
caller-owned ports, with captured/live behavior preserved.

## Evidence and reproducibility

Full local logs, commands/exits, original source, row/reference maps, partition proofs,
actual test assertion locations, source/test/root hashes, gate comparison and pinned
runner are retained under `.autopod-data/final-qualification/`. The final verdict and
evidence SHA-256 values are in `proof.json`. Earlier slice evidence remains in its
original responsibility folders. This directory is local verification evidence, not
an additional product runtime or a requirement for running the daemon.

Audit entry points retained there: `slice34-audit.cjs`, `slice34-partitions.cjs`,
`slice34-state-audit.cjs`, `slice34-final-architecture.cjs`, `slice34-test-types.cjs`,
`slice34-direct.py`, `slice34-freeze.py`, and the inherited full facade verifier.
The frozen source manifest is also retained. Audit scripts require those local baseline
and recipe artifacts; a missing artifact is not a successful audit. The standard
repository validation command remains independently runnable.

Initial new-test fixture and audit-tool errors are retained in the evidence. They were
corrected before final freezing. Assertions, inherited thresholds/skips and product
behavior were not weakened. Final direct, public and frozen full runs pass.

The final branch is ready for separately authorized integration review. No numbered
rewrite slice remains.


## Merge preparation follow-up — 2026-10-19

GitHub CI exposed a configuration gap after opening PR #440: the final public
characterization file is 1,205,330 bytes, above Biome's default 1 MiB input limit.
The full local qualification above had used the documented task-local 2 MiB limit.
The standard CI command stopped at lint before build/test; desktop tests and secret
scanning passed independently.

Repository `biome.json` now sets `files.maxSize` to 2,097,152 bytes, so ordinary
`npx pnpm lint` and CI inspect that same complete characterization file. The ordinary
command passes with the same 82 inherited warnings and no errors. Lint/format/import
rules, ignore patterns, assertions, skips and all 2,200 frozen package/script files
remain unchanged. This is a later lint-configuration checkpoint; the six-root hash
manifest above continues to describe its explicitly pinned pre-integration revision.
GitHub checks on the new PR head must pass before merging.
