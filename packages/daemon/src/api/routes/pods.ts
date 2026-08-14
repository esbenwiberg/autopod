import {
  AutopodError,
  type CompactPod,
  type CompactPodPage,
  type FirewallDeniedEvent,
  type OperatorActor,
  type PodStatus,
  type ReviewProgressSnapshot,
  collectPiiPatternNames,
  createPodRequestSchema,
  podStatusSchema,
  processContent,
  renderEvidenceYaml,
  sendMessageSchema,
} from '@autopod/shared';
import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ActionAuditRepository } from '../../actions/audit-repository.js';
import { aggregateCost, parseDays } from '../../pods/cost-aggregation.js';
import type { EscalationRepository } from '../../pods/escalation-repository.js';
import {
  type EscalationsAnalyticsScope,
  computeEscalationsAnalytics,
} from '../../pods/escalations-aggregator.js';
import type { EventRepository } from '../../pods/event-repository.js';
import type { PodManager } from '../../pods/index.js';
import { computeMemoryEffectivenessAnalytics } from '../../pods/memory-effectiveness-aggregator.js';
import { computeModelsAnalytics } from '../../pods/models-aggregator.js';
import type { PendingOverrideRepository } from '../../pods/pending-override-repository.js';
import { computePodCostBreakdown } from '../../pods/pod-cost-breakdown.js';
import type { PodRepository } from '../../pods/pod-repository.js';
import {
  type ProviderAttemptRepository,
  createProviderAttemptRepository,
} from '../../pods/provider-attempt-repository.js';
import type { QualityScoreRepository } from '../../pods/quality-score-repository.js';
import { computeQualitySignals } from '../../pods/quality-signals.js';
import { computeReliabilityAnalytics } from '../../pods/reliability-aggregator.js';
import {
  computeSafetyAnalytics,
  runAndPersistAuditChainVerification,
} from '../../pods/safety-aggregator.js';
import { computeThroughputAnalytics } from '../../pods/throughput-aggregator.js';
import type { ValidationRepository } from '../../pods/validation-repository.js';
import type { SafetyEventsRepository } from '../../safety/safety-events-repository.js';
import { CONTROL_PLANE_RATE_LIMIT_MAX, rateLimitIdentity } from '../plugins/rate-limit.js';
import { resolvePublicPreviewOrigin, rewritePreviewUrlForBrowser } from '../preview-url.js';
import { serializePodForWire, serializeValidationResult } from '../wire-serializers.js';

function humanActor(request: FastifyRequest): OperatorActor {
  return {
    type: 'human',
    userId: request.user.oid,
    ...(request.user.name ? { displayName: request.user.name } : {}),
  };
}

function parseEscalationsScope(query: Record<string, unknown>): EscalationsAnalyticsScope | null {
  const raw = query.scope;
  if (raw === undefined) return 'interactive';
  if (raw === 'interactive' || raw === 'scheduled' || raw === 'all') return raw;
  return null;
}

function parsePositiveIntegerQueryParam(raw: unknown): number | null | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw)) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

const LOG_REPLAY_EVENT_TYPES = ['pod.agent_activity', 'pod.firewall_denied'];
const MAX_POD_LIST_LIMIT = 500;
const COMPACT_TITLE_MAX_CHARS = 160;
const COMPACT_SUMMARY_MAX_CHARS = 500;
const COMPACT_TASK_MAX_CHARS = 2_000;

interface PodListCursor {
  createdAt: string;
  id: string;
}

const POD_CURSOR_TIMESTAMP_PATTERN =
  /^(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z|\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{3})?)$/;

function encodePodListCursor(cursor: PodListCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodePodListCursor(raw: string): PodListCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>).createdAt !== 'string' ||
      !POD_CURSOR_TIMESTAMP_PATTERN.test((parsed as Record<string, unknown>).createdAt as string) ||
      Number.isNaN(Date.parse((parsed as Record<string, unknown>).createdAt as string)) ||
      typeof (parsed as Record<string, unknown>).id !== 'string' ||
      ((parsed as Record<string, unknown>).id as string).length === 0
    ) {
      return null;
    }
    return {
      createdAt: (parsed as Record<string, unknown>).createdAt as string,
      id: (parsed as Record<string, unknown>).id as string,
    };
  } catch {
    return null;
  }
}

function parseSinceQueryParam(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T|$)/.exec(value);
  if (!match) return null;
  const year = Number.parseInt(match[1] ?? '', 10);
  const month = Number.parseInt(match[2] ?? '', 10);
  const day = Number.parseInt(match[3] ?? '', 10);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (
    calendarDate.getUTCFullYear() !== year ||
    calendarDate.getUTCMonth() !== month - 1 ||
    calendarDate.getUTCDate() !== day
  ) {
    return null;
  }
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString();
}

function compactText(value: string | null | undefined, maxChars = COMPACT_SUMMARY_MAX_CHARS) {
  return value === null || value === undefined ? null : value.slice(0, maxChars);
}

function compactPod(
  pod: ReturnType<PodManager['getSession']>,
  request: FastifyRequest,
  eventRepo?: EventRepository,
): CompactPod {
  const reviewProgress = latestActiveReviewProgress(pod, eventRepo);
  const title = compactText(
    pod.briefTitle ?? pod.task.split('\n', 1)[0] ?? pod.id,
    COMPACT_TITLE_MAX_CHARS,
  ) as string;
  return {
    id: pod.id,
    title,
    taskExcerpt: pod.task.slice(0, COMPACT_TASK_MAX_CHARS),
    taskSummary: compactText(pod.taskSummary?.actualSummary),
    profileName: pod.profileName,
    status: pod.status,
    model: pod.model,
    runtime: pod.runtime,
    executionTarget: pod.executionTarget,
    branch: pod.branch,
    baseBranch: pod.baseBranch,
    seriesId: pod.seriesId,
    seriesName: pod.seriesName,
    options: pod.options,
    hasWebUi: pod.hasWebUi,
    previewUrl: rewritePreviewUrlForRequest(pod.id, pod.previewUrl, request),
    containerId: pod.containerId,
    worktreePath: pod.worktreePath,
    createdAt: pod.createdAt,
    startedAt: pod.startedAt,
    runningAt: pod.runningAt,
    updatedAt: pod.updatedAt,
    completedAt: pod.completedAt,
    lastHeartbeatAt: pod.lastHeartbeatAt,
    failureReason: compactText(pod.failureReason),
    mergeBlockReason: compactText(pod.mergeBlockReason),
    lastCorrectionMessage: compactText(pod.lastCorrectionMessage),
    pendingEscalationSummary: compactText(pod.pendingEscalation?.question),
    progressSummary: reviewProgress
      ? reviewProgressSummary(reviewProgress)
      : pod.progress
        ? `${pod.progress.phase}: ${pod.progress.description}`.slice(0, 240)
        : null,
    inputTokens: pod.inputTokens,
    outputTokens: pod.outputTokens,
    costUsd: pod.costUsd,
    tokenTelemetryAccuracy: pod.tokenTelemetryAccuracy,
    filesChanged: pod.filesChanged,
    linesAdded: pod.linesAdded,
    linesRemoved: pod.linesRemoved,
  };
}

function previewRewriteContext(request: FastifyRequest) {
  return {
    requestHost: request.headers.host,
    forwardedHost: request.headers['x-forwarded-host'],
    forwardedProto: request.headers['x-forwarded-proto'],
    publicHost: process.env.AUTOPOD_PREVIEW_PUBLIC_HOST,
    publicScheme: process.env.AUTOPOD_PREVIEW_PUBLIC_SCHEME,
  };
}

function rewritePreviewUrlForRequest(
  podId: string,
  previewUrl: string | null,
  request: FastifyRequest,
): string | null {
  return rewritePreviewUrlForBrowser(podId, previewUrl, previewRewriteContext(request));
}

function serializePodForRequest(
  pod: ReturnType<PodManager['getSession']>,
  request: FastifyRequest,
  providerAttemptRepo?: ProviderAttemptRepository,
  eventRepo?: EventRepository,
): unknown {
  const attempts = providerAttemptRepo?.list(pod.id) ?? [];
  const latestAttempt = attempts.at(-1);
  const projectedPod = latestAttempt
    ? {
        ...pod,
        runtime: latestAttempt.runtime,
        model: latestAttempt.model,
        claudeSessionId: latestAttempt.runtime === 'claude' ? latestAttempt.nativeSessionId : null,
        codexSessionId: latestAttempt.runtime === 'codex' ? latestAttempt.nativeSessionId : null,
        piSessionId: latestAttempt.runtime === 'pi' ? latestAttempt.nativeSessionId : null,
        ...providerAttemptRepo?.totals(pod.id),
      }
    : pod;
  const wire = serializePodForWire(projectedPod) as Record<string, unknown>;
  wire.providerAttempts = attempts;
  wire.reviewProgress = latestActiveReviewProgress(pod, eventRepo);
  if (typeof wire.previewUrl === 'string') {
    wire.previewUrl = rewritePreviewUrlForRequest(pod.id, wire.previewUrl, request);
  }
  return wire;
}

function latestActiveReviewProgress(
  pod: ReturnType<PodManager['getSession']>,
  eventRepo?: EventRepository,
): ReviewProgressSnapshot | null {
  if (!eventRepo || pod.status !== 'validating') return null;
  const stored = eventRepo
    .getForSession(pod.id, {
      types: ['pod.review_progress', 'pod.validation_phase_completed'],
      latest: 1,
    })
    .at(-1);
  if (!stored || stored.payload.type !== 'pod.review_progress') return null;
  return stored.payload.progress.attempt === pod.validationAttempts
    ? stored.payload.progress
    : null;
}

function reviewProgressSummary(progress: ReviewProgressSnapshot): string {
  const settled = progress.axes.filter(
    (axis) => axis.status === 'completed' || axis.status === 'unavailable',
  ).length;
  const elapsed = Math.max(0, Math.ceil(progress.elapsedMs / 1_000));
  const guardrail = Math.max(1, Math.ceil(progress.guardrailMs / 60_000));
  const stage = progress.stage === 'axes' ? 'Review council' : `Review ${progress.stage}`;
  return `${stage}: ${settled}/${progress.axes.length} settled · ${elapsed}s / ${guardrail}m guardrail`;
}

const PREVIEW_PROXY_HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'content-encoding',
  'content-length',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const PREVIEW_POD_COOKIE = 'autopod_preview_pod';
const PREVIEW_RATE_LIMIT_MAX = 5_000;

function proxyBasePath(podId: string): string {
  return `/pods/${encodeURIComponent(podId)}/preview/proxy`;
}

function rewritePreviewProxyTarget(previewUrl: string, requestUrl: string, podId: string): string {
  const incoming = new URL(requestUrl, 'http://autopod.local');
  const marker = proxyBasePath(podId);
  const suffix = incoming.pathname.startsWith(marker) ? incoming.pathname.slice(marker.length) : '';
  const proxyPath = suffix ? (suffix.startsWith('/') ? suffix : `/${suffix}`) : '/';

  return rewritePreviewProxyTargetPath(previewUrl, proxyPath, incoming.search);
}

function rewritePreviewFallbackTarget(previewUrl: string, requestUrl: string): string {
  const incoming = new URL(requestUrl, 'http://autopod.local');
  return rewritePreviewProxyTargetPath(previewUrl, incoming.pathname, incoming.search);
}

function rewritePreviewProxyTargetPath(
  previewUrl: string,
  proxyPath: string,
  search: string,
): string {
  const target = new URL(previewUrl);
  const basePath = target.pathname.endsWith('/') ? target.pathname.slice(0, -1) : target.pathname;
  target.pathname = `${basePath}${proxyPath}`;
  target.search = search;
  return target.toString();
}

function proxyRequestHeaders(headers: FastifyRequest['headers']): Headers {
  const forwarded = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower === 'host' || PREVIEW_PROXY_HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) forwarded.append(name, item);
    } else {
      forwarded.set(name, String(value));
    }
  }
  return forwarded;
}

function proxyRequestBody(method: string, body: unknown): BodyInit | undefined {
  if (method === 'GET' || method === 'HEAD' || body === undefined || body === null) {
    return undefined;
  }
  if (typeof body === 'string' || body instanceof Uint8Array) return body;
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'object') return JSON.stringify(body);
  return String(body);
}

function previewCookie(podId: string): string {
  return `${PREVIEW_POD_COOKIE}=${encodeURIComponent(
    podId,
  )}; Path=/; Max-Age=600; SameSite=Lax; HttpOnly`;
}

function previewPodIdFromRequest(request: FastifyRequest): string | null {
  const pathname = new URL(request.url, 'http://autopod.local').pathname;
  return (
    previewPodIdFromPath(pathname) ??
    previewPodIdFromReferer(request) ??
    previewPodIdFromCookie(request)
  );
}

const PREVIEW_RATE_LIMIT = {
  max: (request: FastifyRequest) =>
    previewPodIdFromRequest(request) ? PREVIEW_RATE_LIMIT_MAX : CONTROL_PLANE_RATE_LIMIT_MAX,
  timeWindow: '1 minute',
  groupId: 'preview-proxy',
  keyGenerator: (request: FastifyRequest) => {
    const podId = previewPodIdFromRequest(request) ?? 'none';
    return `${rateLimitIdentity(request)}:pod:${podId}`;
  },
};

function previewPodIdFromReferer(request: FastifyRequest): string | null {
  const referer =
    firstHeaderValue(request.headers.referer) ?? firstHeaderValue(request.headers.referrer);
  if (!referer) return null;

  try {
    const url = new URL(referer, 'http://autopod.local');
    return previewPodIdFromPath(url.pathname);
  } catch {
    return null;
  }
}

function previewPodIdFromCookie(request: FastifyRequest): string | null {
  const cookie = firstHeaderValue(request.headers.cookie);
  if (!cookie) return null;

  for (const part of cookie.split(';')) {
    const [name, ...valueParts] = part.trim().split('=');
    if (name !== PREVIEW_POD_COOKIE) continue;
    const value = valueParts.join('=');
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  return null;
}

function previewPodIdFromPath(pathname: string): string | null {
  const match = /^\/pods\/([^/]+)\/preview\/proxy(?:\/|$)/.exec(pathname);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function rewritePreviewLocation(
  location: string,
  previewUrl: string,
  podId: string,
  request: FastifyRequest,
): string {
  const basePath = proxyBasePath(podId);
  if (location.startsWith('/')) {
    return `${basePath}${location}`;
  }

  try {
    const upstreamBase = new URL(previewUrl);
    const target = new URL(location, upstreamBase);
    if (target.origin !== upstreamBase.origin) return location;

    const publicOrigin = resolvePublicPreviewOrigin(previewRewriteContext(request));
    const browserBase = publicOrigin ? `${publicOrigin}${basePath}` : basePath;
    return `${browserBase}${target.pathname}${target.search}${target.hash}`;
  } catch {
    return location;
  }
}

function firstHeaderValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

type HostedDeployDrain = {
  actorUserId: string;
  actorName: string | null;
  expiresAt: string;
};

function activeHostedDeployDrain(db: Database.Database | undefined): HostedDeployDrain | null {
  if (!db) return null;
  db.prepare('DELETE FROM hosted_deploy_drain WHERE expires_at <= ?').run(new Date().toISOString());
  return (
    (db
      .prepare(
        'SELECT actor_user_id AS actorUserId, actor_name AS actorName, expires_at AS expiresAt FROM hosted_deploy_drain WHERE singleton = 1',
      )
      .get() as HostedDeployDrain | undefined) ?? null
  );
}

export function podRoutes(
  app: FastifyInstance,
  podManager: PodManager,
  eventRepo?: EventRepository,
  pendingOverrideRepo?: PendingOverrideRepository,
  podRepo?: PodRepository,
  escalationRepo?: EscalationRepository,
  qualityScoreRepo?: QualityScoreRepository,
  validationRepo?: ValidationRepository,
  db?: Database.Database,
  safetyEventsRepo?: SafetyEventsRepository,
  actionAuditRepo?: ActionAuditRepository,
): void {
  const providerAttemptRepo = db ? createProviderAttemptRepository(db) : undefined;
  // Rework can include a full sandbox filesystem sync. Keep it detached from the
  // desktop request and coalesce repeats after a client-side timeout.
  const reworkRuns = new Map<string, Promise<void>>();
  const hostedDeployDrainSchema = z.object({
    ttlSeconds: z.number().int().min(60).max(3_600).default(1_800),
  });

  // These endpoints are intentionally daemon-authenticated rather than VM-authenticated:
  // the deploy script holds the same user token as its active-pod preflight and leaves an
  // auditable, expiring fence before it restarts the process.
  app.get('/maintenance/hosted-deploy-drain', async (_request, reply) => {
    if (!db) {
      reply.status(503);
      return { error: 'Hosted deployment drain is unavailable' };
    }
    return { active: activeHostedDeployDrain(db) };
  });

  app.post('/maintenance/hosted-deploy-drain', async (request, reply) => {
    if (!db) {
      reply.status(503);
      return { error: 'Hosted deployment drain is unavailable' };
    }
    const { ttlSeconds } = hostedDeployDrainSchema.parse(request.body ?? {});
    const expiresAt = new Date(Date.now() + ttlSeconds * 1_000).toISOString();
    db.prepare(
      `INSERT INTO hosted_deploy_drain (singleton, actor_user_id, actor_name, expires_at)
       VALUES (1, ?, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET
         actor_user_id = excluded.actor_user_id,
         actor_name = excluded.actor_name,
         expires_at = excluded.expires_at,
         created_at = datetime('now')`,
    ).run(request.user.oid, request.user.name ?? null, expiresAt);
    reply.status(201);
    return { active: activeHostedDeployDrain(db) };
  });

  app.delete('/maintenance/hosted-deploy-drain', async (_request, reply) => {
    if (!db) {
      reply.status(503);
      return { error: 'Hosted deployment drain is unavailable' };
    }
    db.prepare('DELETE FROM hosted_deploy_drain WHERE singleton = 1').run();
    return { active: null };
  });

  // POST /pods — create a new pod
  app.post('/pods', async (request, reply) => {
    const drain = activeHostedDeployDrain(db);
    if (drain) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((Date.parse(drain.expiresAt) - Date.now()) / 1_000),
      );
      reply.header('Retry-After', String(retryAfterSeconds)).status(503);
      return {
        error: 'Hosted daemon deployment is in progress; retry pod creation after maintenance.',
        code: 'HOSTED_DEPLOY_DRAIN',
        retryAfterSeconds,
      };
    }
    const body = createPodRequestSchema.parse(request.body);

    // Sanitize human-authored free-text fields. Findings are quarantined into
    // the text (replaced with a marker) but never block pod creation — the
    // scan layer at provisioning is the gate.
    const sanitizeOpts = {
      sanitization: { preset: 'standard' as const },
      quarantine: { enabled: true },
    };
    const sanitized = { ...body };
    const taskResult = body.task ? processContent(body.task, sanitizeOpts) : null;
    const seriesNameResult = body.seriesName ? processContent(body.seriesName, sanitizeOpts) : null;
    const seriesDescResult = body.seriesDescription
      ? processContent(body.seriesDescription, sanitizeOpts)
      : null;
    if (taskResult) sanitized.task = taskResult.text;
    if (seriesNameResult) sanitized.seriesName = seriesNameResult.text;
    if (seriesDescResult) sanitized.seriesDescription = seriesDescResult.text;

    // Write safety_events rows for any detections (pod_id stays NULL — no pod yet).
    if (safetyEventsRepo) {
      const sanitizedAll = [taskResult?.text, seriesNameResult?.text, seriesDescResult?.text]
        .filter(Boolean)
        .join('\n');
      const payloadExcerpt = sanitizedAll.slice(0, 256);

      const allThreats = [
        ...(taskResult?.threats ?? []),
        ...(seriesNameResult?.threats ?? []),
        ...(seriesDescResult?.threats ?? []),
      ];
      for (const threat of allThreats) {
        safetyEventsRepo.insert({
          podId: null,
          source: 'pod_input',
          kind: 'injection',
          patternName: threat.pattern,
          severity: threat.severity,
          payloadExcerpt,
        });
      }

      const originalAll = [body.task, body.seriesName, body.seriesDescription]
        .filter(Boolean)
        .join('\n');
      for (const patternName of collectPiiPatternNames(originalAll)) {
        safetyEventsRepo.insert({
          podId: null,
          source: 'pod_input',
          kind: 'pii',
          patternName,
          severity: null,
          payloadExcerpt,
        });
      }
    }

    try {
      const pod = podManager.createSession(sanitized, request.user.oid, {
        email: request.user.preferred_username,
        name: request.user.name,
      });
      reply.status(201);
      return serializePodForRequest(pod, request, providerAttemptRepo, eventRepo);
    } catch (err) {
      if (err instanceof AutopodError) {
        reply.status(err.statusCode ?? 400);
        return { error: err.message, code: err.code };
      }
      throw err;
    }
  });

  // GET /pods — list pods
  app.get('/pods', async (request, reply) => {
    const query = request.query as {
      profileName?: string;
      profile?: string;
      status?: string;
      userId?: string;
      limit?: string;
      compact?: string;
      page?: string;
      cursor?: string;
      since?: string;
    };
    const limit = parsePositiveIntegerQueryParam(query.limit);
    if (limit === null) {
      reply.status(400);
      return { error: 'limit must be a positive integer', code: 'invalid_limit' };
    }
    if (limit !== undefined && limit > MAX_POD_LIST_LIMIT) {
      reply.status(400);
      return {
        error: `limit must be at most ${MAX_POD_LIST_LIMIT}`,
        code: 'limit_too_large',
      };
    }
    const since = parseSinceQueryParam(query.since);
    if (since === null) {
      reply.status(400);
      return { error: 'since must be an ISO date/time', code: 'invalid_since' };
    }
    const paginated = query.page === 'true' || query.cursor !== undefined;
    if (paginated && query.compact !== 'true') {
      reply.status(400);
      return { error: 'pagination is only supported for compact pod lists', code: 'invalid_page' };
    }
    if (query.page !== undefined && query.page !== 'true') {
      reply.status(400);
      return { error: 'page must be true when provided', code: 'invalid_page' };
    }
    const cursor = query.cursor === undefined ? undefined : decodePodListCursor(query.cursor);
    if (query.cursor !== undefined && cursor === null) {
      reply.status(400);
      return { error: 'cursor is malformed', code: 'invalid_cursor' };
    }
    const rawStatuses = query.status?.split(',').filter(Boolean);
    const invalidStatus = rawStatuses?.find((status) => !podStatusSchema.safeParse(status).success);
    if (invalidStatus !== undefined) {
      reply.status(400);
      return { error: `Unknown pod status: ${invalidStatus}`, code: 'invalid_status' };
    }
    const statuses = rawStatuses as PodStatus[] | undefined;
    const paginatedLimit = limit ?? MAX_POD_LIST_LIMIT;
    const pods = podManager.listSessions({
      profileName: query.profileName ?? query.profile,
      status: statuses,
      userId: query.userId,
      limit: paginated ? paginatedLimit + 1 : limit,
      since,
      before: cursor ?? undefined,
    });
    if (query.compact === 'true') {
      if (!paginated) return pods.map((pod) => compactPod(pod, request, eventRepo));
      const hasMore = pods.length > paginatedLimit;
      const records = hasMore ? pods.slice(0, paginatedLimit) : pods;
      const last = records.at(-1);
      const response: CompactPodPage = {
        pods: records.map((pod) => compactPod(pod, request, eventRepo)),
        nextCursor:
          hasMore && last ? encodePodListCursor({ createdAt: last.createdAt, id: last.id }) : null,
      };
      return response;
    }
    return pods.map((pod) => serializePodForRequest(pod, request, providerAttemptRepo, eventRepo));
  });

  // GET /pods/stats — pod counts grouped by status
  app.get('/pods/stats', async (request) => {
    const query = request.query as { profile?: string };
    return podManager.getSessionStats({
      profileName: query.profile,
    });
  });

  // GET /pods/:podId — get pod
  app.get('/pods/:podId', async (request) => {
    const { podId } = request.params as { podId: string };
    return serializePodForRequest(
      podManager.getSession(podId),
      request,
      providerAttemptRepo,
      eventRepo,
    );
  });

  // POST /pods/:podId/message — send message
  app.post('/pods/:podId/message', async (request) => {
    const { podId } = request.params as { podId: string };
    const { message } = sendMessageSchema.parse(request.body);
    await podManager.sendMessage(podId, message, humanActor(request));
    return { ok: true };
  });

  // GET /pods/:podId/validations — validation history
  // ScreenshotRef fields are converted to ScreenshotRefDto (url/source/path) at
  // serialisation time so the desktop never receives internal path information.
  app.get('/pods/:podId/validations', async (request) => {
    const { podId } = request.params as { podId: string };
    const history = podManager.getValidationHistory(podId);
    return history.map((v) => ({ ...v, result: serializeValidationResult(v.result) }));
  });

  // GET /pods/:podId/validations/:attempt/evidence.yaml — attempt-scoped fact evidence.
  // Evidence is generated by Autopod from stored validation results; it is not
  // authored by the worker and is not committed back into the repository.
  app.get('/pods/:podId/validations/:attempt/evidence.yaml', async (request, reply) => {
    const { podId, attempt } = request.params as { podId: string; attempt: string };
    const parsedAttempt = Number.parseInt(attempt, 10);
    if (!Number.isInteger(parsedAttempt) || parsedAttempt < 1) {
      reply.status(400);
      return { error: 'attempt must be a positive integer' };
    }
    const pod = podManager.getSession(podId);
    const validation = podManager
      .getValidationHistory(podId)
      .find((item) => item.attempt === parsedAttempt);
    if (!validation) {
      reply.status(404);
      return { error: `validation attempt ${parsedAttempt} not found for pod ${podId}` };
    }
    reply.type('text/yaml; charset=utf-8');
    return renderEvidenceYaml({
      podId,
      attempt: parsedAttempt,
      validation: validation.result,
      contract: pod.contract,
    });
  });

  // GET /pods/:podId/events — agent activity events for log replay
  app.get('/pods/:podId/events', async (request, reply) => {
    const { podId } = request.params as { podId: string };
    const query = request.query as { limit?: string };
    const limit = parsePositiveIntegerQueryParam(query.limit);
    if (limit === null) {
      reply.status(400);
      return { error: 'limit must be a positive integer', code: 'invalid_limit' };
    }
    // Verify pod exists (throws 404 if not found)
    podManager.getSession(podId);
    if (!eventRepo) return [];
    const stored = eventRepo.getForSession(podId, {
      types: LOG_REPLAY_EVENT_TYPES,
      latest: limit,
    });
    return stored
      .map((e) => {
        if (e.payload.type === 'pod.firewall_denied') {
          return {
            eventId: e.id,
            type: 'firewall_denied',
            timestamp: e.payload.timestamp,
            message: `Denied egress: ${e.payload.sni}`,
            output: `Source: ${e.payload.src}`,
            sni: e.payload.sni,
            src: e.payload.src,
          };
        }
        if (e.payload.type !== 'pod.agent_activity') return null;
        const raw = e.payload.event as unknown as Record<string, unknown>;
        // Normalize legacy events where `output` was stored as a content-block array
        // (produced before the claude-stream-parser fix in c97af9a).
        if (Array.isArray(raw.output)) {
          const joined = (raw.output as Array<{ text?: string }>)
            .map((b) => b.text ?? '')
            .join('\n');
          return { ...raw, eventId: e.id, output: joined || undefined };
        }
        return { ...raw, eventId: e.id };
      })
      .filter((event): event is Record<string, unknown> => event !== null);
  });

  // GET /pods/:podId/firewall-denials — structured network-denial evidence
  app.get('/pods/:podId/firewall-denials', async (request, reply) => {
    const { podId } = request.params as { podId: string };
    const query = request.query as { limit?: string; until?: string };
    const limit = parsePositiveIntegerQueryParam(query.limit);
    if (limit === null) {
      reply.status(400);
      return { error: 'limit must be a positive integer', code: 'invalid_limit' };
    }
    const until = query.until ? new Date(query.until) : null;
    if (query.until && Number.isNaN(until?.getTime())) {
      reply.status(400);
      return { error: 'until must be an ISO timestamp', code: 'invalid_until' };
    }
    // Verify pod exists (throws 404 if not found)
    podManager.getSession(podId);
    if (!eventRepo) return [];
    const stored = eventRepo.getForSession(podId, {
      type: 'pod.firewall_denied',
      latest: until ? undefined : limit,
    });
    const rows = stored
      .map((e) => {
        const payload = e.payload as FirewallDeniedEvent;
        return {
          eventId: e.id,
          timestamp: payload.timestamp,
          sni: payload.sni,
          src: payload.src,
        };
      })
      .filter((row) => !until || new Date(row.timestamp).getTime() <= until.getTime());
    return limit ? rows.slice(-limit) : rows;
  });

  // GET /pods/:podId/action-audit — structured action-control-plane evidence
  app.get('/pods/:podId/action-audit', async (request, reply) => {
    const { podId } = request.params as { podId: string };
    const query = request.query as { limit?: string; until?: string };
    const limit = parsePositiveIntegerQueryParam(query.limit);
    if (limit === null) {
      reply.status(400);
      return { error: 'limit must be a positive integer', code: 'invalid_limit' };
    }
    const until = query.until ? new Date(query.until) : undefined;
    if (query.until && Number.isNaN(until?.getTime())) {
      reply.status(400);
      return { error: 'until must be an ISO timestamp', code: 'invalid_until' };
    }
    // Verify pod exists (throws 404 if not found)
    podManager.getSession(podId);
    if (!actionAuditRepo) {
      reply.status(503);
      return { error: 'Action audit unavailable — repository not wired' };
    }
    return {
      rows: actionAuditRepo.listBySession(podId, limit ?? 100, until),
      chain: actionAuditRepo.verifyAuditChain(podId),
    };
  });

  // GET /pods/:podId/quality — process-health signals (legacy route name)
  app.get('/pods/:podId/quality', async (request, reply) => {
    const { podId } = request.params as { podId: string };
    // Verify pod exists (throws 404 if not found)
    podManager.getSession(podId);
    if (!podRepo || !eventRepo || !escalationRepo) {
      reply.status(503);
      return { error: 'Quality signals unavailable — repositories not wired' };
    }
    return computeQualitySignals(podId, {
      podRepo,
      eventRepo,
      escalationRepo,
      qualityScoreRepo,
      validationRepo,
      providerAttemptRepo,
    });
  });

  // GET /pods/:podId/cost — per-pod cost grouped into operator-facing buckets
  app.get('/pods/:podId/cost', async (request) => {
    const { podId } = request.params as { podId: string };
    return computePodCostBreakdown(podManager.getSession(podId));
  });

  // GET /pods/quality/trends — daily average process-health scores (legacy route name)
  app.get('/pods/quality/trends', async (request, reply) => {
    if (!qualityScoreRepo) {
      reply.status(503);
      return { error: 'Quality scores unavailable — repository not wired' };
    }
    const query = request.query as { days?: string };
    const days = query.days ? Number.parseInt(query.days, 10) : 30;
    return qualityScoreRepo.getTrends(days);
  });

  // GET /pods/analytics/cost — trailing-window cost analytics
  app.get('/pods/analytics/cost', async (request, reply) => {
    if (!podRepo) {
      reply.status(503);
      return { error: 'Cost analytics unavailable — repository not wired' };
    }
    const days = parseDays(request.query as Record<string, unknown>);
    if (days === null) {
      reply.status(400);
      return { error: 'days must be a positive integer', code: 'invalid_days' };
    }
    return aggregateCost({ podRepo }, { days });
  });

  // GET /pods/analytics/quality — trailing-window process-health analytics
  app.get('/pods/analytics/quality', async (request, reply) => {
    if (!qualityScoreRepo) {
      reply.status(503);
      return { error: 'Quality analytics unavailable — repository not wired' };
    }
    const days = parseDays(request.query as Record<string, unknown>);
    if (days === null || days > 365) {
      reply.status(400);
      return { error: 'days must be a positive integer <= 365', code: 'invalid_days' };
    }
    return qualityScoreRepo.getQualityAnalytics(days);
  });

  // GET /pods/analytics/reliability — outcome quality: first pass, funnel, and stage failures
  app.get('/pods/analytics/reliability', async (request, reply) => {
    if (!db) {
      reply.status(503);
      return { error: 'Reliability analytics unavailable — db not wired' };
    }
    const days = parseDays(request.query as Record<string, unknown>);
    if (days === null || days > 365) {
      reply.status(400);
      return { error: 'days must be a positive integer <= 365', code: 'invalid_days' };
    }
    return computeReliabilityAnalytics(db, days);
  });

  // GET /pods/analytics/throughput — throughput composite analytics
  app.get('/pods/analytics/throughput', async (request, reply) => {
    if (!db) {
      reply.status(503);
      return { error: 'Throughput analytics unavailable — db not wired' };
    }
    const days = parseDays(request.query as Record<string, unknown>);
    if (days === null || days > 365) {
      reply.status(400);
      return { error: 'days must be a positive integer <= 365', code: 'invalid_days' };
    }
    return computeThroughputAnalytics(db, days);
  });

  // GET /pods/analytics/escalations — escalations composite analytics
  app.get('/pods/analytics/escalations', async (request, reply) => {
    if (!db) {
      reply.status(503);
      return { error: 'Escalations analytics unavailable — db not wired' };
    }
    const days = parseDays(request.query as Record<string, unknown>);
    if (days === null || days > 365) {
      reply.status(400);
      return { error: 'days must be a positive integer <= 365', code: 'invalid_days' };
    }
    const scope = parseEscalationsScope(request.query as Record<string, unknown>);
    if (scope === null) {
      reply.status(400);
      return {
        error: 'scope must be one of interactive, scheduled, all',
        code: 'invalid_scope',
      };
    }
    return computeEscalationsAnalytics(db, days, { scope });
  });

  // GET /pods/analytics/safety — trailing-window guardrail-fire totals, quarantine histogram,
  // injection table, audit-chain status, network-policy distribution
  app.get('/pods/analytics/safety', async (request, reply) => {
    if (!db || !safetyEventsRepo) {
      reply.status(503);
      return { error: 'Safety analytics unavailable — db or safety repo not wired' };
    }
    const days = parseDays(request.query as Record<string, unknown>);
    if (days === null || days > 365) {
      reply.status(400);
      return { error: 'days must be a positive integer <= 365', code: 'invalid_days' };
    }
    return computeSafetyAnalytics(db, safetyEventsRepo, days);
  });

  // POST /audit-chain/verify — runs a fleet-wide audit-chain integrity check and persists result
  app.post('/audit-chain/verify', async (_request, reply) => {
    if (!db) {
      reply.status(503);
      return { error: 'Audit chain verification unavailable — db not wired' };
    }
    return runAndPersistAuditChainVerification(db);
  });

  // GET /pods/analytics/models — per-model leaderboard, failure-stage matrix, fleet aggregates
  app.get('/pods/analytics/models', async (request, reply) => {
    if (!db) {
      reply.status(503);
      return { error: 'Models analytics unavailable — db not wired' };
    }
    const days = parseDays(request.query as Record<string, unknown>);
    if (days === null || days > 365) {
      reply.status(400);
      return { error: 'days must be a positive integer <= 365', code: 'invalid_days' };
    }
    return computeModelsAnalytics(db, days);
  });

  // GET /pods/analytics/memory — evidence-only memory effectiveness card.
  app.get('/pods/analytics/memory', async (request, reply) => {
    if (!db) {
      reply.status(503);
      return { error: 'Memory analytics unavailable — db not wired' };
    }
    const days = parseDays(request.query as Record<string, unknown>);
    if (days === null || days > 365) {
      reply.status(400);
      return { error: 'days must be a positive integer <= 365', code: 'invalid_days' };
    }
    return computeMemoryEffectivenessAnalytics(db, days);
  });

  // GET /pods/scores — persisted process-health leaderboard / history
  app.get('/pods/scores', async (request, reply) => {
    if (!qualityScoreRepo) {
      reply.status(503);
      return { error: 'Quality scores unavailable — repository not wired' };
    }
    const query = request.query as {
      runtime?: string;
      model?: string;
      profileName?: string;
      since?: string;
      limit?: string;
    };
    return qualityScoreRepo.list({
      runtime: query.runtime as 'claude' | 'codex' | 'copilot' | 'pi' | undefined,
      model: query.model,
      profileName: query.profileName,
      since: query.since,
      limit: query.limit ? Number.parseInt(query.limit, 10) : undefined,
    });
  });

  // POST /pods/:podId/validate — trigger validation (agent rework on failure)
  app.post('/pods/:podId/validate', async (request, reply) => {
    const { podId } = request.params as { podId: string };
    const pod = podManager.getSession(podId);
    const isTerminalRework = ['failed', 'review_required', 'killed', 'validated'].includes(
      pod.status,
    );
    if (!isTerminalRework) {
      await podManager.triggerValidation(podId, { force: true });
      return { ok: true };
    }
    if (!reworkRuns.has(podId)) {
      const run = podManager
        .triggerValidation(podId, { force: true })
        .catch((err: unknown) => {
          app.log.warn({ err, podId }, 'Detached pod Rework failed');
        })
        .finally(() => {
          reworkRuns.delete(podId);
        });
      reworkRuns.set(podId, run);
    }
    reply.status(202);
    return { ok: true, accepted: true };
  });

  // POST /pods/:podId/revalidate — pull latest + validate only (no agent rework)
  app.post('/pods/:podId/revalidate', async (request) => {
    const { podId } = request.params as { podId: string };
    const result = await podManager.revalidateSession(podId);
    return result;
  });

  // POST /pods/:podId/extend-attempts — add more validation attempts to a review_required pod
  app.post('/pods/:podId/extend-attempts', async (request, reply) => {
    const { podId } = request.params as { podId: string };
    const body = (request.body ?? {}) as { additionalAttempts?: number };
    const additionalAttempts = body.additionalAttempts ?? 3;
    await podManager.extendAttempts(podId, additionalAttempts);
    const pod = podManager.getSession(podId);
    reply.status(202);
    return { ok: true, maxValidationAttempts: pod.maxValidationAttempts };
  });

  // POST /pods/:podId/extend-pr-attempts — extend PR fix attempts for an exhausted-attempts failed pod
  app.post('/pods/:podId/extend-pr-attempts', async (request) => {
    const { podId } = request.params as { podId: string };
    const body = (request.body ?? {}) as { additionalAttempts?: number };
    const additionalAttempts = body.additionalAttempts ?? 3;
    await podManager.extendPrAttempts(podId, additionalAttempts);
    const pod = podManager.getSession(podId);
    return { ok: true, maxPrFixAttempts: pod.maxPrFixAttempts };
  });

  // POST /pods/:podId/retry-pr — retry PR creation for a complete pod with no PR
  app.post('/pods/:podId/retry-pr', async (request, reply) => {
    const { podId } = request.params as { podId: string };
    try {
      await podManager.retryCreatePr(podId);
      return { ok: true };
    } catch (err) {
      if (err instanceof AutopodError) {
        reply.status(err.statusCode ?? 400);
        return { error: err.message };
      }
      throw err;
    }
  });

  // POST /pods/:podId/resume — operator escape hatch for failed pods and
  // infrastructure-blocked review_required pods. Picks the cheapest recovery path:
  // push + open PR if validation passed, otherwise validation-only. No agent rework.
  app.post('/pods/:podId/resume', async (request, reply) => {
    const { podId } = request.params as { podId: string };
    try {
      const result = await podManager.resumePod(podId);
      return { ok: true, action: result.action };
    } catch (err) {
      if (err instanceof AutopodError) {
        reply.status(err.statusCode ?? 400);
        return { error: err.message, code: err.code };
      }
      throw err;
    }
  });

  // POST /pods/:podId/continue-provider — provider-limit continuation or an
  // explicit failed-pod recovery on the profile's current primary provider.
  // Kept separate from downstream-only Resume and generic Rework semantics.
  app.post('/pods/:podId/continue-provider', async (request, reply) => {
    const { podId } = request.params as { podId: string };
    const body = (request.body ?? {}) as {
      primary?: boolean;
      target?: {
        providerAccountId: string;
        runtime: 'claude' | 'codex' | 'copilot' | 'pi';
        model: string;
      };
    };
    try {
      if (body.primary && body.target) {
        throw new AutopodError(
          'Specify either profile-primary recovery or an explicit target, not both',
          'INVALID_PROVIDER_TARGET',
          400,
        );
      }
      const result = await podManager.continueProvider(
        podId,
        body.primary ? 'profile-primary' : body.target,
      );
      return { ok: true, action: result.action };
    } catch (err) {
      if (err instanceof AutopodError) {
        reply.status(err.statusCode ?? 400);
        return { error: err.message, code: err.code };
      }
      throw err;
    }
  });

  // POST /pods/:podId/kick — operator unstick: re-enqueue a stuck queued pod, or
  // stop and fail a stuck running/provisioning/validating pod so its concurrency slot frees up.
  app.post('/pods/:podId/kick', async (request, reply) => {
    const { podId } = request.params as { podId: string };
    const body = (request.body ?? {}) as { reason?: string };
    const reason =
      typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : undefined;
    try {
      const result = await podManager.kickPod(podId, reason, humanActor(request));
      return { ok: true, action: result.action };
    } catch (err) {
      if (err instanceof AutopodError) {
        reply.status(err.statusCode ?? 400);
        return { error: err.message, code: err.code };
      }
      throw err;
    }
  });

  // POST /pods/:podId/force-complete — admin override: transition `failed → complete`,
  // skipping push, PR creation, and merge. Operator accepts the worktree as-is.
  app.post('/pods/:podId/force-complete', async (request, reply) => {
    const { podId } = request.params as { podId: string };
    const body = (request.body ?? {}) as { reason?: string };
    const reason =
      typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : undefined;
    try {
      await podManager.forceComplete(podId, reason, humanActor(request));
      return { ok: true };
    } catch (err) {
      if (err instanceof AutopodError) {
        reply.status(err.statusCode ?? 400);
        return { error: err.message, code: err.code };
      }
      throw err;
    }
  });

  // POST /pods/:podId/spawn-fix — queue a fix-feedback message for a pod's PR.
  // Queue-driven: every call enqueues the message; the canonical fix pod is
  // spawned/recycled by maybeSpawnFixSession and drains the queue when it runs.
  const spawnFixBodySchema = z.object({
    message: z.string().min(1).max(8000),
  });
  app.post('/pods/:podId/spawn-fix', async (request, reply) => {
    const { podId } = request.params as { podId: string };

    const parsed = spawnFixBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.flatten() };
    }

    try {
      const result = await podManager.requestFixSession(podId, parsed.data.message);
      if (!result.ok) {
        // parent is terminal — nothing to fix
        reply.status(409);
        return result;
      }
      reply.status(202);
      return result;
    } catch (err) {
      if (err instanceof AutopodError) {
        reply.status(err.statusCode ?? 400);
        return { error: err.message, code: err.code };
      }
      throw err;
    }
  });

  // POST /pods/:podId/fix-manually — create linked workspace for human fixes
  app.post('/pods/:podId/fix-manually', async (request, reply) => {
    const { podId } = request.params as { podId: string };
    const workspace = podManager.fixManually(podId, humanActor(request), {
      email: request.user.preferred_username,
      name: request.user.name,
    });
    reply.status(201);
    return workspace;
  });

  const approvePodBodySchema = z
    .object({
      squash: z.boolean().optional(),
      reason: z.string().max(2000).optional(),
    })
    .default({});

  // POST /pods/:podId/approve — approve pod
  app.post('/pods/:podId/approve', async (request) => {
    const { podId } = request.params as { podId: string };
    const body = approvePodBodySchema.parse(request.body ?? {});
    await podManager.approveSession(podId, {
      squash: body.squash,
      reason: body.reason,
      actor: humanActor(request),
    });
    return { ok: true };
  });

  // POST /pods/:podId/reject — reject pod
  app.post('/pods/:podId/reject', async (request) => {
    const { podId } = request.params as { podId: string };
    const body = (request.body ?? {}) as { feedback?: string };
    await podManager.rejectSession(podId, body.feedback, humanActor(request));
    return { ok: true };
  });

  // POST /pods/approve-all — approve all validated pods
  app.post('/pods/approve-all', async () => {
    return podManager.approveAllValidated();
  });

  // POST /pods/kill-failed — kill all failed pods
  app.post('/pods/kill-failed', async () => {
    return podManager.killAllFailed();
  });

  // POST /pods/:podId/pause — pause a running pod
  app.post('/pods/:podId/pause', async (request) => {
    const { podId } = request.params as { podId: string };
    await podManager.pauseSession(podId);
    return { ok: true };
  });

  // POST /pods/:podId/nudge — queue a soft message for a running agent
  app.post('/pods/:podId/nudge', async (request) => {
    const { podId } = request.params as { podId: string };
    const { message } = sendMessageSchema.parse(request.body);
    podManager.nudgeSession(podId, message);
    return { ok: true };
  });

  // POST /pods/:podId/inject-credential — inject a provider PAT into the container
  app.post('/pods/:podId/inject-credential', async (request, reply) => {
    const { podId } = request.params as { podId: string };
    const { service } = request.body as { service: 'github' | 'ado' };
    if (service !== 'github' && service !== 'ado') {
      reply.status(400);
      return { error: 'service must be "github" or "ado"' };
    }
    try {
      await podManager.injectCredential(podId, service);
      return { ok: true };
    } catch (err) {
      if (err instanceof AutopodError) {
        reply.status(err.statusCode ?? 400);
        return { message: err.message, code: err.code };
      }
      throw err;
    }
  });

  // POST /pods/:podId/install-cli — install gh or az CLI into the container (no credentials)
  app.post('/pods/:podId/install-cli', async (request, reply) => {
    const { podId } = request.params as { podId: string };
    const { tool } = request.body as { tool: 'gh' | 'az' };
    if (tool !== 'gh' && tool !== 'az') {
      reply.status(400);
      return { error: 'tool must be "gh" or "az"' };
    }
    try {
      await podManager.installCliTool(podId, tool);
      return { ok: true };
    } catch (err) {
      if (err instanceof AutopodError) {
        reply.status(err.statusCode ?? 400);
        return { message: err.message, code: err.code };
      }
      throw err;
    }
  });

  // POST /pods/:podId/recover-worktree — attempt to recover a worktree-compromised pod.
  // First tries pulling files from the live container; falls back to restoring deleted
  // files from HEAD when the bare repo already has the agent's commits. Returns 200
  // with `{recovered, message}` either way — recovery success/failure is in the body,
  // not the HTTP status, so the UI gets the human-readable reason on both paths.
  // 4xx is reserved for semantic failures (pod doesn't exist, not compromised, etc.).
  app.post('/pods/:podId/recover-worktree', async (request, reply) => {
    const { podId } = request.params as { podId: string };
    try {
      const result = await podManager.recoverWorktree(podId);
      return result;
    } catch (err) {
      if (err instanceof AutopodError) {
        reply.status(err.statusCode ?? 400);
        return { error: err.message, code: err.code };
      }
      throw err;
    }
  });

  // POST /pods/:podId/complete — complete an interactive pod.
  // Without a body this pushes the branch and transitions to `complete`.
  // With `promoteTo` set to 'pr' | 'artifact' | 'none', the pod is
  // handed off to an agent-driven run on the same ID.
  app.post('/pods/:podId/complete', async (request, reply) => {
    const { podId } = request.params as { podId: string };
    const body = (request.body ?? {}) as {
      promoteTo?: 'pr' | 'branch' | 'artifact' | 'none';
      instructions?: string;
      skipAgent?: boolean;
    };
    try {
      const result = await podManager.completeSession(podId, {
        promoteTo: body.promoteTo,
        instructions: body.instructions,
        skipAgent: body.skipAgent,
      });
      return { ok: true, ...result };
    } catch (err) {
      if (err instanceof AutopodError) {
        reply.status(err.statusCode ?? 400);
        return { error: err.message, code: err.code };
      }
      throw err;
    }
  });

  // POST /pods/:podId/promote — in-place interactive → auto promotion.
  // Alias of `/complete` with a promoteTo target.
  app.post('/pods/:podId/promote', async (request, reply) => {
    const { podId } = request.params as { podId: string };
    const body = (request.body ?? {}) as {
      targetOutput?: 'pr' | 'branch' | 'artifact' | 'none';
      instructions?: string;
      skipAgent?: boolean;
    };
    const target = body.targetOutput ?? 'pr';
    try {
      await podManager.promoteToAuto(podId, target, {
        instructions: body.instructions,
        skipAgent: body.skipAgent,
      });
      reply.status(202);
      return { ok: true, promotedTo: target };
    } catch (err) {
      if (err instanceof AutopodError) {
        reply.status(err.statusCode ?? 400);
        return { error: err.message, code: err.code };
      }
      throw err;
    }
  });

  // POST /pods/:podId/sync-branch — commit + push a running workspace's branch
  // without changing pod state. Called by the desktop right before opening the
  // Create Series sheet so "Path on branch" can read briefs the user just wrote
  // (workspace pods don't auto-push until container exit). Best-effort: errors
  // are returned in the body so the caller can fall through to a folder-based
  // brief preview instead of failing the whole flow.
  app.post('/pods/:podId/sync-branch', async (request, reply) => {
    const { podId } = request.params as { podId: string };
    try {
      const result = await podManager.syncWorkspaceBranch(podId);
      return { ok: !result.error, ...result };
    } catch (err) {
      if (err instanceof AutopodError) {
        reply.status(err.statusCode ?? 400);
        return { error: err.message, code: err.code };
      }
      throw err;
    }
  });

  // POST /pods/:podId/kill — kill pod
  app.post('/pods/:podId/kill', async (request) => {
    const { podId } = request.params as { podId: string };
    await podManager.killSession(podId);
    return { ok: true };
  });

  // POST /pods/:podId/preview — start preview (pod-token auth)
  app.post('/pods/:podId/preview', { config: { auth: 'pod-token' } }, async (request) => {
    const { podId } = request.params as { podId: string };
    const result = await podManager.startPreview(podId);
    return {
      ...result,
      previewUrl: rewritePreviewUrlForRequest(podId, result.previewUrl, request),
    };
  });

  async function proxyPreviewRequestForPod(
    podId: string,
    request: FastifyRequest,
    reply: FastifyReply,
    targetUrlForRequest: (previewUrl: string) => string,
  ) {
    const status = await podManager.previewStatus(podId);
    if (!status.previewUrl) {
      reply.status(409);
      return { error: 'Preview is not available for this pod' };
    }

    const previewUrl = status.previewUrl;
    const targetUrl = targetUrlForRequest(previewUrl);
    const upstream = await fetch(targetUrl, {
      method: request.method,
      headers: proxyRequestHeaders(request.headers),
      body: proxyRequestBody(request.method, request.body),
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });

    reply.status(upstream.status);
    const setCookies = [previewCookie(podId)];
    upstream.headers.forEach((value, name) => {
      const lower = name.toLowerCase();
      if (PREVIEW_PROXY_HOP_BY_HOP_HEADERS.has(lower)) return;
      if (lower === 'set-cookie') {
        setCookies.push(value);
        return;
      }
      if (lower === 'location') {
        reply.header(name, rewritePreviewLocation(value, previewUrl, podId, request));
        return;
      }
      reply.header(name, value);
    });
    reply.header('set-cookie', setCookies);
    return reply.send(Buffer.from(await upstream.arrayBuffer()));
  }

  async function proxyPreviewRequest(request: FastifyRequest, reply: FastifyReply) {
    const { podId } = request.params as { podId: string };
    return proxyPreviewRequestForPod(podId, request, reply, (previewUrl) =>
      rewritePreviewProxyTarget(previewUrl, request.url, podId),
    );
  }

  async function proxyPreviewFallbackRequest(request: FastifyRequest, reply: FastifyReply) {
    const podId = previewPodIdFromRequest(request);
    if (!podId) {
      reply.status(404);
      return { error: 'Not found' };
    }

    return proxyPreviewRequestForPod(podId, request, reply, (previewUrl) =>
      rewritePreviewFallbackTarget(previewUrl, request.url),
    );
  }

  // Browser-friendly preview proxy. Open App cannot attach Authorization headers,
  // and hosted VM dynamic preview ports are not internet-reachable, so browser
  // traffic comes through the daemon's normal HTTPS origin and is forwarded
  // internally to the pod preview server.
  app.all(
    '/pods/:podId/preview/proxy',
    { config: { auth: false, rateLimit: PREVIEW_RATE_LIMIT } },
    proxyPreviewRequest,
  );
  app.all(
    '/pods/:podId/preview/proxy/*',
    { config: { auth: false, rateLimit: PREVIEW_RATE_LIMIT } },
    proxyPreviewRequest,
  );
  app.route({
    method: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
    url: '/*',
    config: { auth: false, rateLimit: PREVIEW_RATE_LIMIT },
    handler: proxyPreviewFallbackRequest,
  });

  // DELETE /pods/:podId/preview — stop preview (pod-token auth)
  app.delete('/pods/:podId/preview', { config: { auth: 'pod-token' } }, async (request) => {
    const { podId } = request.params as { podId: string };
    await podManager.stopPreview(podId);
    return { ok: true };
  });

  // GET /pods/:podId/preview/status — poll supervisor + reachability (pod-token auth)
  app.get('/pods/:podId/preview/status', { config: { auth: 'pod-token' } }, async (request) => {
    const { podId } = request.params as { podId: string };
    const status = await podManager.previewStatus(podId);
    return {
      ...status,
      previewUrl: rewritePreviewUrlForRequest(podId, status.previewUrl, request),
    };
  });

  // DELETE /pods/:podId — delete a terminal pod
  app.delete('/pods/:podId', async (request, reply) => {
    const { podId } = request.params as { podId: string };
    await podManager.deleteSession(podId);
    reply.status(204);
  });

  // POST /pods/:podId/interrupt-validation — abort a running validation
  app.post('/pods/:podId/interrupt-validation', async (request, reply) => {
    const { podId } = request.params as { podId: string };
    podManager.interruptValidation(podId);
    reply.status(204);
  });

  // POST /pods/:podId/update-from-base — rebase pod branch onto latest base and restart validation
  app.post('/pods/:podId/update-from-base', async (request, reply) => {
    const { podId } = request.params as { podId: string };
    try {
      const result = await podManager.updateFromBase(podId);
      reply.status(result.ok ? 200 : 409);
      return result;
    } catch (err) {
      if (err instanceof AutopodError) {
        reply.status(err.statusCode ?? 400);
        return { error: err.message, code: err.code };
      }
      throw err;
    }
  });

  // POST /pods/:podId/skip-validation — toggle skip-validation flag at runtime
  app.post('/pods/:podId/skip-validation', async (request, reply) => {
    const { podId } = request.params as { podId: string };
    const body = request.body as { skip: boolean };
    podManager.setSkipValidation(podId, Boolean(body.skip), humanActor(request));
    reply.status(204);
  });

  // POST /pods/:podId/force-approve — bypass validation and transition pod to validated
  app.post('/pods/:podId/force-approve', async (request, reply) => {
    const { podId } = request.params as { podId: string };
    const body = request.body as { reason?: string } | undefined;
    await podManager.forceApprove(podId, body?.reason, humanActor(request));
    reply.status(204);
  });

  // POST /pods/:podId/facts/:factId/approve-waiver — approve one pending required fact
  // and restart validation-only flow so downstream gates still run.
  app.post('/pods/:podId/facts/:factId/approve-waiver', async (request, reply) => {
    const { podId, factId } = request.params as { podId: string; factId: string };
    const body = (request.body ?? {}) as { reason?: string };
    const reason =
      typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : undefined;
    try {
      const result = await podManager.approveFactWaiver(podId, factId, reason, humanActor(request));
      return { ok: true, ...result };
    } catch (err) {
      if (err instanceof AutopodError) {
        reply.status(err.statusCode ?? 400);
        return { error: err.message, code: err.code };
      }
      throw err;
    }
  });

  // POST /pods/:podId/validation-overrides — enqueue a finding override
  app.post('/pods/:podId/validation-overrides', async (request, reply) => {
    const { podId } = request.params as { podId: string };
    const body = request.body as {
      findingId: string;
      description: string;
      action: 'dismiss' | 'guidance';
      reason?: string;
      guidance?: string;
    };

    if (!pendingOverrideRepo) {
      reply.status(503);
      return { error: 'Override queue not available' };
    }

    pendingOverrideRepo.enqueue(podId, {
      findingId: body.findingId,
      description: body.description,
      action: body.action,
      reason: body.reason,
      guidance: body.guidance,
    });

    const pod = podManager.getSession(podId);

    if (pod.status === 'running') {
      // Nudge the in-flight agent so it can skip the dismissed finding immediately
      const nudgeLines = [
        'A human has overridden a validation finding — you do NOT need to address it.',
        `Finding: ${body.description}`,
      ];
      if (body.reason) nudgeLines.push(`Reason: ${body.reason}`);
      if (body.guidance) nudgeLines.push(`Guidance: ${body.guidance}`);
      try {
        podManager.nudgeSession(podId, nudgeLines.join('\n'));
      } catch {
        // Pod may have transitioned between check and nudge — not fatal
      }
    } else if (pod.status === 'review_required' || pod.status === 'failed') {
      // Instantly re-evaluate the cached validation result with the new override applied.
      // Avoids a full re-run when only subjective review findings need dismissing.
      podManager.applyOverridesInstant(podId).catch((err: unknown) => {
        app.log.warn({ err, podId }, 'Failed to apply instant override');
      });
    }

    reply.status(204);
  });
}
