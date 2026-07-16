import type { Profile } from '@autopod/shared';
import type { Logger } from 'pino';
import type { DaemonGitHubAuth } from '../github/daemon-github-auth.js';
import type { ProfileStore } from '../profiles/index.js';
import type { ImageBuildResult, ImageBuilder } from './image-builder.js';

export const DEFAULT_WARM_IMAGE_MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type WarmImageMaintenanceScope = 'sandbox' | 'all';
export type WarmImageMaintenanceSkipReason = 'missing_repo' | 'missing_template' | 'outside_scope';

export interface WarmImageMaintenanceResult {
  checked: number;
  eligible: number;
  fresh: number;
  built: number;
  failed: number;
  skipped: Record<WarmImageMaintenanceSkipReason, number>;
  skippedBecauseRunning: boolean;
}

export interface WarmImageMaintenanceJob {
  start(): void;
  stop(): void;
  runOnce(): Promise<WarmImageMaintenanceResult>;
}

export interface WarmImageMaintenanceDeps {
  profileStore: Pick<ProfileStore, 'list'>;
  imageBuilder: Pick<ImageBuilder, 'buildWarmImage' | 'isStale'>;
  logger: Logger;
  intervalMs?: number;
  runOnStart?: boolean;
  scope?: WarmImageMaintenanceScope;
  githubAuth?: DaemonGitHubAuth;
}

type WarmImageBuildOptions = Parameters<ImageBuilder['buildWarmImage']>[1];

function emptyResult(skippedBecauseRunning = false): WarmImageMaintenanceResult {
  return {
    checked: 0,
    eligible: 0,
    fresh: 0,
    built: 0,
    failed: 0,
    skipped: {
      missing_repo: 0,
      missing_template: 0,
      outside_scope: 0,
    },
    skippedBecauseRunning,
  };
}

function skipReason(
  profile: Profile,
  scope: WarmImageMaintenanceScope,
): WarmImageMaintenanceSkipReason | null {
  if (!profile.repoUrl) return 'missing_repo';
  if (!profile.template) return 'missing_template';
  if (scope === 'all') return null;
  if (profile.executionTarget === 'sandbox') return null;
  if (profile.warmImageTag) return null;
  return 'outside_scope';
}

async function warmImageBuildOptions(
  profile: Profile,
  githubAuth?: DaemonGitHubAuth,
): Promise<WarmImageBuildOptions> {
  const options: NonNullable<WarmImageBuildOptions> = {};
  const gitPat =
    profile.prProvider === 'ado'
      ? (profile.adoPat ?? undefined)
      : (await githubAuth?.resolveCredential())?.token;

  if (gitPat) options.gitPat = gitPat;
  if (profile.registryPat) options.registryPat = profile.registryPat;
  return options;
}

export function createWarmImageMaintenanceJob(
  deps: WarmImageMaintenanceDeps,
): WarmImageMaintenanceJob {
  const intervalMs = deps.intervalMs ?? DEFAULT_WARM_IMAGE_MAINTENANCE_INTERVAL_MS;
  const runOnStart = deps.runOnStart ?? true;
  const scope = deps.scope ?? 'sandbox';
  let interval: ReturnType<typeof setInterval> | null = null;
  let running = false;

  async function runOnce(): Promise<WarmImageMaintenanceResult> {
    if (running) {
      deps.logger.info(
        { scope },
        'Skipping warm-image maintenance sweep because a previous sweep is still running',
      );
      return emptyResult(true);
    }

    running = true;
    const result = emptyResult();

    try {
      const profiles = deps.profileStore.list();
      result.checked = profiles.length;

      for (const profile of profiles) {
        const reason = skipReason(profile, scope);
        if (reason) {
          result.skipped[reason]++;
          continue;
        }

        result.eligible++;
        if (!deps.imageBuilder.isStale(profile)) {
          result.fresh++;
          continue;
        }

        try {
          const build = await deps.imageBuilder.buildWarmImage(
            profile,
            await warmImageBuildOptions(profile, deps.githubAuth),
          );
          result.built++;
          logBuildSuccess(deps.logger, profile, build);
        } catch (err) {
          result.failed++;
          deps.logger.error(
            { err, profileName: profile.name },
            'Warm-image maintenance build failed',
          );
        }
      }

      deps.logger.info({ ...result, scope }, 'Warm-image maintenance sweep complete');
      return result;
    } finally {
      running = false;
    }
  }

  function runAndLog(): void {
    runOnce().catch((err) => {
      deps.logger.error({ err, scope }, 'Warm-image maintenance sweep failed');
    });
  }

  return {
    start(): void {
      if (interval) return;
      if (runOnStart) runAndLog();
      interval = setInterval(runAndLog, intervalMs);
      interval.unref();
      deps.logger.info({ intervalMs, scope }, 'Warm-image maintenance scheduler started');
    },

    stop(): void {
      if (!interval) return;
      clearInterval(interval);
      interval = null;
    },

    runOnce,
  };
}

function logBuildSuccess(logger: Logger, profile: Profile, build: ImageBuildResult): void {
  logger.info(
    {
      profileName: profile.name,
      tag: build.tag,
      buildDuration: build.buildDuration,
      sizeMb: Math.floor(build.size / 1_048_576),
    },
    'Warm-image maintenance built profile image',
  );
}
