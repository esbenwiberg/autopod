import {
  AutopodError,
  type PodStatus,
  createPodRequestSchema,
  sendMessageSchema,
} from '@autopod/shared';
import type { FastifyInstance } from 'fastify';
import type { PodTokenIssuer } from '../../crypto/pod-tokens.js';
import type { EventRepository } from '../../pods/event-repository.js';
import type { PodManager } from '../../pods/index.js';
import type { PendingOverrideRepository } from '../../pods/pending-override-repository.js';
import { generateValidationReport } from '../../validation/report-generator.js';

export function podRoutes(
  app: FastifyInstance,
  podManager: PodManager,
  sessionTokenIssuer?: PodTokenIssuer,
  eventRepo?: EventRepository,
  pendingOverrideRepo?: PendingOverrideRepository,
): void {
  // POST /pods — create a new pod
  app.post('/pods', async (request, reply) => {
    const body = createPodRequestSchema.parse(request.body);

    // Interactive pods are local-only — reject if execution target is not 'local'
    const isInteractive =
      body.options?.agentMode === 'interactive' || body.outputMode === 'workspace';
    if (isInteractive) {
      const resolvedTarget = body.executionTarget ?? 'local';
      if (resolvedTarget !== 'local') {
        reply.status(400);
        return { error: 'Interactive pods only support local execution target' };
      }
    }

    try {
      const pod = podManager.createSession(body, request.user.oid);
      reply.status(201);
      return pod;
    } catch (err) {
      if (err instanceof AutopodError) {
        reply.status(err.statusCode ?? 400);
        return { error: err.message };
      }
      throw err;
    }
  });

  // GET /pods — list pods
  app.get('/pods', async (request) => {
    const query = request.query as { profileName?: string; status?: string; userId?: string };
    return podManager.listSessions({
      profileName: query.profileName,
      status: query.status as PodStatus | undefined,
      userId: query.userId,
    });
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
    return podManager.getSession(podId);
  });

  // POST /pods/:podId/message — send message
  app.post('/pods/:podId/message', async (request) => {
    const { podId } = request.params as { podId: string };
    const { message } = sendMessageSchema.parse(request.body);
    await podManager.sendMessage(podId, message);
    return { ok: true };
  });

  // GET /pods/:podId/validations — validation history
  app.get('/pods/:podId/validations', async (request) => {
    const { podId } = request.params as { podId: string };
    return podManager.getValidationHistory(podId);
  });

  // GET /pods/:podId/events — agent activity events for log replay
  app.get('/pods/:podId/events', async (request) => {
    const { podId } = request.params as { podId: string };
    // Verify pod exists (throws 404 if not found)
    podManager.getSession(podId);
    if (!eventRepo) return [];
    const stored = eventRepo.getForSession(podId);
    return stored
      .filter((e) => e.type === 'pod.agent_activity')
      .map((e) => {
        const raw = (e.payload as unknown as { event: Record<string, unknown> }).event;
        // Normalize legacy events where `output` was stored as a content-block array
        // (produced before the claude-stream-parser fix in c97af9a).
        if (raw && typeof raw === 'object' && Array.isArray(raw.output)) {
          const joined = (raw.output as Array<{ text?: string }>)
            .map((b) => b.text ?? '')
            .join('\n');
          return { ...raw, output: joined || undefined };
        }
        return raw;
      });
  });

  // GET /pods/:podId/report — HTML validation report (pod-token auth)
  app.get('/pods/:podId/report', { config: { auth: 'pod-token' } }, async (request, reply) => {
    const { podId } = request.params as { podId: string };
    const queryToken = (request.query as Record<string, string>)?.token;
    const pod = podManager.getSession(podId);
    const validations = podManager.getValidationHistory(podId);
    const html = generateValidationReport(pod, validations, queryToken);
    reply.type('text/html').send(html);
  });

  // GET /pods/:podId/report/token — generate a pod token for report access
  app.get('/pods/:podId/report/token', async (request) => {
    const { podId } = request.params as { podId: string };
    // Verify pod exists
    podManager.getSession(podId);
    if (!sessionTokenIssuer) {
      return { token: null, reportUrl: `/pods/${podId}/report` };
    }
    const token = sessionTokenIssuer.generate(podId);
    return {
      token,
      reportUrl: `/pods/${podId}/report?token=${encodeURIComponent(token)}`,
    };
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

  // POST /pods/:podId/spawn-fix — manually force-spawn a fix pod for merge_pending or complete
  app.post('/pods/:podId/spawn-fix', async (request, reply) => {
    const { podId } = request.params as { podId: string };
    const body = (request.body ?? {}) as { userMessage?: string };
    const userMessage =
      typeof body.userMessage === 'string' && body.userMessage.trim()
        ? body.userMessage.trim()
        : undefined;
    try {
      await podManager.spawnFixSession(podId, userMessage);
      reply.status(202);
      return { ok: true };
    } catch (err) {
      if (err instanceof AutopodError) {
        reply.status(err.statusCode ?? 400);
        return { error: err.message };
      }
      throw err;
    }
  });

  // POST /pods/:podId/fix-manually — create linked workspace for human fixes
  app.post('/pods/:podId/fix-manually', async (request, reply) => {
    const { podId } = request.params as { podId: string };
    const workspace = podManager.fixManually(podId, request.user.oid);
    reply.status(201);
    return workspace;
  });

  // POST /pods/:podId/approve — approve pod
  app.post('/pods/:podId/approve', async (request) => {
    const { podId } = request.params as { podId: string };
    const body = (request.body ?? {}) as { squash?: boolean };
    await podManager.approveSession(podId, { squash: body.squash });
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

  // POST /pods/:podId/complete — complete an interactive pod.
  // Without a body this pushes the branch and transitions to `complete`.
  // With `promoteTo` set to 'pr' | 'artifact' | 'none', the pod is
  // handed off to an agent-driven run on the same ID.
  app.post('/pods/:podId/complete', async (request, reply) => {
    const { podId } = request.params as { podId: string };
    const body = (request.body ?? {}) as {
      promoteTo?: 'pr' | 'branch' | 'artifact' | 'none';
    };
    try {
      const result = await podManager.completeSession(podId, {
        promoteTo: body.promoteTo,
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
    };
    const target = body.targetOutput ?? 'pr';
    try {
      await podManager.promoteToAuto(podId, target);
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

  // POST /pods/:podId/kill — kill pod
  app.post('/pods/:podId/kill', async (request) => {
    const { podId } = request.params as { podId: string };
    await podManager.killSession(podId);
    return { ok: true };
  });

  // POST /pods/:podId/preview — start preview (pod-token auth)
  app.post('/pods/:podId/preview', { config: { auth: 'pod-token' } }, async (request) => {
    const { podId } = request.params as { podId: string };
    return podManager.startPreview(podId);
  });

  // DELETE /pods/:podId/preview — stop preview (pod-token auth)
  app.delete('/pods/:podId/preview', { config: { auth: 'pod-token' } }, async (request) => {
    const { podId } = request.params as { podId: string };
    await podManager.stopPreview(podId);
    return { ok: true };
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

    reply.status(204);
  });
}
