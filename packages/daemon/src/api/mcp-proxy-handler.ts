import type { InjectedMcpServer } from '@autopod/shared';
import { type ProcessContentConfig, processContent } from '@autopod/shared';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { isPrivateUrl } from './ssrf-guard.js';

export interface McpProxyConfig {
  /** Map of podId → injected MCP servers for that pod */
  getServersForPod: (podId: string) => InjectedMcpServer[];
  /** Content processing config (PII + quarantine) */
  contentProcessing?: ProcessContentConfig;
  logger: Logger;
}

/**
 * MCP proxy handler: routes agent MCP calls through the daemon.
 *
 * The agent calls http://daemon:3100/mcp-proxy/{serverName}/{podId}
 * instead of the real MCP server URL. The daemon:
 * 1. Looks up the real URL + auth headers from the injected server config
 * 2. Forwards the request to the real MCP server
 * 3. PII-strips the response
 * 4. Returns the sanitized response to the agent
 *
 * The agent never sees the real MCP server URL or auth headers.
 */
export function mcpProxyHandler(app: FastifyInstance, config: McpProxyConfig): void {
  const { getServersForPod, contentProcessing, logger } = config;
  const log = logger.child({ component: 'mcp-proxy' });

  // Proxy all methods (MCP uses POST for JSON-RPC, GET for SSE).
  // Requires the pod-scoped HMAC token so a pod on pod A cannot
  // impersonate pod B and abuse pod B's injected MCP credentials.
  app.all(
    '/mcp-proxy/:serverName/:podId',
    { config: { auth: 'pod-token' } },
    async (request, reply) => {
      const { serverName, podId } = request.params as { serverName: string; podId: string };

      // Find the injected server for this pod
      const servers = getServersForPod(podId);
      const server = servers.find((s) => s.name === serverName);

      if (!server) {
        log.warn({ podId, serverName }, 'MCP proxy: server not found');
        return reply.status(404).send({ error: `MCP server '${serverName}' not found for pod` });
      }

      // SSRF guard: reject requests targeting private/loopback addresses.
      if (isPrivateUrl(server.url)) {
        log.warn(
          { podId, serverName, url: server.url },
          'MCP proxy: blocked SSRF attempt to private address',
        );
        return reply
          .status(403)
          .send({ error: `MCP server '${serverName}' URL resolves to a private address` });
      }

      log.debug({ podId, serverName, method: request.method }, 'Proxying MCP request');

      try {
        // Forward the request to the real MCP server
        const headers: Record<string, string> = {
          'Content-Type': request.headers['content-type'] ?? 'application/json',
          Accept: request.headers.accept ?? 'application/json',
        };

        // Inject auth headers from the server config
        if (server.headers) {
          for (const [key, value] of Object.entries(server.headers)) {
            headers[key] = value;
          }
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30_000);

        try {
          const response = await fetch(server.url, {
            method: request.method,
            headers,
            body:
              request.method !== 'GET' && request.method !== 'HEAD'
                ? JSON.stringify(request.body)
                : undefined,
            signal: controller.signal,
          });

          clearTimeout(timeout);

          // Read the response
          const responseText = await response.text();

          // Apply content processing (PII + quarantine) to the response
          let processedText = responseText;
          if (contentProcessing) {
            const result = processContent(responseText, contentProcessing);
            processedText = result.text;

            if (result.quarantined) {
              log.warn({ podId, serverName }, 'MCP proxy: response quarantined');
            }
          }

          // Forward response headers we care about
          const responseHeaders: Record<string, string> = {
            'Content-Type': response.headers.get('content-type') ?? 'application/json',
          };

          return reply.status(response.status).headers(responseHeaders).send(processedText);
        } finally {
          clearTimeout(timeout);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err, podId, serverName }, 'MCP proxy: request failed');
        return reply.status(502).send({ error: `MCP proxy error: ${message}` });
      }
    },
  );
}

/**
 * Rewrite injected MCP server URLs to point to the daemon proxy.
 * Called during pod provisioning.
 */
export function rewriteMcpUrls(
  servers: InjectedMcpServer[],
  podId: string,
  proxyBaseUrl: string,
): InjectedMcpServer[] {
  return servers.map((server) => ({
    ...server,
    // Store original URL internally (the proxy handler uses the original from config)
    // Rewrite the URL the agent sees to point to our proxy
    url: `${proxyBaseUrl}/mcp-proxy/${encodeURIComponent(server.name)}/${podId}`,
    // Strip auth headers — the proxy injects them, agent doesn't need them
    headers: undefined,
  }));
}
