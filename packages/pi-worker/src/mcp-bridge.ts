import { HttpMcpClient } from './http-client.js';
import { StdioMcpClient } from './stdio-client.js';
import type {
  JsonObject,
  McpClient,
  PiWorkerConfig,
  PiWorkerMcpServerConfig,
  RegisteredMcpTool,
} from './types.js';

export function createMcpClient(
  server: PiWorkerMcpServerConfig,
  options: { maxResultBytes?: number } = {},
): McpClient {
  if (server.type === 'stdio') {
    return new StdioMcpClient({
      serverName: server.name,
      command: server.command,
      args: server.args,
      env: server.env,
      maxResultBytes: options.maxResultBytes,
    });
  }
  return new HttpMcpClient({
    serverName: server.name,
    url: server.url,
    headers: server.headers,
    maxResultBytes: options.maxResultBytes,
  });
}

export async function discoverMcpTools(
  config: PiWorkerConfig,
  options: { signal?: AbortSignal; clients?: McpClient[] } = {},
): Promise<{ tools: RegisteredMcpTool[]; clients: McpClient[] }> {
  const clients =
    options.clients ??
    config.mcpServers.map((server) =>
      createMcpClient(server, { maxResultBytes: config.maxResultBytes }),
    );
  const tools: RegisteredMcpTool[] = [];
  const prefix = config.toolNamePrefix ?? '';

  for (const client of clients) {
    await client.initialize(options.signal);
    const definitions = await client.listTools(options.signal);
    for (const definition of definitions) {
      const piName = `${prefix}${definition.name}`;
      tools.push({
        serverName: client.serverName,
        mcpName: definition.name,
        piName,
        description: definition.description,
        inputSchema: definition.inputSchema ?? { type: 'object', properties: {} },
        call: (args: JsonObject, signal?: AbortSignal) =>
          client.callTool(definition.name, args, signal),
      });
    }
  }

  return { tools, clients };
}
