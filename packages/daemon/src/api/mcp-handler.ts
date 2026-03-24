import type { SessionBridge } from '@autopod/escalation-mcp';
import { type PendingRequests, createEscalationMcpServer } from '@autopod/escalation-mcp';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';

interface McpSession {
  server: McpServer;
  pendingRequests: PendingRequests;
}

export function mcpHandler(
  app: FastifyInstance,
  bridge: SessionBridge,
  pendingRequestsBySession: Map<string, PendingRequests>,
  logger: Logger,
): void {
  const mcpSessions = new Map<string, McpSession>();

  function getOrCreateMcpSession(sessionId: string): McpSession {
    let mcpSession = mcpSessions.get(sessionId);
    if (mcpSession) return mcpSession;

    // Resolve available actions for this session's profile
    const availableActions = bridge.getAvailableActions(sessionId);
    const { server, pendingRequests } = createEscalationMcpServer({
      sessionId,
      bridge,
      availableActions,
    });

    mcpSession = { server, pendingRequests };
    mcpSessions.set(sessionId, mcpSession);
    pendingRequestsBySession.set(sessionId, pendingRequests);

    return mcpSession;
  }

  // Handle all MCP requests at /mcp/:sessionId
  // The MCP SDK's StreamableHTTPServerTransport is stateless — each HTTP request
  // needs a fresh transport instance. We reuse the server (to preserve pendingRequests
  // state) by closing the previous transport after each request, which resets the
  // server's internal transport reference and allows reconnection.
  app.all('/mcp/:sessionId', { config: { auth: false } }, async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };

    let mcpSession: McpSession;
    try {
      mcpSession = getOrCreateMcpSession(sessionId);
    } catch (err) {
      logger.error({ err, sessionId }, 'Failed to create MCP session');
      reply.status(500).send({ error: 'MCP_SESSION_ERROR', message: String(err) });
      return;
    }

    const { server } = mcpSession;
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    try {
      await server.connect(transport);
    } catch (err) {
      logger.error({ err, sessionId }, 'Failed to connect MCP transport (server may already be connected)');
      reply.status(500).send({ error: 'MCP_CONNECT_ERROR', message: String(err) });
      return;
    }

    try {
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (err) {
      logger.error({ err, sessionId }, 'MCP handleRequest error');
    } finally {
      // Close transport so the server resets its _transport reference,
      // allowing it to accept a new connection on the next request.
      await transport.close().catch((err) => {
        logger.debug({ err, sessionId }, 'MCP transport close error (non-fatal)');
      });
    }
  });

  // Cleanup on server close
  app.addHook('onClose', async () => {
    for (const [, mcpSession] of mcpSessions) {
      mcpSession.pendingRequests.cancelAll();
    }
    mcpSessions.clear();
  });
}
