import type {
  EffectiveLaunchConfig,
  Pod,
  ProviderAccountProvider,
  ProviderAttempt,
  ProviderFailoverTarget,
  ProviderFailureClassification,
  PublicProviderCatalog,
} from '@autopod/shared';
import { AutopodError, PROVIDER_CATALOG, PROVIDER_FAILOVER_HANDOFF_PATH } from '@autopod/shared';
import { assertLaunchAgentAccount } from '../configuration/agent-route-resolution.js';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import type { ProfileStore } from '../profiles/index.js';
import type { ProviderAccountStore } from '../provider-accounts/index.js';
import { resolveProviderAccountAuth } from '../providers/auth-resolution.js';
import type { MaxCredentialLineage, ProviderEnvResult } from '../providers/index.js';
import type { PodRepository } from './pod-repository.js';
import {
  nativeSessionId,
  profileReferenceForAttempt,
  redactedProfileSnapshot,
  resolvedReasoningEffort,
} from './provider-attempt-policy.js';
import {
  type ProviderAttemptRepository,
  ProviderAttemptSupersededError,
} from './provider-attempt-repository.js';

export interface ProviderAttemptLiveDependencies {
  providerAttemptRepo?: Pick<
    ProviderAttemptRepository,
    'getActive' | 'getActiveProfileSnapshot' | 'list' | 'open' | 'close'
  >;
  launchConfiguration?: { read(podId: string): EffectiveLaunchConfig | null };
}

export interface ProviderAttemptCaptured {
  podRepo: Pick<PodRepository, 'getOrThrow'>;
  providerAccountStore?: ProviderAccountStore;
  providerCatalog?: PublicProviderCatalog;
  profileStore: Pick<ProfileStore, 'resolveProviderFailover'>;
  executionForPod(pod: Pod): PodExecutionSettings;
  activeAgentRuns: Pick<
    Map<string, { token: symbol; providerOrdinal?: number; isCurrent?: () => boolean }>,
    'get'
  >;
}

type ProviderFailoverSelection =
  | { target: ProviderFailoverTarget; reason: null }
  | {
      target: null;
      reason:
        | { type: 'unavailable' }
        | { type: 'no_policy' }
        | { type: 'disabled' }
        | {
            type: 'exhausted';
            attemptedTargets: ProviderFailoverTarget[];
            hopsUsed: number;
            maxHops: number;
          }
        | { type: 'ineligible'; targets: ProviderFailoverTarget[] };
    };

export function createProviderAttemptContext(
  deps: ProviderAttemptLiveDependencies,
  captured: ProviderAttemptCaptured,
) {
  const {
    podRepo,
    providerAccountStore,
    providerCatalog,
    profileStore,
    executionForPod,
    activeAgentRuns,
  } = captured;
  const maxCredentialLineageByPod = new Map<string, MaxCredentialLineage>();

  function providerForAttempt(pod: Pod, profile: PodExecutionSettings): ProviderAccountProvider {
    if (pod.providerIdSnapshot) return pod.providerIdSnapshot;
    if (pod.providerAccountIdSnapshot && providerAccountStore) {
      try {
        return providerAccountStore.get(pod.providerAccountIdSnapshot).provider;
      } catch {
        // Fall through to the compatibility projection for legacy pod rows.
      }
    }
    if (profile.modelProvider) return profile.modelProvider;
    if (pod.runtime === 'codex') return 'openai';
    if (pod.runtime === 'copilot') return 'copilot';
    if (pod.runtime === 'pi') return 'pi';
    return 'anthropic';
  }

  function ensureProviderAttempt(
    pod: Pod,
    profile: PodExecutionSettings,
    requireNew = false,
  ): ProviderAttempt | null {
    const repository = deps.providerAttemptRepo;
    if (!repository) return null;
    const active = repository.getActive(pod.id);
    const profileSnapshot =
      (active && repository.getActiveProfileSnapshot(pod.id)) ??
      redactedProfileSnapshot({ ...pod, profileSnapshot: null }, profile);
    const profileReference = profileReferenceForAttempt(pod, profileSnapshot);
    const provider = providerForAttempt(
      active ? { ...pod, providerIdSnapshot: active.provider } : pod,
      profile,
    );
    if (active) {
      if (requireNew) throw new ProviderAttemptSupersededError();
      const identityMatches =
        active.provider === provider &&
        active.providerAccountId === profile.providerAccountId &&
        active.runtime === pod.runtime &&
        active.model === pod.model &&
        active.profileReference === profileReference;
      if (!identityMatches) {
        throw new Error(`Active provider attempt identity mismatch for pod ${pod.id}`);
      }
      return active;
    }
    if (
      repository.list(pod.id).length === 0 &&
      (pod.inputTokens > 0 || pod.outputTokens > 0 || pod.costUsd > 0)
    ) {
      const legacyAttempt = repository.open({
        podId: pod.id,
        provider,
        providerAccountId: profile.providerAccountId,
        runtime: pod.runtime,
        model: pod.model,
        profileReference,
        profileSnapshot,
        startedAt: pod.startedAt ?? pod.createdAt,
      });
      repository.close(pod.id, {
        expectedOrdinal: legacyAttempt.ordinal,
        nativeSessionId: nativeSessionId(pod),
        endedAt: new Date().toISOString(),
        outcome: 'completed',
        inputTokens: pod.inputTokens,
        outputTokens: pod.outputTokens,
        costUsd: pod.costUsd,
      });
    }
    return repository.open({
      podId: pod.id,
      provider,
      providerAccountId: profile.providerAccountId,
      runtime: pod.runtime,
      model: pod.model,
      profileReference,
      profileSnapshot,
    });
  }

  function rotateProviderAttemptForFreshSegment(
    pod: Pod,
    profile: PodExecutionSettings,
    hadActiveAttempt: boolean,
    expectedRunToken?: symbol,
  ): boolean {
    const repository = deps.providerAttemptRepo;
    const active = repository?.getActive(pod.id);
    if (expectedRunToken !== undefined) {
      const owner = activeAgentRuns.get(pod.id);
      if (
        owner?.token !== expectedRunToken ||
        !owner.isCurrent?.() ||
        (repository && (!active || owner.providerOrdinal !== active.ordinal))
      ) {
        throw new ProviderAttemptSupersededError();
      }
    }
    if (!repository || !active || !hadActiveAttempt) return false;
    const preceding = repository
      .list(pod.id)
      .find((attempt) => attempt.ordinal === active.ordinal - 1);
    const isUnstartedProviderContinuation =
      active.nativeSessionId === null &&
      active.inputTokens === 0 &&
      active.outputTokens === 0 &&
      active.costUsd === 0 &&
      preceding?.handoffReference === PROVIDER_FAILOVER_HANDOFF_PATH;
    if (isUnstartedProviderContinuation) return false;

    repository.close(pod.id, {
      expectedOrdinal: active.ordinal,
      nativeSessionId: active.nativeSessionId,
      outcome: 'aborted',
      inputTokens: active.inputTokens,
      outputTokens: active.outputTokens,
      costUsd: active.costUsd,
    });
    const replacement = ensureProviderAttempt(pod, profile, true);
    if (expectedRunToken !== undefined) {
      const owner = activeAgentRuns.get(pod.id);
      if (owner?.token === expectedRunToken) owner.providerOrdinal = replacement?.ordinal;
    }
    return true;
  }

  function closeProviderAttempt(
    podId: string,
    outcome: 'completed' | 'failed' | 'aborted' | 'quota_exhausted',
    classification: ProviderFailureClassification | null = null,
    handoffReference: string | null = null,
    expectedOrdinal?: number,
  ): void {
    const repository = deps.providerAttemptRepo;
    const active = repository?.getActive(podId);
    if (!repository) return;
    if (expectedOrdinal !== undefined && active?.ordinal !== expectedOrdinal)
      throw new ProviderAttemptSupersededError();
    if (!active) return;
    const pod = podRepo.getOrThrow(podId);
    repository.close(podId, {
      expectedOrdinal: expectedOrdinal ?? active.ordinal,
      nativeSessionId: nativeSessionId(pod),
      outcome,
      classification,
      inputTokens: active.inputTokens,
      outputTokens: active.outputTokens,
      costUsd: active.costUsd,
      handoffReference,
    });
  }

  function isCompatibleTarget(
    target: ProviderFailoverTarget,
    account: ReturnType<NonNullable<typeof providerAccountStore>['get']>,
  ): boolean {
    if (!account.credentials) return false;
    const catalogProvider = (providerCatalog ?? PROVIDER_CATALOG).providers.find(
      (candidate) => candidate.id === account.provider,
    );
    if (!catalogProvider) return false;
    if (catalogProvider?.implementation.kind === 'generic-pi-api') {
      return target.runtime === 'pi';
    }
    if (account.provider === 'anthropic' || account.provider === 'max') {
      return target.runtime === 'claude';
    }
    if (account.provider === 'openai' || account.provider === 'openrouter') {
      return target.runtime === 'codex';
    }
    if (account.provider === 'copilot') return target.runtime === 'copilot';
    if (account.provider === 'pi') return target.runtime === 'pi';
    if (account.provider === 'foundry') {
      return account.credentials?.provider === 'foundry' &&
        account.credentials.apiSurface === 'openai'
        ? target.runtime === 'codex'
        : target.runtime === 'claude';
    }
    return false;
  }

  function selectProviderFailoverTarget(pod: Pod): ProviderFailoverSelection {
    if (!providerAccountStore || !deps.providerAttemptRepo) {
      return { target: null, reason: { type: 'unavailable' } };
    }
    const resolved = profileStore.resolveProviderFailover(pod.profileName);
    const policy = resolved.policy;
    if (!policy) return { target: null, reason: { type: 'no_policy' } };
    if (policy.targets.length === 0) return { target: null, reason: { type: 'disabled' } };
    const attempts = deps.providerAttemptRepo.list(pod.id);
    const used = new Set(
      attempts.map(
        (attempt) => `${attempt.providerAccountId ?? ''}\0${attempt.runtime}\0${attempt.model}`,
      ),
    );
    const maxHops = Math.min(policy.maxHops ?? policy.targets.length, policy.targets.length);
    const attemptedTargets = policy.targets.filter((target) =>
      attempts.some(
        (attempt) =>
          attempt.providerAccountId === target.providerAccountId &&
          attempt.runtime === target.runtime &&
          attempt.model === target.model,
      ),
    );
    if (attemptedTargets.length >= maxHops) {
      return {
        target: null,
        reason: {
          type: 'exhausted',
          attemptedTargets,
          hopsUsed: attemptedTargets.length,
          maxHops,
        },
      };
    }
    const ineligibleTargets: ProviderFailoverTarget[] = [];
    for (const target of policy.targets) {
      const key = `${target.providerAccountId}\0${target.runtime}\0${target.model}`;
      if (used.has(key)) continue;
      try {
        const account = providerAccountStore.get(target.providerAccountId);
        if (isCompatibleTarget(target, account)) return { target, reason: null };
        ineligibleTargets.push(target);
      } catch {
        // Deleted, unauthenticated, or otherwise ineligible targets fail closed.
        ineligibleTargets.push(target);
      }
    }
    return { target: null, reason: { type: 'ineligible', targets: ineligibleTargets } };
  }

  function escapeProviderTargetDiagnosticValue(value: string, fallback: string): string {
    const normalized = value.trim().slice(0, 256);
    if (!normalized) return fallback;
    return normalized.replace(
      /[^A-Za-z0-9._:/@+-]/gu,
      (character) => `\\u{${character.codePointAt(0)?.toString(16) ?? 'fffd'}}`,
    );
  }

  function describeProviderFailoverTarget(target: ProviderFailoverTarget): string {
    const account = escapeProviderTargetDiagnosticValue(
      target.providerAccountId,
      'unknown-account',
    );
    const runtime = escapeProviderTargetDiagnosticValue(target.runtime, 'unknown-runtime');
    const model = escapeProviderTargetDiagnosticValue(target.model, 'unknown-model');
    return `account=${account} runtime=${runtime} model=${model}`;
  }

  function providerFailoverUnavailableActivity(selection: ProviderFailoverSelection): string {
    if (selection.target) throw new Error('Selected provider target does not need a diagnostic');
    switch (selection.reason.type) {
      case 'no_policy':
        return 'Provider limit reached — automatic failover has no configured policy';
      case 'disabled':
        return 'Provider limit reached — automatic failover is explicitly disabled';
      case 'exhausted': {
        const targets = selection.reason.attemptedTargets
          .map(describeProviderFailoverTarget)
          .join(', ');
        return (
          `Provider limit reached — automatic failover exhausted ${targets}; ` +
          `${selection.reason.hopsUsed}/${selection.reason.maxHops} hops used`
        );
      }
      case 'ineligible': {
        const targets = selection.reason.targets.map(describeProviderFailoverTarget).join(', ');
        return `Provider limit reached — configured automatic targets are ineligible: ${targets}`;
      }
      case 'unavailable':
        return 'Provider limit reached — automatic failover infrastructure is unavailable';
    }
  }

  function profileForProviderTarget(
    profile: PodExecutionSettings,
    target: ProviderFailoverTarget,
  ): PodExecutionSettings {
    if (!providerAccountStore) throw new Error('Provider account store is unavailable');
    const account = providerAccountStore.get(target.providerAccountId);
    if (!isCompatibleTarget(target, account)) {
      throw new AutopodError(
        'Selected provider target is not eligible',
        'INVALID_PROVIDER_TARGET',
        409,
      );
    }
    const auth = resolveProviderAccountAuth(target.providerAccountId, {
      providerAccountStore,
      providerCatalog,
    });
    if (!auth.provider)
      throw new AutopodError(
        'Selected provider target has no adapter',
        'INVALID_PROVIDER_TARGET',
        409,
      );
    return {
      ...profile,
      providerAccountId: target.providerAccountId,
      modelProvider: auth.provider,
      defaultRuntime: target.runtime,
      defaultModel: target.model,
    };
  }

  function resolveEffectiveBoundProfile(pod: Pod): PodExecutionSettings {
    const profile = executionForPod(pod);
    const launch = deps.launchConfiguration?.read(pod.id);
    if (launch) {
      const target = [launch.ai.main, ...launch.ai.main.failover].find(
        (route) =>
          route.providerAccountId === pod.providerAccountIdSnapshot &&
          route.runtime === pod.runtime &&
          route.model === pod.model,
      );
      if (!target || !providerAccountStore)
        throw new AutopodError(
          'Main agent route is outside the saved launch configuration',
          'PROVIDER_BINDING_MISMATCH',
          409,
        );
      assertLaunchAgentAccount(
        { ...target, failover: [], maxHops: 0 },
        launch.agentAccounts[target.providerAccountId],
        providerAccountStore,
        providerCatalog,
      );
    }
    const repository = deps.providerAttemptRepo;
    const activeAttempt = repository?.getActive(pod.id);
    if (activeAttempt) {
      if (activeAttempt.runtime !== pod.runtime || activeAttempt.model !== pod.model) {
        throw new Error(`Active provider attempt identity mismatch for pod ${pod.id}`);
      }
    }

    const latestAttempt = repository?.list(pod.id).at(-1);
    if (
      !activeAttempt &&
      latestAttempt &&
      (latestAttempt.providerAccountId !== pod.providerAccountIdSnapshot ||
        latestAttempt.provider !== pod.providerIdSnapshot ||
        latestAttempt.runtime !== pod.runtime ||
        latestAttempt.model !== pod.model)
    ) {
      throw new AutopodError(
        'Selected provider binding does not match the latest provider attempt',
        'INVALID_PROVIDER_TARGET',
        409,
      );
    }
    const boundAttempt = activeAttempt ?? latestAttempt;
    // Before the first attempt, the creation snapshot is the authority. Editing
    // a shared profile must not move already queued work to a different account.
    if (!boundAttempt && pod.providerAccountIdSnapshot) {
      let account: ReturnType<ProviderAccountStore['get']> | undefined;
      try {
        account = providerAccountStore?.get(pod.providerAccountIdSnapshot);
      } catch {
        // Convert deleted-account lookup failures into an actionable binding error.
      }
      if (!account || account.provider !== pod.providerIdSnapshot) {
        throw new AutopodError(
          'Queued provider account is unavailable or its provider identity changed; restore the authorized account or explicitly select a new target before retrying',
          'INVALID_PROVIDER_TARGET',
          409,
        );
      }
      return profileForProviderTarget(profile, {
        providerAccountId: pod.providerAccountIdSnapshot,
        runtime: pod.runtime,
        model: pod.model,
      });
    }
    if (!boundAttempt?.providerAccountId) {
      const hasUnreconciledBinding =
        (pod.providerAccountIdSnapshot !== null &&
          pod.providerAccountIdSnapshot !== profile.providerAccountId) ||
        (pod.providerIdSnapshot !== null &&
          profile.modelProvider !== undefined &&
          pod.providerIdSnapshot !== profile.modelProvider);
      if (hasUnreconciledBinding) {
        throw new AutopodError(
          'Selected provider binding cannot be reconciled with provider attempt history',
          'INVALID_PROVIDER_TARGET',
          409,
        );
      }
      return profile;
    }

    const account = providerAccountStore?.get(boundAttempt.providerAccountId);
    if (!account || account.provider !== boundAttempt.provider) {
      throw new AutopodError(
        'Selected provider target identity no longer matches its provider account',
        'INVALID_PROVIDER_TARGET',
        409,
      );
    }
    return profileForProviderTarget(profile, {
      providerAccountId: boundAttempt.providerAccountId,
      runtime: boundAttempt.runtime,
      model: boundAttempt.model,
    });
  }

  function openProviderTargetAttempt(pod: Pod, target: ProviderFailoverTarget): void {
    const repository = deps.providerAttemptRepo;
    if (!repository) throw new Error('Provider attempt repository is unavailable');
    const currentProfile = executionForPod(pod);
    const profile = profileForProviderTarget(
      {
        ...currentProfile,
        reasoningEffort: resolvedReasoningEffort(
          currentProfile,
          pod.profileSnapshot as unknown as Record<string, unknown> | null,
        ),
      },
      target,
    );
    const targetProvider = providerAccountStore?.get(target.providerAccountId).provider ?? null;
    const projectedPod = {
      ...pod,
      runtime: target.runtime,
      model: target.model,
      providerAccountIdSnapshot: target.providerAccountId,
      providerIdSnapshot: targetProvider,
      profileSnapshot: null,
    };
    const snapshot = redactedProfileSnapshot(projectedPod, profile);
    repository.open({
      podId: pod.id,
      provider: providerForAttempt(projectedPod, profile),
      providerAccountId: target.providerAccountId,
      runtime: target.runtime,
      model: target.model,
      profileReference: profileReferenceForAttempt(projectedPod, snapshot),
      profileSnapshot: snapshot,
    });
  }

  function rememberMaxCredentialLineage(podId: string, result: ProviderEnvResult): void {
    if (result.maxCredentialLineage) {
      maxCredentialLineageByPod.set(podId, result.maxCredentialLineage);
    } else {
      maxCredentialLineageByPod.delete(podId);
    }
  }

  function forgetMaxCredentialLineage(podId: string): void {
    maxCredentialLineageByPod.delete(podId);
  }

  return {
    providerForAttempt,
    ensureProviderAttempt,
    rotateProviderAttemptForFreshSegment,
    closeProviderAttempt,
    isCompatibleTarget,
    selectProviderFailoverTarget,
    escapeProviderTargetDiagnosticValue,
    describeProviderFailoverTarget,
    providerFailoverUnavailableActivity,
    profileForProviderTarget,
    resolveEffectiveBoundProfile,
    openProviderTargetAttempt,
    rememberMaxCredentialLineage,
    forgetMaxCredentialLineage,
    maxCredentialLineageByPod,
  };
}
