import { createSessionRequestSchema, sendMessageSchema } from '@autopod/shared';
import type { FastifyInstance } from 'fastify';
import type { SessionManager } from '../../sessions/index.js';

export function sessionRoutes(app: FastifyInstance, sessionManager: SessionManager): void {
  // POST /sessions — create a new session
  app.post('/sessions', async (request, reply) => {
    const body = createSessionRequestSchema.parse(request.body);
    const session = sessionManager.createSession(body, request.user.oid);
    reply.status(201);
    return session;
  });

  // GET /sessions — list sessions
  app.get('/sessions', async (request) => {
    const query = request.query as { profileName?: string; status?: string; userId?: string };
    return sessionManager.listSessions({
      profileName: query.profileName,
      status: query.status as any,
      userId: query.userId,
    });
  });

  // GET /sessions/stats — session counts grouped by status
  app.get('/sessions/stats', async (request) => {
    const query = request.query as { profile?: string };
    return sessionManager.getSessionStats({
      profileName: query.profile,
    });
  });

  // GET /sessions/:sessionId — get session
  app.get('/sessions/:sessionId', async (request) => {
    const { sessionId } = request.params as { sessionId: string };
    return sessionManager.getSession(sessionId);
  });

  // POST /sessions/:sessionId/message — send message
  app.post('/sessions/:sessionId/message', async (request) => {
    const { sessionId } = request.params as { sessionId: string };
    const { message } = sendMessageSchema.parse(request.body);
    await sessionManager.sendMessage(sessionId, message);
    return { ok: true };
  });

  // POST /sessions/:sessionId/validate — trigger validation
  app.post('/sessions/:sessionId/validate', async (request) => {
    const { sessionId } = request.params as { sessionId: string };
    await sessionManager.triggerValidation(sessionId);
    return { ok: true };
  });

  // POST /sessions/:sessionId/approve — approve session
  app.post('/sessions/:sessionId/approve', async (request) => {
    const { sessionId } = request.params as { sessionId: string };
    await sessionManager.approveSession(sessionId);
    return { ok: true };
  });

  // POST /sessions/:sessionId/reject — reject session
  app.post('/sessions/:sessionId/reject', async (request) => {
    const { sessionId } = request.params as { sessionId: string };
    const body = (request.body ?? {}) as { reason?: string };
    await sessionManager.rejectSession(sessionId, body.reason);
    return { ok: true };
  });

  // POST /sessions/:sessionId/pause — pause a running session
  app.post('/sessions/:sessionId/pause', async (request) => {
    const { sessionId } = request.params as { sessionId: string };
    await sessionManager.pauseSession(sessionId);
    return { ok: true };
  });

  // POST /sessions/:sessionId/nudge — queue a soft message for a running agent
  app.post('/sessions/:sessionId/nudge', async (request) => {
    const { sessionId } = request.params as { sessionId: string };
    const { message } = sendMessageSchema.parse(request.body);
    sessionManager.nudgeSession(sessionId, message);
    return { ok: true };
  });

  // POST /sessions/:sessionId/kill — kill session
  app.post('/sessions/:sessionId/kill', async (request) => {
    const { sessionId } = request.params as { sessionId: string };
    await sessionManager.killSession(sessionId);
    return { ok: true };
  });

  // DELETE /sessions/:sessionId — delete a terminal session
  app.delete('/sessions/:sessionId', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    await sessionManager.deleteSession(sessionId);
    reply.status(204);
  });
}
