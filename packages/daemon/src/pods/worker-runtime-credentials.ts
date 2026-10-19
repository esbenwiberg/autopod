import type { EffectiveLaunchConfig, Pod, PublicProviderCatalog } from '@autopod/shared';
import type { Logger } from 'pino';
import type { ContainerManager } from '../interfaces/container-manager.js';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import type { ProfileStore } from '../profiles/index.js';
import type { ProviderAccountStore } from '../provider-accounts/index.js';
import {
  buildProviderEnv,
  persistOpenAiAuthJson,
  persistPiAuthJson,
  persistRefreshedCredentials,
} from '../providers/index.js';
import type { MaxCredentialLineage, ProviderEnvResult } from '../providers/index.js';
import type { PodRepository } from './pod-repository.js';

interface WorkerRuntimeCredentialLiveDependencies {
  launchConfiguration?: {
    read(podId: string): EffectiveLaunchConfig | null;
    assertCurrentCapabilities(config: EffectiveLaunchConfig): Promise<void>;
  };
}
interface WorkerRuntimeCredentialCapturedDependencies {
  podRepo: Pick<PodRepository, 'getOrThrow'>;
  providerAccountStore?: ProviderAccountStore;
  providerCatalog?: PublicProviderCatalog;
  profileStore: ProfileStore;
  containerManagerFactory: { get(target: Pod['executionTarget']): ContainerManager };
  logger: Logger;
  maxCredentialLineageByPod: Pick<Map<string, MaxCredentialLineage>, 'get'>;
  resolveEffectiveBoundProfile(pod: Pod): PodExecutionSettings;
  validationEnvironmentForPod(
    pod: Pod,
    profile: PodExecutionSettings,
  ): Promise<Record<string, string> | undefined>;
  rememberMaxCredentialLineage(podId: string, result: ProviderEnvResult): void;
}
export function createWorkerRuntimeCredentials(
  deps: WorkerRuntimeCredentialLiveDependencies,
  captured: WorkerRuntimeCredentialCapturedDependencies,
): {
  getResumeEnv(pod: Pod): Promise<Record<string, string> | undefined>;
  persistRuntimeCredentialsForPod(podId: string, logMessage: string): Promise<void>;
} {
  const {
    podRepo,
    providerAccountStore,
    providerCatalog,
    profileStore,
    containerManagerFactory,
    logger,
    maxCredentialLineageByPod,
    resolveEffectiveBoundProfile,
    validationEnvironmentForPod,
    rememberMaxCredentialLineage,
  } = captured;

  /**
   * Build provider env for resume calls.
   *
   * Three providers need fresh env on resume:
   *  - `max` — Claude Code rotates OAuth tokens during use; persist the
   *    container's latest creds back to the store, then re-issue.
   *  - `openai` — Codex may rotate/update ~/.codex/auth.json during use;
   *    persist the container's latest auth file back to the owner, then
   *    rewrite it before resume.
   *  - `pi` — Pi may refresh its selected provider auth entry in auth.json;
   *    persist the one-entry file before resume, then rewrite it.
   *  - `foundry` (token-auth) — Entra access tokens last ~60-90 minutes,
   *    so for long-running pods the secret file goes stale. Re-acquire via
   *    `getAzureToken` (cached if still valid) and rewrite the secret file.
   *    Only kicks in when the profile has no static apiKey configured.
   */
  async function getResumeEnv(pod: Pod): Promise<Record<string, string> | undefined> {
    const profile = resolveEffectiveBoundProfile(pod);
    const launch = deps.launchConfiguration?.read(pod.id);
    const buildEnv = launch ? await validationEnvironmentForPod(pod, profile) : undefined;
    const provider = profile.modelProvider;
    const owner = profile.providerAccountId
      ? ({ type: 'provider-account', id: profile.providerAccountId } as const)
      : undefined;
    if (
      !launch &&
      provider !== 'max' &&
      provider !== 'foundry' &&
      provider !== 'openai' &&
      provider !== 'pi'
    ) {
      return undefined;
    }

    // Foundry only needs refresh when using bearer-token auth (no static apiKey).
    if (provider === 'foundry') {
      const creds = profile.providerCredentials;
      if (!launch && (!creds || creds.provider !== 'foundry' || creds.apiKey)) {
        return undefined;
      }
    }

    // MAX-specific: recover rotated tokens from the container before refresh.
    // The container is the source of truth — Claude Code rotates tokens during use
    // and writes them to ~/.claude/.credentials.json. If our earlier persistence
    // missed the update, the profile store has a stale (already-invalidated) refresh
    // token and the OAuth refresh will fail with invalid_grant.
    if (provider === 'max' && pod.containerId) {
      try {
        await persistRefreshedCredentials(
          pod.containerId,
          containerManagerFactory.get(pod.executionTarget),
          profileStore,
          pod.profileName,
          logger,
          maxCredentialLineageByPod.get(pod.id),
          { providerAccountStore, owner },
        );
      } catch (err) {
        logger.warn(
          { err, podId: pod.id },
          'Could not recover credentials from container before resume — will try profile store',
        );
      }
    }

    if (provider === 'openai' && pod.containerId) {
      try {
        await persistOpenAiAuthJson(
          pod.containerId,
          containerManagerFactory.get(pod.executionTarget),
          profileStore,
          pod.profileName,
          logger,
          { providerAccountStore, owner },
        );
      } catch (err) {
        logger.warn(
          { err, podId: pod.id },
          'Could not recover Codex auth.json from container before resume',
        );
      }
    }

    if (provider === 'pi' && pod.containerId) {
      try {
        await persistPiAuthJson(
          pod.containerId,
          containerManagerFactory.get(pod.executionTarget),
          profileStore,
          pod.profileName,
          logger,
          { providerAccountStore, owner },
        );
      } catch (err) {
        logger.warn(
          { err, podId: pod.id },
          'Could not recover Pi auth.json from container before resume',
        );
      }
    }

    const result = await buildProviderEnv(profile, pod.id, logger, {
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
    });
    rememberMaxCredentialLineage(pod.id, result);
    // Re-write credential files to container in case tokens were rotated.
    // For Foundry token-auth this also rewrites the bearer-token secret file
    // with whatever getAzureToken returned (cached if still valid, else fresh).
    if (pod.containerId) {
      const cm = containerManagerFactory.get(pod.executionTarget);
      for (const file of result.containerFiles) {
        await cm.writeFile(
          pod.containerId,
          file.path,
          file.content,
          launch ? { mode: 0o600 } : undefined,
        );
      }
      for (const sf of result.secretFiles) {
        if (launch) {
          await cm.writeFile(pod.containerId, sf.path, sf.content, { mode: 0o400 });
          continue;
        }
        await cm.writeFile(pod.containerId, sf.path, sf.content);
        await cm.execInContainer(pod.containerId, ['chmod', '0400', sf.path], { timeout: 5_000 });
      }
    }
    if (launch) await deps.launchConfiguration?.assertCurrentCapabilities(launch);
    return { ...buildEnv, ...result.env, POD_ID: pod.id };
  }

  async function persistRuntimeCredentialsForPod(podId: string, logMessage: string): Promise<void> {
    const pod = podRepo.getOrThrow(podId);
    if (!pod.containerId) return;

    try {
      const profile = resolveEffectiveBoundProfile(pod);
      if (
        profile.modelProvider !== 'max' &&
        profile.modelProvider !== 'openai' &&
        profile.modelProvider !== 'pi'
      ) {
        return;
      }
      const owner = profile.providerAccountId
        ? ({ type: 'provider-account', id: profile.providerAccountId } as const)
        : undefined;
      if (profile.modelProvider === 'max') {
        await persistRefreshedCredentials(
          pod.containerId,
          containerManagerFactory.get(pod.executionTarget),
          profileStore,
          pod.profileName,
          logger,
          maxCredentialLineageByPod.get(podId),
          { providerAccountStore, owner },
        );
      } else if (profile.modelProvider === 'openai') {
        await persistOpenAiAuthJson(
          pod.containerId,
          containerManagerFactory.get(pod.executionTarget),
          profileStore,
          pod.profileName,
          logger,
          { providerAccountStore, owner },
        );
      } else {
        await persistPiAuthJson(
          pod.containerId,
          containerManagerFactory.get(pod.executionTarget),
          profileStore,
          pod.profileName,
          logger,
          { providerAccountStore, owner },
        );
      }
    } catch (err) {
      logger.warn({ err, podId }, logMessage);
    }
  }

  return { getResumeEnv, persistRuntimeCredentialsForPod };
}
