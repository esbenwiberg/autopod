import {
  AutopodError,
  type EffectiveLaunchConfig,
  type Pod,
  type ProviderCredentials,
  type PublicProviderCatalog,
} from '@autopod/shared';
import type { Logger } from 'pino';
import { assertLaunchAgentAccount } from '../configuration/agent-route-resolution.js';
import type { ContainerManager } from '../interfaces/container-manager.js';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import type { ReviewerExecutor } from '../interfaces/reviewer-executor.js';
import type { ProfileStore } from '../profiles/index.js';
import type { ProviderAccountStore } from '../provider-accounts/index.js';
import {
  buildProviderEnv,
  persistOpenAiAuthJson,
  persistPiAuthJson,
  persistRefreshedCredentials,
} from '../providers/index.js';
import type { MaxCredentialLineage } from '../providers/index.js';
import type { IsolatedReviewer } from '../validation/isolated-reviewer.js';
import type { ProviderAttemptRepository } from './provider-attempt-repository.js';
import { resolveEffectiveReviewerProfile } from './runtime-resolver.js';

interface ReviewerContextLiveDependencies {
  launchConfiguration?: {
    read(podId: string): EffectiveLaunchConfig | null;
    reviewer?: Pick<IsolatedReviewer, 'executor'>;
  };
  providerAttemptRepo?: Pick<ProviderAttemptRepository, 'list'>;
}
interface ReviewerContextCapturedDependencies {
  providerAccountStore?: ProviderAccountStore;
  providerCatalog?: PublicProviderCatalog;
  profileStore: ProfileStore;
  containerManagerFactory: { get(target: Pod['executionTarget']): ContainerManager };
  logger: Logger;
  maxCredentialLineageByPod: Pick<Map<string, MaxCredentialLineage>, 'get'>;
  executionForPod(pod: Pod): PodExecutionSettings;
  resolveEffectiveBoundProfile(pod: Pod): PodExecutionSettings;
}

export function createReviewerContext(
  deps: ReviewerContextLiveDependencies,
  captured: ReviewerContextCapturedDependencies,
): {
  buildReviewerExecEnv(pod: Pod): Promise<Record<string, string> | undefined>;
  getEffectiveReviewerConfig(
    pod: Pod,
    role?: 'reviewer' | 'advisor',
  ): {
    profile: PodExecutionSettings;
    credentials: ProviderCredentials | null;
  };
  getReviewerExecutor(
    pod: Pod,
    purpose?: 'review' | 'memory',
    role?: 'reviewer' | 'advisor',
  ): ReviewerExecutor | undefined;
} {
  const {
    providerAccountStore,
    providerCatalog,
    profileStore,
    containerManagerFactory,
    logger,
    maxCredentialLineageByPod,
    executionForPod,
    resolveEffectiveBoundProfile,
  } = captured;

  async function buildReviewerExecEnv(pod: Pod): Promise<Record<string, string> | undefined> {
    if (pod.launchConfigDigest) {
      getReviewerExecutor(pod);
      return undefined;
    }
    let { profile: reviewerProfile, credentials: currentCredentials } =
      getEffectiveReviewerConfig(pod);
    const provider = reviewerProfile.modelProvider;
    const launch = deps.launchConfiguration?.read(pod.id);
    if (launch?.ai.reviewer.mode === 'independent')
      throw new AutopodError(
        'Independent review requires the isolated reviewer execution context',
        'REVIEWER_ISOLATION_REQUIRED',
        503,
      );
    if (
      provider !== 'max' &&
      provider !== 'foundry' &&
      provider !== 'openai' &&
      provider !== 'pi'
    ) {
      return undefined;
    }

    if (pod.containerId && (provider === 'max' || provider === 'openai' || provider === 'pi')) {
      const cm = containerManagerFactory.get(pod.executionTarget);
      const owner = pod.providerAccountIdSnapshot
        ? ({ type: 'provider-account', id: pod.providerAccountIdSnapshot } as const)
        : undefined;
      try {
        if (provider === 'max') {
          await persistRefreshedCredentials(
            pod.containerId,
            cm,
            profileStore,
            reviewerProfile.name,
            logger,
            maxCredentialLineageByPod.get(pod.id),
            { providerAccountStore, owner },
          );
        } else if (provider === 'openai') {
          await persistOpenAiAuthJson(
            pod.containerId,
            cm,
            profileStore,
            reviewerProfile.name,
            logger,
            { providerAccountStore, owner },
          );
        } else {
          await persistPiAuthJson(pod.containerId, cm, profileStore, reviewerProfile.name, logger, {
            providerAccountStore,
            owner,
          });
        }
      } catch (err) {
        logger.warn(
          { err, podId: pod.id, provider },
          'Could not recover credentials from container before reviewer call',
        );
      }
      ({ profile: reviewerProfile, credentials: currentCredentials } =
        getEffectiveReviewerConfig(pod));
    }

    const result = await buildProviderEnv(
      {
        ...reviewerProfile,
        providerCredentials: currentCredentials ?? null,
      },
      pod.id,
      logger,
      {
        profileStore,
        providerAccountStore,
        providerCatalog,
        runtime: pod.runtime,
        ...(pod.providerIdSnapshot
          ? {
              providerBinding: {
                accountId: pod.providerAccountIdSnapshot,
                providerId: pod.providerIdSnapshot,
              },
            }
          : {}),
      },
    );
    if (pod.containerId) {
      const cm = containerManagerFactory.get(pod.executionTarget);
      for (const file of result.containerFiles) {
        await cm.writeFile(pod.containerId, file.path, file.content);
      }
      for (const file of result.secretFiles) {
        await cm.writeFile(pod.containerId, file.path, file.content);
        await cm.execInContainer(pod.containerId, ['chmod', '0400', file.path], {
          timeout: 5_000,
        });
      }
    }
    return { POD_ID: pod.id, ...result.env };
  }

  function getEffectiveReviewerConfig(
    pod: Pod,
    role: 'reviewer' | 'advisor' = 'reviewer',
  ): {
    profile: PodExecutionSettings;
    credentials: ProviderCredentials | null;
  } {
    const launch = deps.launchConfiguration?.read(pod.id);
    if (launch) {
      const selected = selectedRoute(launch, role);
      if (selected.mode === 'independent') {
        const route = selected.route;
        if (!providerAccountStore)
          throw new AutopodError(
            'Provider account storage is unavailable',
            'PROVIDER_ACCOUNT_STORE_MISSING',
            503,
          );
        const account = assertLaunchAgentAccount(
          route,
          launch.agentAccounts[route.providerAccountId],
          providerAccountStore,
          providerCatalog,
        );
        const credentials = providerAccountStore.get(route.providerAccountId).credentials;
        const profile = {
          ...executionForPod(pod),
          modelProvider: account.adapter,
          providerAccountId: account.accountId,
          providerCredentials: credentials,
          defaultRuntime: route.runtime,
          defaultModel: route.model,
          reviewerModel: route.model,
          reasoningEffort: route.reasoningEffort,
          providerFailover: { targets: route.failover, maxHops: route.maxHops },
        };
        return { profile, credentials };
      }
      const profile = resolveEffectiveBoundProfile(pod);
      const credentials = profile.providerAccountId
        ? (providerAccountStore?.get(profile.providerAccountId).credentials ?? null)
        : null;
      return { profile: { ...profile, reviewerModel: profile.defaultModel }, credentials };
    }
    const hasProviderAttemptHistory = (deps.providerAttemptRepo?.list(pod.id).length ?? 0) > 0;
    const profile = hasProviderAttemptHistory
      ? resolveEffectiveBoundProfile(pod)
      : resolveEffectiveReviewerProfile(pod, executionForPod(pod));
    const credentials = profile.providerAccountId
      ? (providerAccountStore?.get(profile.providerAccountId).credentials ?? null)
      : profile.providerCredentials;
    if (pod.launchConfigDigest && !credentials)
      throw new AutopodError(
        'The selected provider account is not authenticated',
        'PROVIDER_CREDENTIALS_MISSING',
        409,
      );
    return { profile, credentials };
  }

  function getReviewerExecutor(
    pod: Pod,
    purpose: 'review' | 'memory' = 'review',
    role: 'reviewer' | 'advisor' = 'reviewer',
  ): import('../interfaces/reviewer-executor.js').ReviewerExecutor | undefined {
    if (!pod.launchConfigDigest) return undefined;
    const launch = deps.launchConfiguration?.read(pod.id);
    const reviewer = deps.launchConfiguration?.reviewer;
    if (!launch || !reviewer)
      throw new AutopodError(
        'Isolated reviewer execution is unavailable',
        'REVIEWER_ISOLATION_REQUIRED',
        503,
      );
    const profile = getEffectiveReviewerConfig(pod, role).profile;
    const selection = selectedRoute(launch, role);
    const selected = selection.mode === 'independent' ? selection.route : launch.ai.main;
    const route =
      selection.mode === 'independent'
        ? selected
        : {
            ...selected,
            providerAccountId: profile.providerAccountId ?? selected.providerAccountId,
            runtime: profile.defaultRuntime ?? selected.runtime,
            model: profile.defaultModel ?? selected.model,
            reasoningEffort: profile.reasoningEffort ?? selected.reasoningEffort,
          };
    return reviewer.executor(pod, launch, route, role === 'advisor' ? 'advisor' : purpose);
  }

  function selectedRoute(launch: EffectiveLaunchConfig, role: 'reviewer' | 'advisor') {
    const advisor = launch.ai.advisor;
    return role === 'advisor' && advisor && advisor.mode !== 'follow-reviewer'
      ? advisor
      : launch.ai.reviewer;
  }

  return { buildReviewerExecEnv, getEffectiveReviewerConfig, getReviewerExecutor };
}
