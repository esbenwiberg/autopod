import { discoverMcpTools } from './mcp-bridge.js';
import {
  type McpClient,
  type PiToolRegistry,
  type PiWorkerConfig,
  PiWorkerStartupError,
} from './types.js';

export interface InitializePiWorkerExtensionOptions {
  signal?: AbortSignal;
  clients?: McpClient[];
}

export async function initializePiWorkerExtension(
  config: PiWorkerConfig,
  registry: PiToolRegistry,
  options: InitializePiWorkerExtensionOptions = {},
): Promise<void> {
  const requiredConfigured = config.mcpServers.some(
    (server) => server.name === config.requiredServerName,
  );
  if (!requiredConfigured) {
    throw new PiWorkerStartupError(
      `Required MCP server ${config.requiredServerName} is not configured`,
      'required_server_missing',
    );
  }

  let discovered: Awaited<ReturnType<typeof discoverMcpTools>>;
  try {
    discovered = await discoverMcpTools(config, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new PiWorkerStartupError(
      `Failed to initialize mandatory MCP tool surface: ${message}`,
      'server_initialization_failed',
    );
  }

  const requiredDiscovered = discovered.tools.some(
    (tool) => tool.serverName === config.requiredServerName,
  );
  if (!requiredDiscovered) {
    await closeClients(discovered.clients);
    throw new PiWorkerStartupError(
      `Required MCP server ${config.requiredServerName} exposed no tools`,
      'required_server_missing',
    );
  }

  const names = new Map<string, string>();
  for (const tool of discovered.tools) {
    const previous = names.get(tool.piName);
    if (previous) {
      await closeClients(discovered.clients);
      throw new PiWorkerStartupError(
        `MCP tool name collision for ${tool.piName} from ${previous} and ${tool.serverName}`,
        'tool_collision',
      );
    }
    names.set(tool.piName, tool.serverName);
  }

  for (const tool of discovered.tools) {
    await registry.registerTool({
      name: tool.piName,
      description: tool.description,
      inputSchema: tool.inputSchema,
      call: (args, callOptions) => tool.call(args, callOptions?.signal),
    });
  }
}

async function closeClients(clients: McpClient[] | undefined): Promise<void> {
  await Promise.all((clients ?? []).map((client) => client.close().catch(() => undefined)));
}
