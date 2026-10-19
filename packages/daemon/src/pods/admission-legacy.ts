import type { CreatePodRequest, OperatorActor, Pod } from '@autopod/shared';
import {
  AutopodError,
  generatePodId,
  outputModeFromPodOptions,
  podOptionsFromOutputMode,
  resolvePodOptions,
} from '@autopod/shared';
import { getAutoAttachedSidecars, resolveSidecarSpec } from '../containers/sidecar-resolver.js';
import { assertNoExpiredPat } from '../profiles/pat-expiry.js';
import type {
  AdmissionLegacyCaptured,
  AdmissionLegacyLiveDependencies,
} from './admission-contracts.js';
import { dispatchRequestHash } from './dispatch-preflight-ledger.js';
import { type PreflightConflict, findPreflightConflicts } from './preflight.js';
import { resolveProviderPreflight } from './provider-preflight.js';
import { isAcrQualifiedImage } from './provisioning-image-policy.js';
import { deriveReferenceRepos } from './reference-repos.js';
import type { PodCreator } from './workspace-contracts.js';
export function createAdmissionLegacy(
  deps: AdmissionLegacyLiveDependencies,
  captured: AdmissionLegacyCaptured,
) {
  const {
    podRepo,
    profileStore,
    providerAccountStore,
    providerCatalog,
    containerManagerFactory,
    assertSandboxAgentStreamingExecSupported,
    executionForPod,
    logger,
    eventBus,
    enqueueSession,
  } = captured;
  function createSession(
    request: CreatePodRequest,
    userId: string,
    creator?: PodCreator,
    actor?: OperatorActor,
  ): Pod {
    if (deps.launchConfiguration)
      throw new AutopodError(
        'This daemon requires a resolved repository launch; upgrade the caller to the configuration API',
        'CONFIG_API_VERSION_UNSUPPORTED',
        410,
      );
    if (request.intentionalRerun && (actor?.type !== 'human' || actor.userId !== userId))
      throw new AutopodError(
        'Intentional rerun requires an authenticated human decision',
        'UNAUTHORIZED_RERUN',
        403,
      );
    if (request.intentionalRerun) {
      if (!podRepo.dispatchPreflight)
        throw new AutopodError('Durable rerun admission unavailable', 'RERUN_UNAVAILABLE', 503);
      const existing = podRepo.dispatchPreflight.findRerun(request, userId);
      if (existing) return podRepo.getOrThrow(existing);
    }
    const profile = profileStore.get(request.profileName);
    assertNoExpiredPat(profile);
    const providerPreflight = resolveProviderPreflight(profile, request.runtime, request.model, {
      profileStore,
      providerAccountStore,
      manifest: providerCatalog,
    });
    const { runtime, model } = providerPreflight;
    const executionTarget = request.executionTarget ?? profile.executionTarget ?? 'local';
    const skipValidation = request.skipValidation ?? false;
    const normalizedDependsOnPodIds =
      request.dependsOnPodIds && request.dependsOnPodIds.length > 0
        ? request.dependsOnPodIds
        : request.dependsOnPodId
          ? [request.dependsOnPodId]
          : null;
    const singlePrSeriesParent =
      request.prMode === 'single' && request.seriesId && normalizedDependsOnPodIds?.[0]
        ? podRepo.getOrThrow(normalizedDependsOnPodIds[0])
        : null;
    if (
      singlePrSeriesParent &&
      request.branch !== undefined &&
      request.branch !== singlePrSeriesParent.branch
    ) {
      throw new AutopodError(
        `Single-PR series dependent must use parent branch '${singlePrSeriesParent.branch}' (got '${request.branch}')`,
        'INVALID_CONFIGURATION',
        400,
      );
    }
    const effectiveBaseBranch =
      request.baseBranch ?? singlePrSeriesParent?.baseBranch ?? profile.defaultBranch ?? 'main';
    const effectiveStartBranch =
      request.startBranch ?? singlePrSeriesParent?.startBranch ?? effectiveBaseBranch;

    // Resolve the effective PodOptions once, so both branch derivation and
    // DB insertion use the exact same values.
    const resolvedPod = resolvePodOptions(
      profile.pod ?? (profile.outputMode ? podOptionsFromOutputMode(profile.outputMode) : null),
      request.options ??
        (request.outputMode ? podOptionsFromOutputMode(request.outputMode) : undefined),
    );
    if (
      skipValidation &&
      request.options?.validationSuite &&
      request.options.validationSuite !== 'off'
    ) {
      throw new AutopodError(
        `skipValidation cannot be combined with validationSuite='${request.options.validationSuite}'`,
        'INVALID_CONFIGURATION',
        400,
      );
    }
    if (skipValidation) {
      resolvedPod.validate = false;
      resolvedPod.validationSuite = 'off';
    }
    if (resolvedPod.agentMode === 'interactive' && executionTarget !== 'local') {
      const interactiveCm = containerManagerFactory.get(executionTarget);
      if (!interactiveCm.attachTerminal) {
        throw new AutopodError(
          `Interactive pods on execution target '${executionTarget}' require a container backend with interactive terminal support (attachTerminal)`,
          'INVALID_CONFIGURATION',
          400,
        );
      }
    }
    if (executionTarget === 'sandbox') {
      if (!profile.warmImageTag) {
        throw new AutopodError(
          `Sandbox execution for profile "${profile.name}" requires a warm image. Run \`ap profile warm ${profile.name} --rebuild\` with ACR_REGISTRY_URL configured first.`,
          'SANDBOX_WARM_IMAGE_REQUIRED',
          400,
        );
      }
      if (!isAcrQualifiedImage(profile.warmImageTag)) {
        throw new AutopodError(
          `Sandbox warm image for profile "${profile.name}" must be an ACR-qualified image tag, got "${profile.warmImageTag}". Rebuild the warm image with ACR_REGISTRY_URL so profile.warmImageTag is stored as <registry>.azurecr.io/...`,
          'SANDBOX_WARM_IMAGE_REQUIRED',
          400,
        );
      }
    }
    assertSandboxAgentStreamingExecSupported(profile, executionTarget, resolvedPod);

    // deny-all network policy blocks all outbound — incompatible with cloud-backed runtimes.
    // Interactive pods run without an AI agent, so they're unaffected.
    if (
      resolvedPod.agentMode !== 'interactive' &&
      profile.networkPolicy?.enabled &&
      profile.networkPolicy?.mode === 'deny-all'
    ) {
      throw new AutopodError(
        `Network policy 'deny-all' blocks all outbound traffic, but runtime '${runtime}' requires API access. Use 'restricted' mode instead — the default allowlist includes the model API.`,
        'INVALID_CONFIGURATION',
        400,
      );
    }

    // Validate requireSidecars against the pod's profile at create time so
    // typos and missing configs fail fast instead of silently no-oping at
    // spawn. Privileged sidecars additionally require `trustedSource:true`.
    //
    // Auto-attach sidecars that the profile has enabled + trusted (currently
    // just Dagger). Profiles can opt out per child via inheritance — sub-
    // profiles set `sidecars.dagger.enabled:false` or `trustedSource:false`.
    // Auto-attach is unioned with the explicit request so CLI/brief-level
    // opt-in still works for sidecars not auto-attached.
    const autoAttached = getAutoAttachedSidecars(profile);
    const requestedSidecars = request.requireSidecars ?? [];
    const requireSidecars = Array.from(new Set([...autoAttached, ...requestedSidecars]));
    if (executionTarget === 'sandbox' && requireSidecars.length > 0) {
      throw new AutopodError(
        `Sidecars are not supported for sandbox execution yet (requested: ${requireSidecars.join(', ')}). Azure Sandboxes do not provide the Docker bridge network sidecars require.`,
        'UNSUPPORTED_SANDBOX_SIDECAR',
        400,
      );
    }
    for (const name of requireSidecars) {
      const spec = resolveSidecarSpec(profile, name);
      if (!spec) {
        throw new AutopodError(
          `Pod requested sidecar '${name}' but profile '${profile.name}' has no matching enabled config`,
          'INVALID_SIDECAR',
          400,
        );
      }
      if (spec.privileged === true && profile.trustedSource !== true) {
        throw new AutopodError(
          `Sidecar '${name}' runs privileged; profile '${profile.name}' must have trustedSource:true to enable it`,
          'UNTRUSTED_PROFILE',
          403,
        );
      }
    }

    const derivedReferenceRepos = deriveReferenceRepos(request.referenceRepos);

    // Preflight overlap check: does this pod's `touches` scope overlap with
    // any in-flight pod on the same repo + base? Computed BEFORE insert so
    // the `block` policy refuses cleanly without leaving a half-created row.
    // The `warn` path keeps the result and emits an event after the row
    // exists (so it carries the new pod's ID).
    let preflightConflicts: PreflightConflict[] = [];
    const candidateTouches = request.touches ?? [];
    if (candidateTouches.length > 0) {
      try {
        const candidateRepoUrl = profile.repoUrl ?? null;
        const candidates = podRepo.listNonTerminal().map((p) => ({
          pod: p,
          repoUrl: executionForPod(p).repoUrl ?? null,
        }));
        preflightConflicts = findPreflightConflicts(
          {
            touches: candidateTouches,
            repoUrl: candidateRepoUrl,
            baseBranch: effectiveBaseBranch,
          },
          candidates,
        );
      } catch (err) {
        // Best-effort: a failure inside the check itself must not block pod
        // creation, so swallow and treat as "no conflicts found".
        logger.debug({ err }, 'Preflight overlap check failed — treating as no conflicts');
        preflightConflicts = [];
      }

      if (preflightConflicts.length > 0 && profile.preflightConflictPolicy === 'block') {
        const ids = preflightConflicts.map((c) => c.conflictingPodId).join(', ');
        throw new AutopodError(
          `Pod creation blocked by profile.preflightConflictPolicy='block': touches scope overlaps in-flight pods [${ids}]`,
          'PREFLIGHT_CONFLICT',
          409,
        );
      }
    }

    let id: string;
    for (let attempt = 0; attempt < 10; attempt++) {
      id = generatePodId();
      const effectiveOutputMode = outputModeFromPodOptions(resolvedPod);
      let branch: string;
      if (request.branch) {
        branch = request.branch;
      } else if (singlePrSeriesParent) {
        branch = singlePrSeriesParent.branch;
      } else if (resolvedPod.output === 'artifact') {
        branch = `research/${id}`;
      } else {
        const prefix = request.branchPrefix ?? profile.branchPrefix ?? 'autopod/';
        branch = `${prefix}${id}`;
      }
      // Workspace pods must not land on the default branch — `ap complete` would push
      // directly to origin/main. Auto-generate a safe branch unless this pod was spawned
      // by fixManually() (linkedPodId set), which intentionally inherits the worker's branch.
      if (resolvedPod.agentMode === 'interactive' && !request.linkedPodId) {
        if (branch === effectiveBaseBranch) {
          const prefix = request.branchPrefix ?? profile.branchPrefix ?? 'autopod/';
          branch = `${prefix}${id}`;
        }
      }
      try {
        podRepo.insert({
          id,
          profileName: request.profileName,
          task: request.task,
          status: 'queued',
          model,
          runtime,
          providerAccountIdSnapshot: providerPreflight.account?.id ?? null,
          providerIdSnapshot:
            providerPreflight.manifestProvider?.id ??
            providerPreflight.account?.provider ??
            profile.modelProvider ??
            null,
          executionTarget,
          branch,
          userId,
          creatorEmail: creator?.email ?? null,
          creatorName: creator?.name ?? null,
          maxValidationAttempts: profile.maxValidationAttempts ?? 3,
          skipValidation,
          contract: request.contract ?? null,
          intentionalRerun: request.intentionalRerun,
          dispatchRepository: profile.repoUrl,
          rerunRequestHash: request.intentionalRerun ? dispatchRequestHash(request) : undefined,
          options: resolvedPod,
          outputMode: effectiveOutputMode,
          startBranch: effectiveStartBranch !== effectiveBaseBranch ? effectiveStartBranch : null,
          baseBranch: effectiveBaseBranch,
          // Persist durable handoff instructions immediately so they survive
          // independently of the originating Pi session and are visible on the
          // pod the moment it is created. Trimmed (schema already rejects empty).
          handoffInstructions: request.handoffInstructions?.trim() || null,
          specFiles: request.specFiles && request.specFiles.length > 0 ? request.specFiles : null,
          specContextFiles:
            request.specContextFiles && request.specContextFiles.length > 0
              ? request.specContextFiles
              : null,
          linkedPodId: request.linkedPodId ?? null,
          pimGroups: (() => {
            if (request.pimGroups != null) return request.pimGroups;
            // Fall back to profile-level pimActivations (group type only — stored as PimGroupConfig)
            const groupActivations = (profile.pimActivations ?? [])
              .filter((a): a is Extract<typeof a, { type: 'group' }> => a.type === 'group')
              .map(({ groupId, displayName, duration, justification }) => ({
                groupId,
                displayName,
                duration,
                justification,
              }));
            return groupActivations.length > 0 ? groupActivations : null;
          })(),
          prUrl: request.prUrl ?? null,
          tokenBudget:
            request.tokenBudget !== undefined ? request.tokenBudget : (profile.tokenBudget ?? null),
          referenceRepos: derivedReferenceRepos.length > 0 ? derivedReferenceRepos : null,
          scheduledJobId: request.scheduledJobId ?? null,
          dependsOnPodIds: normalizedDependsOnPodIds,
          dependsOnPodId: request.dependsOnPodId ?? null,
          seriesId: request.seriesId ?? null,
          seriesName: request.seriesName ?? null,
          seriesDescription: request.seriesDescription ?? null,
          seriesDesign: request.seriesDesign ?? null,
          briefTitle: request.briefTitle ?? null,
          touches: request.touches && request.touches.length > 0 ? request.touches : null,
          doesNotTouch:
            request.doesNotTouch && request.doesNotTouch.length > 0 ? request.doesNotTouch : null,
          prMode: request.prMode ?? null,
          waitForMerge: request.waitForMerge ?? false,
          requireSidecars: requireSidecars.length > 0 ? requireSidecars : null,
          autoApprove: request.autoApprove ?? false,
          disableAskHuman: request.disableAskHuman ?? false,
        });
        break;
      } catch (err: unknown) {
        if (
          err instanceof Error &&
          err.message.includes('UNIQUE constraint failed') &&
          attempt < 9
        ) {
          continue;
        }
        throw err;
      }
    }
    // biome-ignore lint/style/noNonNullAssertion: id is guaranteed non-null after the retry loop above
    id = id!;

    const pod = podRepo.getOrThrow(id);

    const publishCommittedPod = () => {
      eventBus.emit({
        type: 'pod.created',
        timestamp: new Date().toISOString(),
        pod: {
          id: pod.id,
          profileName: pod.profileName,
          task: pod.task,
          status: pod.status,
          model: pod.model,
          runtime: pod.runtime,
          branch: pod.branch,
          baseBranch: pod.baseBranch,
          duration: null,
          filesChanged: pod.filesChanged,
          createdAt: pod.createdAt,
        },
      });

      // Emit the preflight overlap warning (computed before insert above) now
      // that the new pod has an ID. The `block` policy already short-circuited
      // earlier; reaching this point means the policy is `warn` or unset.
      if (preflightConflicts.length > 0) {
        eventBus.emit({
          type: 'pod.preflight_overlap',
          timestamp: new Date().toISOString(),
          podId: id,
          conflicts: preflightConflicts.map((c) => ({
            conflictingPodId: c.conflictingPodId,
            conflictingPodTask: c.conflictingPodTask,
            conflictingPodStatus: c.conflictingPodStatus,
            overlappingGlobs: c.overlappingGlobs,
          })),
        });
        logger.warn(
          {
            podId: id,
            conflictingPodIds: preflightConflicts.map((c) => c.conflictingPodId),
          },
          'Pod created with preflight overlap on in-flight pods — possible merge conflict',
        );
      }

      // Dependent pods must not start until their predecessors reach `validated`;
      // maybeTriggerDependents() will enqueue them at that point. A pod counts
      // as dependent if either the new multi-parent array or the legacy single
      // field is populated.
      const hasDeps = (request.dependsOnPodIds?.length ?? 0) > 0 || !!request.dependsOnPodId;
      if (!hasDeps) {
        enqueueSession(id);
      }
      logger.info(
        {
          podId: id,
          profile: request.profileName,
          branch: pod.branch,
          baseBranch: pod.baseBranch,
          startBranch: pod.startBranch,
        },
        'Pod created',
      );
    };
    if (podRepo.afterInsertCommitted) podRepo.afterInsertCommitted(pod.id, publishCommittedPod);
    else publishCommittedPod();
    return pod;
  }
  return { createSession };
}
