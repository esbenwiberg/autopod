import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it, vi } from 'vitest';
import { createEscalationMcpServer } from './server.js';
import { createMockBridge } from './test-utils/mock-bridge.js';

it('serves real MCP JSON schemas and validates tool arguments with patched Zod (no network)', async () => {
  const reportProgress = vi.fn();
  const { server } = createEscalationMcpServer({
    podId: 'protocol-fixture',
    bridge: createMockBridge({ reportProgress }),
  });
  const client = new Client({ name: 'protocol-fixture', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    expect(tools.tools.find((tool) => tool.name === 'report_progress')?.inputSchema).toMatchObject({
      type: 'object',
      properties: {
        currentPhase: { type: 'integer', minimum: 1 },
        totalPhases: { type: 'integer', minimum: 1 },
      },
      required: expect.arrayContaining(['phase', 'description', 'currentPhase', 'totalPhases']),
    });
    const args = {
      phase: 'Testing',
      description: 'Real protocol fixture',
      currentPhase: 1,
      totalPhases: 1,
    };
    const invalid = await client.callTool({
      name: 'report_progress',
      arguments: { ...args, currentPhase: 0 },
    });
    expect(invalid.isError).toBe(true);
    expect(reportProgress).not.toHaveBeenCalled();
    const valid = await client.callTool({ name: 'report_progress', arguments: args });
    expect(valid.isError).not.toBe(true);
    expect(reportProgress).toHaveBeenCalledExactlyOnceWith(
      'protocol-fixture',
      args.phase,
      args.description,
      1,
      1,
    );
  } finally {
    await client.close();
    await server.close();
  }
});
