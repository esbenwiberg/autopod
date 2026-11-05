import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it, vi } from 'vitest';
import type { PodBridge } from './pod-bridge.js';
import { createEscalationMcpServer } from './server.js';
import { createMockBridge } from './test-utils/mock-bridge.js';

it('delivers isolated reference raster bytes as an MCP native image, never text-encoded base64', async () => {
  const renderReference = vi.fn<NonNullable<PodBridge['renderReference']>>().mockResolvedValue({
    receipt: {
      bundleDigest: 'a'.repeat(64),
      sourceSha256: 'b'.repeat(64),
      resourceSha256s: ['b'.repeat(64)],
      entrypoint: 'design.html',
      rendererImage: `sha256:${'c'.repeat(64)}`,
      rendererProtocol: 1,
      browserVersion: '146.0.0',
      width: 1280,
      height: 900,
      mediaType: 'image/jpeg',
      jpegQuality: 80,
      byteLength: 3,
      sha256: 'd'.repeat(64),
      blockedRequests: 0,
      scriptErrors: 0,
      capturedAt: '2026-05-01T12:00:00.000Z',
    },
    base64: 'anBn',
  });
  const guidance = vi.fn<PodBridge['readOperatorGuidance']>().mockReturnValue(null);
  const { server } = createEscalationMcpServer({
    podId: 'scoped-pod',
    bridge: createMockBridge({ renderReference, readOperatorGuidance: guidance }),
  });
  const client = new Client({ name: 'native-reference', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const invalid = await client.callTool({
      name: 'render_reference',
      arguments: { path: '../outside.html' },
    });
    expect(invalid.isError).toBe(true);
    expect(renderReference).not.toHaveBeenCalled();
    const response = await client.callTool({
      name: 'render_reference',
      arguments: { path: 'design.html' },
    });
    expect(renderReference).toHaveBeenCalledExactlyOnceWith('scoped-pod', 'design.html');
    expect(response.content).toEqual(
      expect.arrayContaining([{ type: 'image', mimeType: 'image/jpeg', data: 'anBn' }]),
    );
    const text = (response.content as Array<{ type: string; text?: string }>)
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('');
    expect(text).not.toContain('anBn');
    expect(text).toContain('not the application');
    renderReference.mockClear();
    guidance.mockReturnValue({
      deliveryId: 'operator-message',
      messages: ['Pause before continuing'],
    });
    const interrupted = await client.callTool({
      name: 'render_reference',
      arguments: { path: 'design.html' },
    });
    expect(renderReference).not.toHaveBeenCalled();
    expect(
      (interrupted.content as Array<{ type: string }>).some((item) => item.type === 'image'),
    ).toBe(false);
    expect(JSON.stringify(interrupted)).toContain('operatorMessages');
  } finally {
    await client.close();
    await server.close();
  }
});

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
