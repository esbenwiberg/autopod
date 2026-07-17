import {
  AutopodError,
  type CompactPod,
  type FirewallDeniedEvent,
  type PodStatus,
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
import { resolvePublicPreviewOrigin, rewritePreviewUrlForBrowser } from '../preview-url.js';
import { serializePodForWire, serializeValidationResult } from '../wire-serializers.js';

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

function compactPod(pod: ReturnType<PodManager['getSession']>): CompactPod {
  const title = pod.briefTitle ?? pod.task.split('\n', 1)[0]?.slice(0, 160) ?? pod.id;
  return {
    id: pod.id,
    title,
    taskSummary: pod.taskSummary?.actualSummary ?? null,
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
    containerId: pod.containerId,
    worktreePath: pod.worktreePath,
    createdAt: pod.createdAt,
    startedAt: pod.startedAt,
    runningAt: pod.runningAt,
    updatedAt: pod.updatedAt,
    completedAt: pod.completedAt,
    lastHeartbeatAt: pod.lastHeartbeatAt,
    failureReason: pod.failureReason,
    mergeBlockReason: pod.mergeBlockReason,
    lastCorrectionMessage: pod.lastCorrectionMessage,
    pendingEscalationSummary: pod.pendingEscalation?.question ?? null,
    progressSummary: pod.progress
      ? `${pod.progress.phase}: ${pod.progress.description}`.slice(0, 240)
      : null,
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
): unknown {
  const wire = serializePodForWire(pod) as Record<string, unknown>;
  if (typeof wire.previewUrl === 'string') {
    wire.previewUrl = rewritePreviewUrlForRequest(pod.id, wire.previewUrl, request);
  }
  return wire;
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
  return previewPodIdFromReferer(request) ?? previewPodIdFromCookie(request);
}

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
  // POST /pods — create a new pod
  app.post('/pods', async (request, reply) => {
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
      return serializePodForRequest(pod, request);
    } catch (err) {
      if (err instanceof AutopodError) {
        reply.status(err.statusCode ?? 400);
        return { error: err.message };
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
    const rawStatuses = query.status?.split(',').filter(Boolean);
    const invalidStatus = rawStatuses?.find((status) => !podStatusSchema.safeParse(status).success);
    if (invalidStatus !== undefined) {
      reply.status(400);
      return { error: `Unknown pod status: ${invalidStatus}`, code: 'invalid_status' };
    }
    const statuses = rawStatuses as PodStatus[] | undefined;
    const pods = podManager.listSessions({
      profileName: query.profileName ?? query.profile,
      status: statuses,
      userId: query.userId,
      limit,
    });
    if (query.compact === 'true') return pods.map(compactPod);
    return pods.map((pod) => serializePodForRequest(pod, request));
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
    return serializePodForRequest(podManager.getSession(podId), request);
  });

  // POST /pods/:podId/message — send message
  app.post('/pods/:podId/message', async (request) => {
    const { podId } = request.params as { podId: string };
    const { message } = sendMessageSchema.parse(request.body);
    await podManager.sendMessage(podId, message);
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

  // GET /pods/:podId/quality — behavioural quality signals computed on the fly
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
    });
  });

  // GET /pods/:podId/cost — per-pod cost grouped into operator-facing buckets
  app.get('/pods/:podId/cost', async (request) => {
    const { podId } = request.params as { podId: string };
    return computePodCostBreakdown(podManager.getSession(podId));
  });

  // GET /pods/quality/trends — daily average quality scores (trailing N days)
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

  // GET /pods/analytics/quality — trailing-window quality composite analytics
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

  // GET /pods/analytics/reliability — trailing-window reliability funnel + stage failure analytics
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

  // GET /pods/scores — persisted quality-score leaderboard / history
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
  app.post('/pods/:podId/validate', async (request) => {
    const { podId } = request.params as { podId: string };
    await podManager.triggerValidation(podId, { force: true });
    return { ok: true };
  });

  // POST /pods/:podId/revalidate — pull latest + validate only (no agent rework)
  app.post('/pods/:podId/revalidate', async (request) => {
    const { podId } = request.params as { podId: string };
    const result = await podManager.revalidateSession(podId);
    return result;
  });

  // POST /pods/:podId/extend-attempts — add more validation attempts to a review_required pod
  app.post('/pods/:podId/extend-attempts', async (request) => {
    const { podId } = request.params as { podId: string };
    const body = (request.body ?? {}) as { additionalAttempts?: number };
    const additionalAttempts = body.additionalAttempts ?? 3;
    await podManager.extendAttempts(podId, additionalAttempts);
    const pod = podManager.getSession(podId);
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

  // POST /pods/:podId/resume — operator escape hatch for `failed` pods.
  // Picks the cheapest recovery path that fits the pod's state — push + open PR
  // if validation already passed, re-run validation otherwise. No agent rework.
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

  // POST /pods/:podId/kick — operator unstick: re-enqueue a stuck queued pod, or
  // stop and fail a stuck running/provisioning/validating pod so its concurrency slot frees up.
  app.post('/pods/:podId/kick', async (request, reply) => {
    const { podId } = request.params as { podId: string };
    const body = (request.body ?? {}) as { reason?: string };
    const reason =
      typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : undefined;
    try {
      const result = await podManager.kickPod(podId, reason);
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
      await podManager.forceComplete(podId, reason);
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
    const workspace = podManager.fixManually(podId, request.user.oid, {
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
    await podManager.approveSession(podId, { squash: body.squash, reason: body.reason });
    return { ok: true };
  });

  // POST /pods/:podId/reject — reject pod
  app.post('/pods/:podId/reject', async (request) => {
    const { podId } = request.params as { podId: string };
    const body = (request.body ?? {}) as { feedback?: string };
    await podManager.rejectSession(podId, body.feedback);
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
  app.all('/pods/:podId/preview/proxy', { config: { auth: false } }, proxyPreviewRequest);
  app.all('/pods/:podId/preview/proxy/*', { config: { auth: false } }, proxyPreviewRequest);
  app.route({
    method: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
    url: '/*',
    config: { auth: false },
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
    podManager.setSkipValidation(podId, Boolean(body.skip));
    reply.status(204);
  });

  // POST /pods/:podId/force-approve — bypass validation and transition pod to validated
  app.post('/pods/:podId/force-approve', async (request, reply) => {
    const { podId } = request.params as { podId: string };
    const body = request.body as { reason?: string } | undefined;
    await podManager.forceApprove(podId, body?.reason);
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
      const result = await podManager.approveFactWaiver(podId, factId, reason);
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
    } else if (pod.status === 'review_required') {
      // Instantly re-evaluate the cached validation result with the new override applied.
      // Avoids a full re-run when only subjective review findings need dismissing.
      podManager.applyOverridesInstant(podId).catch((err: unknown) => {
        app.log.warn({ err, podId }, 'Failed to apply instant override');
      });
    }

    reply.status(204);
  });
}
