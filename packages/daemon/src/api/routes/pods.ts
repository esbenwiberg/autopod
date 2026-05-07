import {
  AutopodError,
  type PodStatus,
  type ScreenshotRef,
  type ValidationResult,
  createPodRequestSchema,
  processContent,
  sendMessageSchema,
} from '@autopod/shared';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { aggregateCost, parseDays } from '../../pods/cost-aggregation.js';
import type { EscalationRepository } from '../../pods/escalation-repository.js';
import type { EventRepository } from '../../pods/event-repository.js';
import type { PodManager } from '../../pods/index.js';
import type { PendingOverrideRepository } from '../../pods/pending-override-repository.js';
import type { PodRepository } from '../../pods/pod-repository.js';
import type { QualityScoreRepository } from '../../pods/quality-score-repository.js';
import { computeQualitySignals } from '../../pods/quality-signals.js';
import { computeReliabilityAnalytics } from '../../pods/reliability-aggregator.js';
import type { ValidationRepository } from '../../pods/validation-repository.js';

/**
 * Wire shape for screenshot references sent to API consumers (desktop, CLI).
 * Internal `ScreenshotRef` (which carries `relativePath`, `podId`, etc.) must
 * never be sent on the wire — desktop decodes by these three fields only.
 */
interface ScreenshotRefDto {
  /** Relative URL: /pods/:podId/screenshots/:source/:filename */
  url: string;
  source: 'smoke' | 'ac' | 'review';
  /**
   * Context label for the screenshot:
   * - smoke: the page URL path (e.g. `/`, `/about`)
   * - ac: the criterion text the screenshot was taken for
   * - review: the screenshot's 0-based array index as a string
   */
  path: string;
}

function toScreenshotRefDto(ref: ScreenshotRef, contextPath: string): ScreenshotRefDto {
  return {
    url: `/pods/${ref.podId}/screenshots/${ref.source}/${ref.filename}`,
    source: ref.source,
    path: contextPath,
  };
}

/**
 * Transform a stored ValidationResult, replacing all ScreenshotRef fields with
 * ScreenshotRefDto shapes suitable for the API wire format.
 * Returns a new object — does not mutate the input.
 */
function serializeValidationResult(result: ValidationResult): unknown {
  const pages = result.smoke.pages.map((page) => {
    if (!page.screenshot) return page;
    const { screenshot, ...rest } = page;
    return { ...rest, screenshot: toScreenshotRefDto(screenshot, page.path) };
  });

  const acValidation = result.acValidation
    ? {
        ...result.acValidation,
        results: result.acValidation.results.map((check) => {
          if (!check.screenshot) return check;
          const { screenshot, ...rest } = check;
          return { ...rest, screenshot: toScreenshotRefDto(screenshot, check.criterion) };
        }),
      }
    : result.acValidation;

  const taskReview = result.taskReview
    ? {
        ...result.taskReview,
        screenshots: result.taskReview.screenshots.map((ref, i) =>
          toScreenshotRefDto(ref, String(i)),
        ),
      }
    : result.taskReview;

  return {
    ...result,
    smoke: { ...result.smoke, pages },
    acValidation,
    taskReview,
  };
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

    // Sanitize human-authored free-text fields. Findings are quarantined into
    // the text (replaced with a marker) but never block pod creation — the
    // scan layer at provisioning is the gate.
    const sanitizeOpts = {
      sanitization: { preset: 'standard' as const },
      quarantine: { enabled: true },
    };
    const sanitized = { ...body };
    if (body.task) sanitized.task = processContent(body.task, sanitizeOpts).text;
    if (body.seriesName) sanitized.seriesName = processContent(body.seriesName, sanitizeOpts).text;
    if (body.seriesDescription)
      sanitized.seriesDescription = processContent(body.seriesDescription, sanitizeOpts).text;

    try {
      const pod = podManager.createSession(sanitized, request.user.oid, {
        email: request.user.preferred_username,
        name: request.user.name,
      });
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
  // ScreenshotRef fields are converted to ScreenshotRefDto (url/source/path) at
  // serialisation time so the desktop never receives internal path information.
  app.get('/pods/:podId/validations', async (request) => {
    const { podId } = request.params as { podId: string };
    const history = podManager.getValidationHistory(podId);
    return history.map((v) => ({ ...v, result: serializeValidationResult(v.result) }));
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
      runtime: query.runtime as 'claude' | 'codex' | 'copilot' | undefined,
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
  // kill+fail a stuck running/provisioning pod so its concurrency slot frees up.
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
    const workspace = podManager.fixManually(podId, request.user.oid, {
      email: request.user.preferred_username,
      name: request.user.name,
    });
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

  // POST /pods/:podId/recover-worktree — attempt to recover a worktree-compromised pod
  // by pulling files from its still-running container and retrying the auto-commit.
  app.post('/pods/:podId/recover-worktree', async (request, reply) => {
    const { podId } = request.params as { podId: string };
    try {
      const result = await podManager.recoverWorktree(podId);
      reply.status(result.recovered ? 200 : 409);
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
