import type { PodBridge } from '@autopod/escalation-mcp';
import { createEscalationMcpServer, type PendingRequests } from '@autopod/escalation-mcp';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { PodTokenIssuer } from '../crypto/pod-tokens.js';

export function mcpHandler(
  app: FastifyInstance,
  bridge: PodBridge,
  pendingRequestsByPod: Map<string, PendingRequests>,
  logger: Logger,
  sessionTokenIssuer?: PodTokenIssuer,
  withWorkerScope?: (podId: string, operation: () => Promise<void>) => Promise<void>,
): void {
  // Only pendingRequests is stored per pod — the McpServer is created fresh per
  // HTTP request to avoid the "Already connected to a transport" error from the MCP SDK,
  // which caches the transport reference on the server instance and does not reset it
  // when the transport is closed.
  const pendingRequestsPerSession = new Map<string, PendingRequests>();

  function getOrCreatePendingRequests(podId: string): PendingRequests {
    let pendingRequests = pendingRequestsPerSession.get(podId);
    if (pendingRequests) return pendingRequests;

    const { pendingRequests: created } = createEscalationMcpServer({
      podId,
      bridge,
      availableActions: bridge.getAvailableActions(podId),
    });

    pendingRequests = created;
    pendingRequestsPerSession.set(podId, pendingRequests);
    pendingRequestsByPod.set(podId, pendingRequests);
    return pendingRequests;
  }

  // Handle all MCP requests at /mcp/:podId
  // A fresh McpServer + transport is created per request so the server instance is
  // never in an "already connected" state. The pendingRequests object is reused across
  // requests to preserve in-flight ask_human / report_blocker state.
  //
  // The endpoint always requires a pod-scoped Bearer token (HMAC, injected into
  // the container environment during provisioning). This prevents any caller who
  // knows a podId from invoking escalation tools for pods they don't own.
  //
  // If sessionTokenIssuer is absent, the auth plugin falls through to user-token
  // verification — so requests still fail closed when neither credential is valid.
  if (!sessionTokenIssuer) {
    logger.warn(
      'mcpHandler: sessionTokenIssuer not configured — /mcp/:podId will only accept user tokens',
    );
  }
  app.all('/mcp/:podId', { config: { auth: 'pod-token' } }, async (request, reply) => {
    const { podId } = request.params as { podId: string };

    let pendingRequests: PendingRequests;
    try {
      pendingRequests = getOrCreatePendingRequests(podId);
    } catch (err) {
      logger.error({ err, podId }, 'Failed to create MCP pod');
      reply.status(500).send({ error: 'MCP_SESSION_ERROR', message: String(err) });
      return;
    }

    const availableActions = bridge.getAvailableActions(podId);
    const { server } = createEscalationMcpServer({
      podId,
      bridge,
      availableActions,
      pendingRequests,
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    try {
      await server.connect(transport);
    } catch (err) {
      logger.error({ err, podId }, 'Failed to connect MCP transport');
      reply.status(500).send({ error: 'MCP_CONNECT_ERROR', message: String(err) });
      return;
    }

    let responseFinished = false;
    reply.raw.once('finish', () => {
      responseFinished = true;
    });
    reply.raw.once('close', () => {
      if (responseFinished) return;

      const detachedCount = pendingRequests.markAllDetached('mcp_response_stream_closed');
      if (detachedCount > 0) {
        logger.warn(
          { podId, detachedCount },
          'MCP response stream closed before pending request delivery',
        );
      }
    });

    try {
      // Transport setup awaits I/O. A retained claim may have revoked the old
      // credential epoch since the auth hook; never lend that request a new run's scope.
      if (sessionTokenIssuer && !request.user) {
        const token = request.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];
        if (!token || sessionTokenIssuer.verify(token) !== podId) {
          reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Pod credential epoch changed' });
          return;
        }
      }
      // Tell Fastify we're handling the response manually via reply.raw
      // so it doesn't try to send its own response after the transport writes.
      reply.hijack();
      // Long-blocking tools (ask_human, ask_ai, report_blocker, request_credential,
      // execute_action) can wait up to humanResponseTimeout (default 1h) before
      // resolving. Disable Node's per-request socket idle timeout so the HTTP
      // connection isn't killed mid-wait — otherwise the agent's MCP client sees
      // "transport dropped mid-call" and the daemon resolves an orphaned promise
      // that writes to a closed socket.
      request.raw.setTimeout(0);
      reply.raw.setTimeout?.(0);
      const handle = async () => {
        await transport.handleRequest(request.raw, reply.raw, request.body);
      };
      if (withWorkerScope) await withWorkerScope(podId, handle);
      else await handle();
    } catch (err) {
      logger.error({ err, podId }, 'MCP handleRequest error');
    } finally {
      await transport.close().catch((err) => {
        logger.debug({ err, podId }, 'MCP transport close error (non-fatal)');
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
