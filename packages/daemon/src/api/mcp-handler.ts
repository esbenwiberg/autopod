import type { FastifyInstance } from 'fastify';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { SessionBridge } from '@autopod/escalation-mcp';
import { createEscalationMcpServer, type PendingRequests } from '@autopod/escalation-mcp';
import type { Logger } from 'pino';

interface McpSession {
  transport: StreamableHTTPServerTransport;
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

    const { server, pendingRequests } = createEscalationMcpServer({ sessionId, bridge });

    // Stateless transport — session management is handled by us via sessionId param
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    server.connect(transport).catch((err) => {
      logger.error({ err, sessionId }, 'Failed to connect MCP transport');
    });

    mcpSession = { transport, pendingRequests };
    mcpSessions.set(sessionId, mcpSession);
    pendingRequestsBySession.set(sessionId, pendingRequests);

    return mcpSession;
  }

  // Handle all MCP requests at /mcp/:sessionId
  // The MCP SDK handles GET (SSE) and POST (JSON-RPC) internally
  app.all('/mcp/:sessionId', { config: { auth: false } }, async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const mcpSession = getOrCreateMcpSession(sessionId);

    // Delegate to the MCP transport — it writes directly to the response
    await mcpSession.transport.handleRequest(request.raw, reply.raw, request.body);
  });

  // Cleanup on server close
  app.addHook('onClose', async () => {
    for (const [, mcpSession] of mcpSessions) {
      mcpSession.pendingRequests.cancelAll();
      await mcpSession.transport.close();
    }
    mcpSessions.clear();
  });
}
