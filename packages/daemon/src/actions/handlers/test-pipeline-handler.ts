import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ActionDefinition, TestPipelineConfig } from '@autopod/shared';
import { AutopodError } from '@autopod/shared';
import type { Logger } from 'pino';
import type { PodRepository } from '../../pods/pod-repository.js';
import type { ProfileStore } from '../../profiles/index.js';
import { parseAdoRepoUrl } from '../../worktrees/ado-pr-manager.js';
import {
  type ActionHandler,
  type ActionHandlerContext,
  fetchWithTimeout,
  readSafeJson,
} from './handler.js';

const execFileAsync = promisify(execFile);

const ADO_API_VERSION = '7.1-preview.1';
const DEFAULT_RATE_LIMIT_PER_HOUR = 10;
const DEFAULT_BRANCH_PREFIX = 'test-runs/';
const RUN_STATUS_POLL_MAX_MS = 5 * 60_000;
const RUN_STATUS_POLL_INTERVAL_MS = 3_000;

export interface TestPipelineHandlerConfig {
  logger: Logger;
  podRepo: PodRepository;
  profileStore: ProfileStore;
  /** HH:MM timestamps of recent triggers per pod for rate limiting. */
  rateLimitState?: Map<string, number[]>;
}

export function createTestPipelineHandler(config: TestPipelineHandlerConfig): ActionHandler {
  const { logger, podRepo, profileStore } = config;
  const rateLimitState = config.rateLimitState ?? new Map<string, number[]>();
  const log = logger.child({ handler: 'test-pipeline' });

  function getAuth(pat: string): string {
    return `Basic ${Buffer.from(`:${pat}`).toString('base64')}`;
  }

  return {
    handlerType: 'test-pipeline',

    async execute(
      action: ActionDefinition,
      params: Record<string, unknown>,
      context?: ActionHandlerContext,
    ): Promise<unknown> {
      if (!context?.podId) {
        throw new AutopodError(
          `Action '${action.name}' requires pod context`,
          'MISSING_CONTEXT',
          500,
        );
      }
      const pod = podRepo.getOrThrow(context.podId);
      const profile = profileStore.get(pod.profileName);
      const cfg = profile.testPipeline;
      if (!cfg || !cfg.enabled) {
        throw new AutopodError(
          `Profile '${profile.name}' has no enabled testPipeline config`,
          'TEST_PIPELINE_DISABLED',
          400,
        );
      }
      if (!profile.adoPat) {
        throw new AutopodError(
          `Profile '${profile.name}' is missing adoPat — required to push + trigger pipelines`,
          'MISSING_CREDENTIAL',
          400,
        );
      }

      switch (action.name) {
        case 'ado_run_test_pipeline':
          return runTestPipeline({
            podId: context.podId,
            podBranch: pod.branch,
            worktreePath: pod.worktreePath,
            pat: profile.adoPat,
            cfg,
            logger: log,
            rateLimitState,
            podRepo,
          });

        case 'ado_get_test_run_status':
          return getTestRunStatus({
            runId: params.run_id as number,
            pat: profile.adoPat,
            cfg,
            logger: log,
            timeoutMs: (params.timeout_seconds as number | undefined)
              ? (params.timeout_seconds as number) * 1000
              : RUN_STATUS_POLL_MAX_MS,
          });

        default:
          throw new Error(`Unknown test-pipeline action: ${action.name}`);
      }
    },
  };

  // ─── helpers ──────────────────────────────────────────────────

  async function runTestPipeline(args: {
    podId: string;
    podBranch: string;
    worktreePath: string | null;
    pat: string;
    cfg: TestPipelineConfig;
    logger: Logger;
    rateLimitState: Map<string, number[]>;
    podRepo: PodRepository;
  }): Promise<{ runId: number; url: string; testBranch: string }> {
    const { podId, podBranch, worktreePath, pat, cfg, rateLimitState, podRepo } = args;
    if (!worktreePath) {
      throw new AutopodError(
        `Pod ${podId} has no worktree — cannot push to test repo`,
        'INVALID_STATE',
        409,
      );
    }

    // ── rate limit ─────────────────────────────────────────────
    const limit = cfg.rateLimitPerHour ?? DEFAULT_RATE_LIMIT_PER_HOUR;
    const now = Date.now();
    const windowStart = now - 60 * 60_000;
    const recent = (rateLimitState.get(podId) ?? []).filter((t) => t >= windowStart);
    if (recent.length >= limit) {
      throw new AutopodError(
        `Rate limit exceeded: ${recent.length}/${limit} test-pipeline runs in the last hour`,
        'RATE_LIMIT',
        429,
      );
    }
    recent.push(now);
    rateLimitState.set(podId, recent);

    // ── cross-repo push ───────────────────────────────────────
    // Pipelines API is project-scoped, not repo-scoped, so parseAdoRepoUrl's
    // `repoName` output is ignored here; we only need orgUrl + project.
    const { orgUrl, project } = parseAdoRepoUrl(cfg.testRepo);
    const branchPrefix = cfg.branchPrefix ?? DEFAULT_BRANCH_PREFIX;
    const testBranch = `${branchPrefix}${podId}/${now}`;
    const authenticatedUrl = injectPatIntoAdoUrl(cfg.testRepo, pat);
    args.logger.info(
      { podId, testBranch, testRepo: cfg.testRepo },
      'Pushing pod branch to test repo',
    );
    try {
      await execFileAsync(
        'git',
        ['-C', worktreePath, 'push', '--force', authenticatedUrl, `HEAD:refs/heads/${testBranch}`],
        { timeout: 60_000 },
      );
    } catch (err) {
      throw new AutopodError(
        `Failed to push to test repo: ${err instanceof Error ? err.message.slice(0, 300) : String(err)}`,
        'PUSH_FAILED',
        502,
      );
    }

    // Track the branch so branch-cleanup can reap it on pod end.
    const existing = (() => {
      try {
        return podRepo.getOrThrow(podId).testRunBranches ?? [];
      } catch {
        return [];
      }
    })();
    podRepo.update(podId, { testRunBranches: [...existing, testBranch] });

    // ── trigger pipeline ──────────────────────────────────────
    const runUrl = `${orgUrl}/${encodeURIComponent(project)}/_apis/pipelines/${cfg.testPipelineId}/runs?api-version=${ADO_API_VERSION}`;
    const runBody = {
      resources: {
        repositories: { self: { refName: `refs/heads/${testBranch}` } },
      },
    };
    const response = await fetchWithTimeout(runUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: getAuth(pat),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(runBody),
      timeout: 30_000,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new AutopodError(
        `ADO pipeline trigger failed (${response.status}): ${text.slice(0, 300)}`,
        'PIPELINE_TRIGGER_FAILED',
        502,
      );
    }
    const run = (await readSafeJson(response)) as {
      id: number;
      _links?: { web?: { href?: string } };
    };
    const webHref =
      run._links?.web?.href ??
      `${orgUrl}/${encodeURIComponent(project)}/_build/results?buildId=${run.id}`;
    args.logger.info({ podId, runId: run.id, testBranch, podBranch }, 'Triggered test pipeline');
    return { runId: run.id, url: webHref, testBranch };
  }

  async function getTestRunStatus(args: {
    runId: number;
    pat: string;
    cfg: TestPipelineConfig;
    logger: Logger;
    timeoutMs: number;
  }): Promise<{
    status: 'inProgress' | 'succeeded' | 'failed' | 'canceled' | 'unknown';
    url: string;
    durationSeconds?: number;
    failingStage?: string;
    logsTail?: string;
  }> {
    const { runId, pat, cfg, timeoutMs } = args;
    const { orgUrl, project } = parseAdoRepoUrl(cfg.testRepo);
    const deadline = Date.now() + timeoutMs;
    const runUrl = `${orgUrl}/${encodeURIComponent(project)}/_apis/pipelines/${cfg.testPipelineId}/runs/${runId}?api-version=${ADO_API_VERSION}`;

    while (Date.now() < deadline) {
      const res = await fetchWithTimeout(runUrl, {
        headers: { Accept: 'application/json', Authorization: getAuth(pat) },
        timeout: 15_000,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new AutopodError(
          `ADO pipeline status fetch failed (${res.status}): ${text.slice(0, 300)}`,
          'PIPELINE_STATUS_FAILED',
          502,
        );
      }
      const data = (await readSafeJson(res)) as {
        id: number;
        state: string;
        result?: string;
        createdDate?: string;
        finishedDate?: string;
        _links?: { web?: { href?: string } };
      };

      if (data.state !== 'inProgress' && data.state !== 'notStarted') {
        const finishedMs = data.finishedDate ? Date.parse(data.finishedDate) : Number.NaN;
        const createdMs = data.createdDate ? Date.parse(data.createdDate) : Number.NaN;
        const durationSeconds =
          Number.isFinite(finishedMs) && Number.isFinite(createdMs)
            ? Math.round((finishedMs - createdMs) / 1000)
            : undefined;
        let status: 'inProgress' | 'succeeded' | 'failed' | 'canceled' | 'unknown' = 'unknown';
        const r = data.result?.toLowerCase();
        if (r === 'succeeded') status = 'succeeded';
        else if (r === 'failed') status = 'failed';
        else if (r === 'canceled') status = 'canceled';
        const logsTail =
          status === 'failed'
            ? await fetchFailingLogTail(runId, pat, cfg).catch(() => undefined)
            : undefined;
        return {
          status,
          url:
            data._links?.web?.href ??
            `${orgUrl}/${encodeURIComponent(project)}/_build/results?buildId=${runId}`,
          durationSeconds,
          logsTail,
        };
      }

      await sleep(RUN_STATUS_POLL_INTERVAL_MS);
    }

    return {
      status: 'inProgress',
      url: `${orgUrl}/${encodeURIComponent(project)}/_build/results?buildId=${runId}`,
    };
  }

  async function fetchFailingLogTail(
    runId: number,
    pat: string,
    cfg: TestPipelineConfig,
  ): Promise<string | undefined> {
    const { orgUrl, project } = parseAdoRepoUrl(cfg.testRepo);
    // Pipelines API runId maps to Build buildId. The simpler logs endpoint at
    // /build/builds/{id}/logs lists log blobs; we grab the last one.
    const listUrl = `${orgUrl}/${encodeURIComponent(project)}/_apis/build/builds/${runId}/logs?api-version=7.1`;
    const listRes = await fetchWithTimeout(listUrl, {
      headers: { Accept: 'application/json', Authorization: getAuth(pat) },
      timeout: 15_000,
    });
    if (!listRes.ok) return undefined;
    const listData = (await readSafeJson(listRes)) as { value?: Array<{ id: number }> };
    const lastId = listData.value?.[listData.value.length - 1]?.id;
    if (lastId == null) return undefined;
    const logUrl = `${orgUrl}/${encodeURIComponent(project)}/_apis/build/builds/${runId}/logs/${lastId}?api-version=7.1`;
    const logRes = await fetchWithTimeout(logUrl, {
      headers: { Authorization: getAuth(pat) },
      timeout: 15_000,
    });
    if (!logRes.ok) return undefined;
    const text = await logRes.text();
    // Return the last ~8KB — enough to capture a failing stage's tail.
    return text.slice(-8192);
  }
}

/**
 * Rewrite a `https://dev.azure.com/...` URL to embed a PAT for git push.
 * Example: https://dev.azure.com/org/proj/_git/repo →
 *          https://x-access-token:PAT@dev.azure.com/org/proj/_git/repo
 */
export function injectPatIntoAdoUrl(repoUrl: string, pat: string): string {
  const u = new URL(repoUrl);
  u.username = 'x-access-token';
  u.password = pat;
  return u.toString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
