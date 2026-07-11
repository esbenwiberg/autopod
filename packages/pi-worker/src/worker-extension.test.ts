import {
  AUTOPOD_PI_MANAGED_STARTUP,
  type McpClient,
  type PiNativeTool,
  type PiWorkerConfig,
  PiWorkerStartupError,
} from './types.js';
import { initializePiWorkerExtension } from './worker-extension.js';

class FakeMcpClient implements McpClient {
  readonly serverName: string;
  readonly closed: boolean[] = [];

  constructor(
    serverName: string,
    private readonly tools: Array<{ name: string; inputSchema?: Record<string, unknown> }> = [],
    private readonly initError?: Error,
  ) {
    this.serverName = serverName;
  }

  async initialize(): Promise<void> {
    if (this.initError) throw this.initError;
  }

  async listTools() {
    return this.tools;
  }

  async callTool(name: string, args: Record<string, unknown>) {
    return {
      content: [{ type: 'text', text: `${this.serverName}:${name}:${JSON.stringify(args)}` }],
    };
  }

  async close(): Promise<void> {
    this.closed.push(true);
  }
}

function config(serverNames: string[]): PiWorkerConfig {
  return {
    requiredServerName: 'autopod',
    mcpServers: serverNames.map((name) => ({
      type: 'http',
      name,
      url: `http://example.test/${name}`,
    })),
  };
}

describe('Pi worker extension', () => {
  it('exports a managed startup contract that blocks project executable overrides', () => {
    expect(AUTOPOD_PI_MANAGED_STARTUP).toMatchObject({
      packageName: '@autopod/pi-worker',
      entrypoint: '@autopod/pi-worker',
      loadProjectExtensions: false,
      allowExecutableProjectResources: false,
    });
  });

  it('registers discovered MCP tools as native Pi tools', async () => {
    const registered: PiNativeTool[] = [];
    await initializePiWorkerExtension(
      config(['autopod', 'nav']),
      { registerTool: (tool) => registered.push(tool) },
      {
        clients: [
          new FakeMcpClient('autopod', [
            {
              name: 'ask_human',
              inputSchema: { type: 'object', properties: { question: { type: 'string' } } },
            },
          ]),
          new FakeMcpClient('nav', [{ name: 'find_symbol', inputSchema: { type: 'object' } }]),
        ],
      },
    );

    expect(registered.map((tool) => tool.name)).toEqual(['ask_human', 'find_symbol']);
    expect(registered[0]?.inputSchema).toEqual({
      type: 'object',
      properties: { question: { type: 'string' } },
    });
    await expect(registered[1]?.call({ symbol: 'PodBridge' })).resolves.toEqual({
      content: [{ type: 'text', text: 'nav:find_symbol:{"symbol":"PodBridge"}' }],
    });
  });

  it('fails startup when the required Autopod server is not configured', async () => {
    await expect(
      initializePiWorkerExtension(config(['nav']), { registerTool: () => undefined }),
    ).rejects.toMatchObject({
      name: 'PiWorkerStartupError',
      code: 'required_server_missing',
    });
  });

  it('fails startup when mandatory discovery fails instead of reducing the tool surface', async () => {
    const autopod = new FakeMcpClient('autopod', [], new Error('connection refused'));
    await expect(
      initializePiWorkerExtension(
        config(['autopod']),
        { registerTool: () => undefined },
        { clients: [autopod] },
      ),
    ).rejects.toMatchObject({
      name: 'PiWorkerStartupError',
      code: 'server_initialization_failed',
    });
    expect(autopod.closed).toEqual([true]);
  });

  it('fails startup when the required Autopod server exposes no tools', async () => {
    await expect(
      initializePiWorkerExtension(
        config(['autopod']),
        { registerTool: () => undefined },
        { clients: [new FakeMcpClient('autopod', [])] },
      ),
    ).rejects.toBeInstanceOf(PiWorkerStartupError);
  });

  it('rejects duplicate Pi tool names across MCP servers', async () => {
    const clients = [
      new FakeMcpClient('autopod', [{ name: 'shared_tool', inputSchema: { type: 'object' } }]),
      new FakeMcpClient('nav', [{ name: 'shared_tool', inputSchema: { type: 'object' } }]),
    ];
    await expect(
      initializePiWorkerExtension(
        config(['autopod', 'nav']),
        { registerTool: () => undefined },
        { clients },
      ),
    ).rejects.toMatchObject({
      name: 'PiWorkerStartupError',
      code: 'tool_collision',
    });
    expect(clients[0]?.closed).toEqual([true]);
    expect(clients[1]?.closed).toEqual([true]);
  });
});
