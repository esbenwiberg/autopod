import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMockContainerManager, logger } from '../test-utils/mock-helpers.js';
import { fetchSandboxPreview, startSandboxPreviewProxy } from './sandbox-preview-proxy.js';

describe('sandbox preview proxy', () => {
  const openProxies: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(openProxies.splice(0).map((proxy) => proxy.close()));
  });

  it('fetches a sandbox-local preview through container exec', async () => {
    const containerManager = createMockContainerManager();
    vi.mocked(containerManager.execInContainer).mockResolvedValue({
      stdout: JSON.stringify({
        statusCode: 201,
        statusMessage: 'Created',
        headers: { 'content-type': 'application/octet-stream' },
        bodyBase64: Buffer.from([0, 1, 2, 255]).toString('base64'),
      }),
      stderr: '',
      exitCode: 0,
    });

    const result = await fetchSandboxPreview({
      containerId: 'sandbox-1',
      containerManager,
      method: 'POST',
      path: 'http://example.test/assets/app.js?cache=1',
      headers: {
        connection: 'keep-alive',
        cookie: 'sid=abc',
        host: 'preview.example.test',
      },
      body: Buffer.from('hello'),
      containerPort: 3000,
    });

    expect(result.statusCode).toBe(201);
    expect(result.statusMessage).toBe('Created');
    expect(result.headers['content-type']).toBe('application/octet-stream');
    expect([...result.body]).toEqual([0, 1, 2, 255]);

    const [, command, options] = vi.mocked(containerManager.execInContainer).mock.calls[0] ?? [];
    expect(command).toEqual(['node', '-e', expect.any(String)]);
    expect(options?.env).toMatchObject({
      AUTOPOD_PREVIEW_METHOD: 'POST',
      AUTOPOD_PREVIEW_PATH: '/assets/app.js?cache=1',
      AUTOPOD_PREVIEW_BODY_B64: Buffer.from('hello').toString('base64'),
    });
    expect(options?.env?.AUTOPOD_PREVIEW_HEADERS_JSON).toContain('"cookie":"sid=abc"');
    expect(options?.env?.AUTOPOD_PREVIEW_HEADERS_JSON).not.toContain('keep-alive');
  });

  it('serves browser requests from a host port by forwarding them into the sandbox', async () => {
    const containerManager = createMockContainerManager();
    vi.mocked(containerManager.execInContainer).mockResolvedValue({
      stdout: JSON.stringify({
        statusCode: 200,
        statusMessage: 'OK',
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        bodyBase64: Buffer.from('hello from sandbox').toString('base64'),
      }),
      stderr: '',
      exitCode: 0,
    });

    const proxy = await startSandboxPreviewProxy({
      podId: 'pod-1',
      containerId: 'sandbox-1',
      hostPort: 0,
      containerManager,
      logger,
    });
    openProxies.push(proxy);

    const response = await fetch(`${proxy.url}/deep/path?x=1`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await response.text()).toBe('hello from sandbox');

    const [, , options] = vi.mocked(containerManager.execInContainer).mock.calls[0] ?? [];
    expect(options?.env).toMatchObject({
      AUTOPOD_PREVIEW_PATH: '/deep/path?x=1',
      AUTOPOD_PREVIEW_PORT: '3000',
    });
  });
});
