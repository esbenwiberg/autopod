import type { SessionBridge } from '@autopod/escalation-mcp';
import { type PendingRequests, createEscalationMcpServer } from '@autopod/escalation-mcp';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { SessionTokenIssuer } from '../crypto/session-tokens.js';

export function mcpHandler(
  app: FastifyInstance,
  bridge: SessionBridge,
  pendingRequestsBySession: Map<string, PendingRequests>,
  logger: Logger,
  sessionTokenIssuer?: SessionTokenIssuer,
): void {
  // Only pendingRequests is stored per session — the McpServer is created fresh per
  // HTTP request to avoid the "Already connected to a transport" error from the MCP SDK,
  // which caches the transport reference on the server instance and does not reset it
  // when the transport is closed.
  const pendingRequestsPerSession = new Map<string, PendingRequests>();

  function getOrCreatePendingRequests(sessionId: string): PendingRequests {
    let pendingRequests = pendingRequestsPerSession.get(sessionId);
    if (pendingRequests) return pendingRequests;

    const { pendingRequests: created } = createEscalationMcpServer({
      sessionId,
      bridge,
      availableActions: bridge.getAvailableActions(sessionId),
    });

    pendingRequests = created;
    pendingRequestsPerSession.set(sessionId, pendingRequests);
    pendingRequestsBySession.set(sessionId, pendingRequests);
    return pendingRequests;
  }

  // Handle all MCP requests at /mcp/:sessionId
  // A fresh McpServer + transport is created per request so the server instance is
  // never in an "already connected" state. The pendingRequests object is reused across
  // requests to preserve in-flight ask_human / report_blocker state.
  //
  // When a sessionTokenIssuer is available the endpoint requires a session-scoped
  // Bearer token (injected into the container environment during provisioning).
  // This prevents any caller who knows a sessionId from invoking escalation tools
  // for sessions they don't own.
  const authConfig = sessionTokenIssuer ? 'session-token' : (false as const);
  app.all('/mcp/:sessionId', { config: { auth: authConfig } }, async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };

    let pendingRequests: PendingRequests;
    try {
      pendingRequests = getOrCreatePendingRequests(sessionId);
    } catch (err) {
      logger.error({ err, sessionId }, 'Failed to create MCP session');
      reply.status(500).send({ error: 'MCP_SESSION_ERROR', message: String(err) });
      return;
    }

    const availableActions = bridge.getAvailableActions(sessionId);
    const { server } = createEscalationMcpServer({
      sessionId,
      bridge,
      availableActions,
      pendingRequests,
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    try {
      await server.connect(transport);
    } catch (err) {
      logger.error({ err, sessionId }, 'Failed to connect MCP transport');
      reply.status(500).send({ error: 'MCP_CONNECT_ERROR', message: String(err) });
      return;
    }

    try {
      // Tell Fastify we're handling the response manually via reply.raw
      // so it doesn't try to send its own response after the transport writes.
      reply.hijack();
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (err) {
      logger.error({ err, sessionId }, 'MCP handleRequest error');
    } finally {
      await transport.close().catch((err) => {
        logger.debug({ err, sessionId }, 'MCP transport close error (non-fatal)');
      });
    }
  });

  // Cleanup on server close
  app.addHook('onClose', async () => {
    for (const [, pendingRequests] of pendingRequestsPerSession) {
      pendingRequests.cancelAll();
    }
    pendingRequestsPerSession.clear();
  });
}
