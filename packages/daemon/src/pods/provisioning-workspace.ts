import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { PodOptions } from '@autopod/shared';
import { AutopodError } from '@autopod/shared';
import { deriveBareRepoPath } from '../worktrees/bare-push.js';
import type { PodUpdates } from './pod-repository.js';
import { resolvedReasoningEffort } from './provider-attempt-policy.js';
import { resolveProviderPreflight } from './provider-preflight.js';
import type {
  ProvisioningCaptured,
  ProvisioningInput,
  ProvisioningLiveDependencies,
} from './provisioning-ports.js';
import { waitForRetryBackoff } from './retry-backoff-wait.js';
import { sandboxStartupRetryInput } from './sandbox-startup-admission.js';

type Captured = Pick<
  ProvisioningCaptured,
  | 'materializeSpecFiles'
  | 'captureDeployBaselineHashes'
  | 'podRepo'
  | 'profileStore'
  | 'providerAccountStore'
  | 'providerCatalog'
  | 'containerManagerFactory'
  | 'worktreeManager'
  | 'logger'
  | 'repoScanner'
  | 'executionCredentialsFor'
  | 'resolveGitCredential'
  | 'assertSandboxAgentStreamingExecSupported'
  | 'destroyPodNetwork'
  | 'stopSandboxPreviewProxy'
  | 'killSidecarsForPod'
  | 'closeProviderAttempt'
  | 'resolveEffectiveBoundProfile'
  | 'openProviderTargetAttempt'
  | 'persistRuntimeCredentialsForPod'
  | 'syncWorkspaceBack'
  | 'transition'
>;

export function createProvisioningWorkspace(
  deps: Pick<
    ProvisioningLiveDependencies,
    | 'launchConfiguration'
    | 'sandboxInfrastructureRecoveryDelay'
    | 'providerAttemptRepo'
    | 'sandboxInfrastructureRetryBackoffMs'
  >,
  captured: Captured,
) {
  const {
    materializeSpecFiles,
    captureDeployBaselineHashes,
    podRepo,
    profileStore,
    providerAccountStore,
    providerCatalog,
    containerManagerFactory,
    worktreeManager,
    logger,
    repoScanner,
    executionCredentialsFor,
    resolveGitCredential,
    assertSandboxAgentStreamingExecSupported,
    destroyPodNetwork,
    stopSandboxPreviewProxy,
    killSidecarsForPod,
    closeProviderAttempt,
    resolveEffectiveBoundProfile,
    openProviderTargetAttempt,
    persistRuntimeCredentialsForPod,
    syncWorkspaceBack,
    transition,
  } = captured;
  async function prepareWorkspace(input: ProvisioningInput) {
    let { launchConfig, pod, podId, lifecycleGeneration } = input;
    const { emitStatus, assertStartupCurrent } = input.run;
    const run = input.run;
    if (launchConfig && deps.launchConfiguration)
      await deps.launchConfiguration.assertCurrentCapabilities(launchConfig);
    const retryNotBefore = pod.infrastructureFailure?.retryNotBefore;
    if (
      !podRepo.sandboxStartupRetries &&
      pod.infrastructureFailure?.source === 'azure-sandbox' &&
      pod.infrastructureFailure.recoveryDisposition === 'automatic_retry_scheduled' &&
      retryNotBefore
    ) {
      if (Date.parse(retryNotBefore) > Date.now())
        emitStatus('Waiting for Azure sandbox recovery cooldown…');
      await waitForRetryBackoff(
        retryNotBefore,
        deps.sandboxInfrastructureRecoveryDelay ?? sleep,
        assertStartupCurrent,
      );
      assertStartupCurrent();
      pod = podRepo.getOrThrow(podId);
      if (pod.status !== 'queued') return { kind: 'halted' as const };
    }
    // Fetched inside the try so a missing profile (or broken extends chain) is caught
    // and transitions the pod to 'failed' instead of orphaning it as 'queued' forever —
    // the queue's finally block frees activeIds, and without a status update nothing
    // ever re-enqueues the pod.
    let profile = resolveEffectiveBoundProfile(pod);
    let queuedProviderAttempt = deps.providerAttemptRepo?.getActive(podId);
    let reasoningEffort = resolvedReasoningEffort(
      profile,
      pod.profileSnapshot as unknown as Record<string, unknown> | null,
    );
    profile = { ...profile, reasoningEffort };

    // For handoff pods the interactive container is still running. Persist
    // the human's work before stopping that container; if we cannot prove the
    // work is durable, park the pod and keep the live workspace available.
    if (pod.status === 'handoff' && pod.containerId && pod.worktreePath) {
      const cm = containerManagerFactory.get(pod.executionTarget);
      const interactiveRecoveryOptions: PodOptions = {
        agentMode: 'interactive',
        output: 'branch',
        validate: false,
        promotable: true,
      };
      const blockHandoff = (reason: string, err?: unknown): void => {
        logger.warn({ err, podId }, `Workspace handoff blocked: ${reason}`);
        emitStatus(`Workspace handoff blocked: ${reason}`);
        const current = podRepo.getOrThrow(podId);
        if (current.status === 'handoff') {
          transition(current, 'failed', {
            lastCorrectionMessage: `Workspace handoff failed: ${reason}`,
            options: interactiveRecoveryOptions,
            skipAgent: false,
          });
        }
      };

      try {
        await syncWorkspaceBack(pod.containerId, pod.worktreePath, cm, pod.id, pod.executionTarget);
      } catch (err) {
        blockHandoff('could not sync the interactive workspace back to the host worktree', err);
        return { kind: 'halted' as const };
      }

      let hasDurableHandoffDelta = false;
      try {
        const committed = await worktreeManager.commitPendingChanges(
          pod.worktreePath,
          'chore: sync human session',
          { maxDeletions: 100 },
        );
        if (committed) {
          logger.info({ podId }, 'Auto-committed human session changes during handoff');
        }

        const baseBranch = pod.baseBranch ?? profile.defaultBranch ?? 'main';
        const stats = await worktreeManager.getDiffStats(
          pod.worktreePath,
          baseBranch,
          pod.startCommitSha ?? undefined,
        );
        hasDurableHandoffDelta =
          stats.filesChanged > 0 || stats.linesAdded > 0 || stats.linesRemoved > 0;
      } catch (err) {
        blockHandoff('could not commit or verify the synced workspace changes', err);
        return { kind: 'halted' as const };
      }

      const hasInstructions =
        !!pod.handoffInstructions && pod.handoffInstructions.trim().length > 0;
      if (!hasDurableHandoffDelta && (pod.skipAgent || !hasInstructions)) {
        blockHandoff('no committed workspace changes were found after sync');
        return { kind: 'halted' as const };
      }

      // Recover runtime credentials before tearing down the workspace
      // container. MAX rotates refresh tokens; Codex may update auth.json.
      await persistRuntimeCredentialsForPod(
        podId,
        'Failed to persist runtime credentials before handoff stop — auth may be stale',
      );
      try {
        await stopSandboxPreviewProxy(podId);
        await cm.stop(pod.containerId);
        if (launchConfig) {
          assertStartupCurrent();
          const stopped = await cm.getStatus(pod.containerId);
          if (stopped !== 'stopped' && stopped !== 'deleted')
            throw new Error('Workspace termination is unconfirmed');
          await cm.kill(pod.containerId);
          await killSidecarsForPod(podId, true, assertStartupCurrent);
          await destroyPodNetwork(podId, true);
          assertStartupCurrent();
        }
      } catch (err) {
        logger.warn({ err, podId }, 'Failed to stop interactive container during handoff');
        if (launchConfig) {
          blockHandoff('workspace termination or resource cleanup is unconfirmed', err);
          return { kind: 'halted' as const };
        }
      }
      podRepo.update(podId, { containerId: null });
      pod = podRepo.getOrThrow(podId);

      // Compose the agent-facing handoff context now that the worktree
      // reflects the human's in-flight work. Reads the human's typed
      // instructions (captured by promoteToAuto) plus the live commit log
      // and diff stats; the system-instructions-generator renders this as
      // the `## Handoff` section in the agent's CLAUDE.md.
      //
      // Skip when `skipAgent` is set — the agent will never read this.
      if (!pod.skipAgent) {
        try {
          const baseBranch = pod.baseBranch ?? profile.defaultBranch ?? 'main';
          const [stats, commitLog] = await Promise.all([
            worktreeManager.getDiffStats(
              pod.worktreePath,
              baseBranch,
              pod.startCommitSha ?? undefined,
            ),
            worktreeManager.getCommitLog(
              pod.worktreePath,
              baseBranch,
              30,
              pod.startCommitSha ?? undefined,
            ),
          ]);

          const hasInstructions =
            !!pod.handoffInstructions && pod.handoffInstructions.trim().length > 0;
          const hasWork = stats.filesChanged > 0 || stats.linesAdded > 0 || stats.linesRemoved > 0;

          if (hasInstructions || hasWork) {
            const sections: string[] = [
              "You're picking up after a human-driven interactive session on this branch. " +
                'Treat the human as a collaborator, not noise — their commits encode intent, ' +
                'and their instructions (if any) take precedence over inferences from the diff alone.',
              '',
              // Three clearly-separated parts so the agent can tell the human's
              // authoritative handoff apart from the machine-generated activity
              // summary. Per the documented replacement rule, "Handoff
              // instructions" is the initial handoff captured at creation (the
              // Pi → workspace flow) UNLESS a promotion-time `--instructions`
              // correction replaced it in `promoteToAuto` — either way it is the
              // single authoritative instruction, never a blend of both.
              '### Handoff instructions',
              hasInstructions
                ? (pod.handoffInstructions as string)
                : '(none provided — infer the remaining work from the session summary and original brief)',
              '',
              '### Session summary',
              hasWork
                ? `${stats.filesChanged} file(s) changed, +${stats.linesAdded}/-${stats.linesRemoved} lines.`
                : 'No diff against base — the human may have explored without committing changes yet.',
            ];

            if (commitLog && commitLog.length > 0) {
              sections.push('', '### Commit log', '```', commitLog, '```');
            }

            const handoffContext = sections.join('\n');
            podRepo.update(podId, { handoffContext });
            pod = podRepo.getOrThrow(podId);
            logger.info(
              {
                podId,
                hasInstructions,
                filesChanged: stats.filesChanged,
                contextLength: handoffContext.length,
              },
              'Composed handoff context for promoted pod',
            );
          }
        } catch (err) {
          logger.warn(
            { err, podId },
            'Failed to compose handoff context — agent will run without it',
          );
        }
      }
    }

    if (launchConfig && pod.status === 'handoff' && !pod.containerId) {
      const configuration = deps.launchConfiguration;
      if (!configuration?.activateWorker)
        throw new AutopodError(
          'Frozen worker activation is unavailable',
          'CONFIG_EXECUTION_UNAVAILABLE',
          503,
        );
      const activated = await configuration.activateWorker(podId, lifecycleGeneration, (config) => {
        closeProviderAttempt(podId, 'completed');
        const account = config.agentAccounts[config.ai.main.providerAccountId];
        if (!account)
          throw new AutopodError('Worker account identity is missing', 'SNAPSHOT_CORRUPT', 500);
        podRepo.update(podId, {
          profileSnapshot: null,
          runtime: config.ai.main.runtime,
          model: config.ai.main.model,
          providerAccountIdSnapshot: account.accountId,
          providerIdSnapshot: account.providerId,
          executionTarget: config.execution.target,
          requireSidecars: Object.keys(config.resolvedExecution.sidecars),
          maxValidationAttempts: config.workflow.maxValidationAttempts,
          skipValidation: config.workflow.validationPhases.length === 0,
          networkPolicyResolved: null,
          tokenBudget:
            config.workflow.tokenBudget === null
              ? pod.tokenBudget
              : pod.tokenBudget === null
                ? config.workflow.tokenBudget
                : Math.min(pod.tokenBudget, config.workflow.tokenBudget),
          claudeSessionId: null,
          codexSessionId: null,
          piSessionId: null,
          autoApprove: !pod.skipAgent && config.workflow.completion === 'merge',
        });
        if (deps.providerAttemptRepo)
          openProviderTargetAttempt(podRepo.getOrThrow(podId), config.ai.main);
      });
      if (activated) {
        pod = podRepo.getOrThrow(podId);
        launchConfig = configuration.read(podId);
        profile = resolveEffectiveBoundProfile(pod);
        queuedProviderAttempt = deps.providerAttemptRepo?.getActive(podId);
        reasoningEffort = resolvedReasoningEffort(profile);
        profile = { ...profile, reasoningEffort };
      }
    }

    // Detect recovery mode before any provisioning work
    const isRecovery = !!pod.recoveryWorktreePath;
    const isInfrastructureRecovery =
      pod.infrastructureFailure?.source === 'azure-sandbox' &&
      pod.infrastructureFailure.recoveryDisposition === 'automatic_retry_scheduled';
    const isRework = isRecovery && !!pod.reworkReason;
    const isFreshContainerValidationOnly = isRecovery && pod.skipAgent && pod.status === 'queued';

    // Fresh provisioning gets a fresh worktree, so any prior deletion-guard
    // trip is moot. (Recovery reuses the existing worktree — leave the flag
    // intact; recoverWorktree() owns clearing it on that path.)
    const provisioningUpdates: Partial<PodUpdates> = {
      startedAt: new Date().toISOString(),
      failureReason: null,
    };
    if (!isRecovery && pod.worktreeCompromised) {
      provisioningUpdates.worktreeCompromised = false;
    }

    const providerPreflight = resolveProviderPreflight(profile, pod.runtime, pod.model, {
      profileStore,
      providerAccountStore,
      manifest: providerCatalog,
      ...(queuedProviderAttempt?.providerAccountId || pod.providerIdSnapshot
        ? {
            expectedBinding: {
              accountId: queuedProviderAttempt?.providerAccountId ?? pod.providerAccountIdSnapshot,
              providerId: queuedProviderAttempt?.providerAccountId
                ? (providerAccountStore?.get(queuedProviderAttempt.providerAccountId).provider ??
                  pod.providerIdSnapshot)
                : pod.providerIdSnapshot,
            },
          }
        : {}),
    });
    assertSandboxAgentStreamingExecSupported(profile, pod.executionTarget, pod.options);

    // Worktree is optional — artifact-mode profiles may have no repoUrl.
    let worktreePath: string | null = null;
    let bareRepoPath: string | null = null;

    if (profile.repoUrl) {
      // Validate recovery worktree is still a usable git directory.
      // It may have been cleaned up by another pod's kill (e.g. shared worktree path).
      let recoveryViable = false;
      if (isRecovery && pod.recoveryWorktreePath) {
        try {
          const gitlinkPath = path.join(pod.recoveryWorktreePath, '.git');
          await access(gitlinkPath);
          // Also verify the bare-repo worktree metadata directory still exists.
          // `git worktree prune` can remove it while the on-disk directory survives,
          // leaving the worktree in a broken state where the container gitdir repointing
          // script would fail trying to write to a non-existent path.
          const gitlinkContent = await readFile(gitlinkPath, 'utf8');
          const bareWorktreeDir = path.resolve(
            pod.recoveryWorktreePath,
            gitlinkContent.trim().replace(/^gitdir:\s*/, ''),
          );
          await access(bareWorktreeDir);
          recoveryViable = true;
        } catch {
          logger.warn(
            { podId, worktreePath: pod.recoveryWorktreePath },
            'Recovery worktree missing or bare-repo metadata gone — falling back to fresh worktree',
          );
          podRepo.update(podId, { recoveryWorktreePath: null });
        }
      }

      if (recoveryViable && pod.recoveryWorktreePath) {
        worktreePath = pod.recoveryWorktreePath;
        bareRepoPath = await deriveBareRepoPath(worktreePath);
        // Clear recovery flag now that we've captured the path
        podRepo.update(podId, { recoveryWorktreePath: null });
        emitStatus('Recovering pod — reusing existing worktree…');
        logger.info({ podId, worktreePath }, 'Recovery mode: reusing worktree');
      } else {
        // Normal path: create worktree
        emitStatus('Creating worktree…');
        if (!profile.repoUrl) {
          throw new AutopodError(
            `Launch '${profile.name}' has no repository`,
            'INVALID_PROFILE',
            400,
          );
        }
        const result = await worktreeManager.create({
          repoUrl: profile.repoUrl,
          branch: pod.branch,
          baseBranch: pod.baseBranch ?? profile.defaultBranch ?? 'main',
          startBranch: pod.startBranch ?? undefined,
          pat: await resolveGitCredential(profile),
          sessionId: pod.id,
        });
        worktreePath = result.worktreePath;
        bareRepoPath = result.bareRepoPath;
        if (pod.infrastructureFailure?.source === 'git-fetch') {
          // Only clear the incident after create has fetched every required
          // remote ref and materialized the worktree successfully.
          podRepo.update(podId, { infrastructureFailure: null });
          pod = podRepo.getOrThrow(podId);
        }
        if (!isRecovery && !pod.skipAgent && pod.options.agentMode !== 'interactive') {
          emitStatus('Checking contract declarations against fetched base…');
          const baseEvidence = await worktreeManager.inspectContractBase(
            worktreePath,
            pod.baseBranch ?? profile.defaultBranch ?? 'main',
            pod.contract?.requiredFacts ?? [],
          );
          const dispatchEvidence = podRepo.dispatchPreflight?.inspect(
            podId,
            pod.lifecycleGeneration,
            profile.repoUrl,
            pod.baseBranch ?? profile.defaultBranch ?? 'main',
            baseEvidence.baseCommitSha,
          );
          if (dispatchEvidence?.status === 'review_required')
            throw new AutopodError(
              `Equivalent active work requires review: ${dispatchEvidence.conflicts.map((entry) => entry.podId).join(', ')}. Review the existing execution or create an intentional rerun with a recorded reason.`,
              'EQUIVALENT_WORK_REVIEW_REQUIRED',
              409,
            );
        }
        const materializedStartSha = await materializeSpecFiles(
          worktreePath,
          pod.specFiles,
          worktreeManager,
          logger,
        );
        const startCommitSha = materializedStartSha ?? result.startCommitSha;
        // Persist startCommitSha now — before the container starts and before
        // any /diff request can land. Without this, the diff route falls back
        // to merge-base(HEAD, baseBranch), which for fix pods on a PR branch
        // surfaces the entire PR's prior sibling commits as the fix pod's
        // "work". captureStartSha (run later from agent-event consumption)
        // early-returns when this is already set, and re-tries when this is empty.
        if (!pod.startCommitSha && startCommitSha) {
          podRepo.update(podId, { startCommitSha });
          pod = podRepo.getOrThrow(podId);
        }

        if (profile.deployment?.enabled && bareRepoPath) {
          const baseRef = pod.baseBranch ?? profile.defaultBranch ?? 'main';
          const baselineHashes = await captureDeployBaselineHashes(
            bareRepoPath,
            baseRef,
            profile.deployment.allowedScripts,
            logger,
          );
          if (baselineHashes !== null) {
            podRepo.update(podId, { deployBaselineHashes: baselineHashes });
            pod = podRepo.getOrThrow(podId);
            logger.info(
              { podId, count: Object.keys(baselineHashes).length, baseRef },
              'deploy baseline hashes captured',
            );
          }
        }
      }
    }

    // A fresh repository must be materialized from authenticated remote refs
    // before entering provisioning. Recovery pods intentionally retain their
    // surviving worktree semantics and do not pass through this gate.
    if (pod.executionTarget === 'sandbox' && podRepo.sandboxStartupRetries) {
      const ledger = podRepo.sandboxStartupRetries;
      const input = sandboxStartupRetryInput(pod);
      const admission = ledger.admit(
        podId,
        lifecycleGeneration,
        input.identity,
        input.bindingHash,
        [...(deps.sandboxInfrastructureRetryBackoffMs ?? [30_000])],
      );
      run.startupAdmission = { id: admission.id, started: null };
      if (Date.parse(admission.notBefore) > Date.now())
        emitStatus('Waiting for task-wide sandbox startup cooldown…');
      await waitForRetryBackoff(
        admission.notBefore,
        deps.sandboxInfrastructureRecoveryDelay ?? sleep,
        assertStartupCurrent,
      );
      assertStartupCurrent();
      ledger.start(admission.id);
      run.startupAdmission.started = performance.now();
    }
    if (launchConfig?.pim.some((selection) => selection.timing === 'startup')) {
      if (!deps.launchConfiguration?.pim)
        throw new AutopodError('PIM startup integration is unavailable', 'PIM_UNAVAILABLE', 503);
      await deps.launchConfiguration.pim.startup(podId, launchConfig);
    }
    pod = transition(podRepo.getOrThrow(podId), 'provisioning', provisioningUpdates);
    if (!launchConfig)
      podRepo.update(podId, { profileSnapshot: profileStore.get(pod.profileName) });
    if (launchConfig) {
      const credentials = executionCredentialsFor(launchConfig);
      if (credentials) profile = { ...profile, ...(await credentials.agent(launchConfig)) };
    }
    if (!pod.networkPolicyResolved) {
      const resolvedNetworkPolicy = profile.networkPolicy?.enabled
        ? (profile.networkPolicy.mode ?? 'restricted')
        : 'allow-all';
      podRepo.update(podId, { networkPolicyResolved: resolvedNetworkPolicy });
    }

    // Security scan: inspect cloned worktree for secrets / PII / prompt
    // injection before the container starts. The scanner is best-effort —
    // when not wired (older deployments / tests), we proceed silently.
    if (repoScanner && worktreePath) {
      try {
        const baseRef = `origin/${pod.baseBranch ?? profile.defaultBranch ?? 'main'}`;
        const isWorkspacePod = pod.options.agentMode === 'interactive';
        emitStatus('Running security scan…');
        const scan = await repoScanner.scan('provisioning', {
          podId,
          workdir: worktreePath,
          baseRef,
          profile,
          isWorkspacePod,
        });
        logger.info(
          {
            podId,
            decision: scan.decision,
            findings: scan.findings.length,
            filesScanned: scan.filesScanned,
            filesSkipped: scan.filesSkipped,
            scanIncomplete: scan.scanIncomplete,
          },
          'Security scan completed',
        );
        if (scan.decision === 'block') {
          throw new AutopodError(
            `Security scan blocked pod creation (${scan.findings.length} finding(s))`,
            'SECURITY_SCAN_BLOCKED',
            400,
          );
        }
        // For warn / escalate, inject the warning section so the agent sees
        // the flagged regions in its CLAUDE.md. Escalation as a true pause
        // ships in a later phase — for now the agent gets the warning
        // and an instruction to ask_human if a flagged region is relevant.
        if (scan.warningSection) {
          profile.claudeMdSections = [...profile.claudeMdSections, scan.warningSection];
        }
      } catch (err) {
        if (err instanceof AutopodError) throw err;
        // Fail open: scanner errors must not block pod creation.
        logger.warn({ err, podId }, 'Security scan errored — proceeding without scan');
      }
    }
    return {
      ...input,
      kind: 'ready' as const,
      pod,
      launchConfig,
      profile,
      providerPreflight,
      worktreePath,
      bareRepoPath,
      queuedProviderAttempt,
      isFreshContainerValidationOnly,
      isRecovery,
      isInfrastructureRecovery,
      isRework,
      reasoningEffort,
    };
  }
  return { prepareWorkspace };
}

export type WorkspacePrepared = Extract<
  Awaited<ReturnType<ReturnType<typeof createProvisioningWorkspace>['prepareWorkspace']>>,
  { kind: 'ready' }
>;
