import type { ManagedPodRequest } from '@autopod/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ManagedControls } from '../../managed/managed-controls.js';
import type { ManagedPodService } from '../../managed/managed-service.js';

const CONTROL_FAILURES = new Set([
  'grant-inactive',
  'invalid-control-key',
  'managed-channel-binding',
  'managed-codex-follow-up-binding',
  'managed-codex-follow-up-command-exit',
  'managed-codex-follow-up-envelope-invalid',
  'managed-codex-follow-up-key-invalid',
  'managed-codex-follow-up-permission',
  'managed-codex-follow-up-replay-conflict',
  'managed-codex-follow-up-state-missing',
  'managed-codex-follow-up-transport-error',
  'managed-codex-follow-up-unavailable',
  'managed-control-conflict',
  'managed-follow-up-delivery-failed',
  'managed-follow-up-event-commit-failed',
  'managed-follow-up-refresh-failed',
  'managed-follow-up-result-commit-failed',
  'managed-follow-up-unavailable',
  'managed-stale-grant',
]);

function controlFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return CONTROL_FAILURES.has(message) ||
    /^managed-codex-follow-up-file-(payload|ready)-(http-(400|401|403|404|409|429|500|502|503|504)|other)$/.test(
      message,
    ) ||
    /^managed-codex-follow-up-file-(binding|key|size)-invalid$/.test(message) ||
    [
      'managed-codex-follow-up-file-capability-missing',
      'managed-codex-follow-up-file-unknown',
    ].includes(message)
    ? message
    : 'managed-control-failure';
}

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 200;

function listLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIST_LIMIT;
  if (!/^[1-9][0-9]{0,2}$/.test(raw)) throw new Error('managed-list-limit-invalid');
  const value = Number(raw);
  if (value > MAX_LIST_LIMIT) throw new Error('managed-list-limit-invalid');
  return value;
}

function listCursor(raw: string | undefined): { createdAt: number; podId: string } | undefined {
  if (raw === undefined) return undefined;
  const separator = raw.indexOf(':');
  const createdAt = raw.slice(0, separator);
  const podId = raw.slice(separator + 1);
  if (
    separator < 1 ||
    !/^(0|[1-9][0-9]{0,15})$/.test(createdAt) ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(podId)
  )
    throw new Error('managed-list-cursor-invalid');
  return { createdAt: Number(createdAt), podId };
}

export interface ManagedPodApiDeps {
  service: ManagedPodService;
  finishOutputs?: () => Promise<void>;
  /** Derived from the authenticated service principal; request bodies cannot supply it. */
  authenticate: (request: FastifyRequest) => Promise<string | null>;
}
export function managedPodRoutes(app: FastifyInstance, deps: ManagedPodApiDeps): void {
  const controls = new ManagedControls(deps.service);
  let timer: ReturnType<typeof setInterval> | undefined;
  let ticking = false;
  app.addHook('onReady', async () => {
    timer = setInterval(() => {
      if (ticking) return;
      ticking = true;
      void deps.service
        .enforceExpiry()
        .then(() => deps.finishOutputs?.())
        .catch(() => app.log.error('managed-watchdog-failed'))
        .finally(() => {
          ticking = false;
        });
    }, 1000);
    timer.unref();
  });
  app.addHook('onClose', async () => {
    if (timer) clearInterval(timer);
  });
  app.get('/managed/health', async (request, reply) => {
    if (!(await deps.authenticate(request)))
      return reply.code(401).send({ code: 'managed-auth-required' });
    return deps.service.health();
  });
  app.get<{ Querystring: { cursor?: string; limit?: string } }>(
    '/managed/pods',
    async (request, reply) => {
      const installation = await deps.authenticate(request);
      if (!installation) return reply.code(401).send({ code: 'managed-auth-required' });
      let limit: number;
      let cursor: { createdAt: number; podId: string } | undefined;
      try {
        limit = listLimit(request.query.limit);
        cursor = listCursor(request.query.cursor);
      } catch {
        return reply.code(400).send({ code: 'managed-list-invalid' });
      }
      const usageStatement = deps.service.db.prepare(
        'SELECT count(*) AS requests,count(actual_tokens) AS known FROM managed_provider_requests WHERE pod_id=?',
      );
      const failureStatement = deps.service.db.prepare(
        `SELECT failure_phase AS phase,failure_reason AS reason,failure_http_status AS httpStatus
         FROM managed_provider_requests
         WHERE pod_id=? AND failure_phase IS NOT NULL
         ORDER BY rowid DESC LIMIT 1`,
      );
      const artifactsStatement = deps.service.db.prepare(
        `SELECT artifact_id AS artifactId,status,file_count AS fileCount,total_bytes AS totalBytes,
                committed_at AS committedAt
         FROM artifact_exports WHERE pod_id=? ORDER BY created_at`,
      );
      const resultStatement = deps.service.db.prepare(
        'SELECT limitations_json FROM managed_results WHERE pod_id=?',
      );
      const lastEventStatement = deps.service.db.prepare(
        'SELECT event_json FROM managed_events WHERE pod_id=? ORDER BY sequence DESC LIMIT 1',
      );
      const rows = deps.service.db
        .prepare(
          `SELECT * FROM managed_pods
             WHERE dispatcher_installation_id=?
               AND (? IS NULL OR created_at < ? OR (created_at = ? AND pod_id < ?))
             ORDER BY created_at DESC, pod_id DESC
             LIMIT ?`,
        )
        .all(
          installation,
          cursor?.createdAt ?? null,
          cursor?.createdAt ?? null,
          cursor?.createdAt ?? null,
          cursor?.podId ?? null,
          limit + 1,
        ) as Array<{
        pod_id: string;
        dispatcher_attempt_id: string;
        request_json: string;
        state: string;
        revoked: number;
        stop_requested: number;
        observed_exit: number;
        cleanup: string;
        consumed_tokens: number;
        exit_code: number | null;
        created_at: number;
      }>;
      const pageRows = rows.slice(0, limit);
      const pods = pageRows.map((row) => {
        const request = JSON.parse(row.request_json) as ManagedPodRequest;
        const usage = usageStatement.get(row.pod_id) as { requests: number; known: number };
        const failure = failureStatement.get(row.pod_id) as
          | { phase: string; reason: string; httpStatus: number | null }
          | undefined;
        const artifacts = artifactsStatement.all(row.pod_id);
        const stored = resultStatement.get(row.pod_id) as { limitations_json: string } | undefined;
        const lastEvent = lastEventStatement.get(row.pod_id) as { event_json: string } | undefined;
        const lastEventAt = lastEvent
          ? ((JSON.parse(lastEvent.event_json) as { createdAt?: number }).createdAt ??
            row.created_at)
          : row.created_at;
        return {
          podId: row.pod_id,
          dispatcherAttemptId: row.dispatcher_attempt_id,
          state: row.state,
          providerAccountId: request.route.providerAccountId,
          model: request.route.model,
          runtime: request.route.runtime,
          executionTarget: request.route.executionTarget,
          reasoning: request.route.reasoning,
          profileId: request.profileSnapshot.profileId,
          profileVersion: request.profileSnapshot.profileVersion,
          providerRequests: usage.requests,
          consumedTokens: row.consumed_tokens,
          tokenUsageKnown: usage.known === usage.requests,
          failure: failure ?? null,
          limitations: stored ? JSON.parse(stored.limitations_json) : [],
          artifacts,
          revoked: Boolean(row.revoked),
          stopRequested: Boolean(row.stop_requested),
          observedExit: Boolean(row.observed_exit),
          cleanup: row.cleanup,
          exitCode: row.exit_code,
          createdAt: row.created_at,
          lastEventAt,
        };
      });
      const last = pageRows.at(-1);
      return {
        schemaVersion: 1,
        pods,
        nextCursor: rows.length > limit && last ? `${last.created_at}:${last.pod_id}` : null,
      };
    },
  );
  app.get<{ Params: { attemptId: string } }>(
    '/managed/attempts/:attemptId',
    async (request, reply) => {
      const installation = await deps.authenticate(request);
      if (!installation) return reply.code(401).send({ code: 'managed-auth-required' });
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(request.params.attemptId))
        return reply.code(400).send({ code: 'managed-attempt-id-invalid' });
      const row = deps.service.db
        .prepare(
          'SELECT handle_json FROM managed_pods WHERE dispatcher_installation_id=? AND dispatcher_attempt_id=?',
        )
        .get(installation, request.params.attemptId) as { handle_json: string } | undefined;
      return row ? JSON.parse(row.handle_json) : null;
    },
  );
  for (const operation of ['preflight', 'pods', 'reconcile-start'] as const) {
    app.post(`/managed/${operation}`, { bodyLimit: 1024 * 1024 }, async (request, reply) => {
      const installation = await deps.authenticate(request);
      if (!installation)
        return reply.code(401).send({
          schemaVersion: 1,
          code: 'managed-auth-required',
          retryable: false,
          requestId: request.id,
        });
      try {
        if (operation === 'preflight') {
          await deps.service.preflight(request.body, installation);
          return { accepted: true };
        }
        if (operation === 'reconcile-start')
          return await deps.service.reconcileStart(installation, request.body);
        return await deps.service.start(installation, request.body);
      } catch {
        return reply.code(409).send({
          schemaVersion: 1,
          code: 'managed-request-rejected',
          retryable: false,
          requestId: request.id,
        });
      }
    });
  }
  app.get<{ Params: { podId: string }; Querystring: { cursor?: string } }>(
    '/managed/pods/:podId/events',
    async (request, reply) => {
      const installation = await deps.authenticate(request);
      if (!installation) return reply.code(401).send({ code: 'managed-auth-required' });
      try {
        return controls.observe(installation, request.params.podId, request.query.cursor ?? '0');
      } catch {
        return reply.code(409).send({
          schemaVersion: 1,
          code: 'managed-observation-rejected',
          retryable: false,
          requestId: request.id,
        });
      }
    },
  );
  app.get<{ Params: { podId: string } }>(
    '/managed/pods/:podId/candidate/bundle',
    async (request, reply) => {
      const installation = await deps.authenticate(request);
      if (!installation) return reply.code(401).send({ code: 'managed-auth-required' });
      try {
        if (!deps.service.source) throw new Error('source-unavailable');
        const value = deps.service.source.candidate(installation, request.params.podId);
        return reply.type('application/octet-stream').send(value.bundle);
      } catch {
        return reply.code(409).send({ code: 'source-candidate-unavailable' });
      }
    },
  );
  app.post<{ Params: { podId: string } }>(
    '/managed/pods/:podId/finalize',
    { bodyLimit: 1024 * 1024 },
    async (request, reply) => {
      const installation = await deps.authenticate(request);
      if (!installation) return reply.code(401).send({ code: 'managed-auth-required' });
      try {
        if (!deps.service.source) throw new Error('source-unavailable');
        return await deps.service.source.finalize(installation, request.params.podId, request.body);
      } catch {
        return reply.code(409).send({ code: 'source-finalize-rejected' });
      }
    },
  );
  for (const operation of ['control', 'send', 'grant'] as const) {
    app.post<{ Params: { podId: string; key: string } }>(
      `/managed/pods/:podId/${operation}/:key`,
      { bodyLimit: 1024 * 1024 },
      async (request, reply) => {
        const installation = await deps.authenticate(request);
        if (!installation) return reply.code(401).send({ code: 'managed-auth-required' });
        try {
          if (operation === 'grant') {
            controls.updateGrant(installation, request.params.podId, request.body);
            return { accepted: true };
          }
          return await controls[operation](
            installation,
            request.params.podId,
            request.body,
            request.params.key,
          );
        } catch (error) {
          app.log.warn({ operation, reason: controlFailure(error) }, 'managed control rejected');
          return reply.code(409).send({
            schemaVersion: 1,
            code: 'managed-control-rejected',
            retryable: false,
            requestId: request.id,
          });
        }
      },
    );
  }
}
