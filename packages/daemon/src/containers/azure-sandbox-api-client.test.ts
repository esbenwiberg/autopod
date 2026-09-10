import { createHash } from 'node:crypto';
import { AutopodError } from '@autopod/shared';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { AzureSandboxApiClient, type WebSocketLike } from './azure-sandbox-api-client.js';
import { type SandboxExecChunk, SandboxInfrastructureError } from './sandbox-api-client.js';

const logger = pino({ level: 'silent' });

interface CapturedRequest {
  url: string;
  init?: RequestInit;
}

interface MockHttpResponse {
  status: number;
  body?: unknown;
  rawText?: string;
  headers?: Record<string, string>;
}

const credential = {
  async getToken() {
    return { token: 'test-token' };
  },
};

function makeClient(
  responses: MockHttpResponse[],
  config: Partial<ConstructorParameters<typeof AzureSandboxApiClient>[0]> = {},
): {
  client: AzureSandboxApiClient;
  requests: CapturedRequest[];
} {
  const queue = [...responses];
  const requests: CapturedRequest[] = [];
  const fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    requests.push({ url: String(input), init });
    const next = queue.shift();
    if (!next) {
      throw new Error(`unexpected request: ${String(input)}`);
    }
    const body =
      next.status === 204
        ? null
        : (next.rawText ?? (next.body === undefined ? '' : JSON.stringify(next.body)));
    return new Response(body, {
      status: next.status,
      headers: next.headers,
    });
  };

  return {
    client: new AzureSandboxApiClient(
      {
        subscriptionId: 'sub-1',
        resourceGroup: 'rg-1',
        location: 'swedencentral',
        sandboxGroup: 'autopod-spike',
        credential,
        fetch,
        pollIntervalMs: 0,
        ...config,
      },
      logger,
    ),
    requests,
  };
}

class MockWebSocket implements WebSocketLike {
  sent: string[] = [];
  closed = false;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.({});
  }

  /** Deliver a server frame as a JSON text message. */
  emit(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

// execStream stages the command as an executable wrapper script (writeFile PUT +
// chmod exec POST) before opening the WebSocket, so callers that reach the socket
// must supply those two HTTP responses.
const STREAM_SETUP_RESPONSES: MockHttpResponse[] = [
  { status: 204 }, // writeFile: PUT /files
  { status: 200, body: { stdout: '', stderr: '', exitCode: 0 } }, // chmod +x
];

function makeStreamingClient(
  script: (socket: MockWebSocket) => void,
  responses: MockHttpResponse[] = STREAM_SETUP_RESPONSES,
): {
  client: AzureSandboxApiClient;
  sockets: MockWebSocket[];
  wsUrls: string[];
  wsHeaders: Record<string, string>[];
  requests: CapturedRequest[];
} {
  const sockets: MockWebSocket[] = [];
  const wsUrls: string[] = [];
  const wsHeaders: Record<string, string>[] = [];
  const { client, requests } = makeClient(responses, {
    webSocket: (url, headers) => {
      wsUrls.push(url);
      wsHeaders.push(headers);
      const socket = new MockWebSocket();
      sockets.push(socket);
      // Run the server script after execStream has attached its handlers.
      queueMicrotask(() => script(socket));
      return socket;
    },
  });
  return { client, sockets, wsUrls, wsHeaders, requests };
}

function jsonBody(request: CapturedRequest): unknown {
  return JSON.parse(String(request.init?.body));
}

function formBody(request: CapturedRequest): URLSearchParams {
  if (!(request.init?.body instanceof URLSearchParams)) {
    throw new Error('request body is not URLSearchParams');
  }
  return request.init.body;
}

describe('AzureSandboxApiClient', () => {
  it('creates the group when missing, then creates a disk image and sandbox', async () => {
    const { client, requests } = makeClient([
      { status: 404, body: {} },
      { status: 201, body: {} },
      { status: 200, body: { id: 'group-1' } },
      { status: 200, body: { value: [] } },
      { status: 200, body: { id: 'disk-1', status: { state: 'Creating' } } },
      { status: 200, body: { id: 'disk-1', status: { state: 'Ready' } } },
      { status: 200, body: { id: 'sbx-1', state: 'Creating' } },
      { status: 200, body: { id: 'sbx-1', state: 'Running' } },
    ]);

    const id = await client.createSandbox({
      image: 'mcr.microsoft.com/cbl-mariner/base/core:2.0',
      tier: 'L',
      podId: 'pod-1',
      env: { POD_ID: 'pod-1' },
      egressPolicy: {
        defaultAction: 'Deny',
        hostRules: [{ pattern: 'api.github.com', action: 'Allow' }],
      },
    });

    expect(id).toBe('sbx-1');
    expect(requests).toHaveLength(8);
    expect(requests[0]?.url).toContain(
      'https://management.azure.com/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.App/sandboxGroups/autopod-spike',
    );
    expect(requests[3]?.url).toContain(
      'https://management.swedencentral.azuredevcompute.io/subscriptions/sub-1/resourceGroups/rg-1/sandboxGroups/autopod-spike/diskimages',
    );
    expect(requests[4]?.url).toContain(
      'https://management.swedencentral.azuredevcompute.io/subscriptions/sub-1/resourceGroups/rg-1/sandboxGroups/autopod-spike/diskimages',
    );
    expect(jsonBody(requests[4] ?? failRequest())).toMatchObject({
      image: { base: 'mcr.microsoft.com/cbl-mariner/base/core:2.0' },
    });
    expect(jsonBody(requests[6] ?? failRequest())).toMatchObject({
      sourcesRef: { diskImage: { id: 'disk-1' } },
      resources: { cpu: '2000m', memory: '4096Mi', disk: '40Gi' },
      environment: { POD_ID: 'pod-1' },
      labels: { purpose: 'autopod-sandbox', managedBy: 'autopod', podId: 'pod-1' },
      egressPolicy: {
        defaultAction: 'Deny',
        hostRules: [{ pattern: 'api.github.com', action: 'Allow' }],
      },
    });
  });

  it('allows disk image creation requests up to 15 minutes', async () => {
    vi.useFakeTimers();
    try {
      let requestCount = 0;
      const fetch = async (_input: string | URL, init?: RequestInit): Promise<Response> => {
        requestCount++;
        if (requestCount === 1) {
          return new Response(JSON.stringify({ value: [] }), { status: 200 });
        }
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          );
        });
      };
      const client = new AzureSandboxApiClient(
        {
          subscriptionId: 'sub-1',
          resourceGroup: 'rg-1',
          location: 'swedencentral',
          sandboxGroup: 'autopod-spike',
          credential,
          fetch,
          assumeGroupExists: true,
        },
        logger,
      );

      let settled = false;
      const creation = client.createSandbox({
        image: 'mcr.microsoft.com/cbl-mariner/base/core:2.0',
        tier: 'L',
        env: {},
        egressPolicy: { defaultAction: 'Allow', hostRules: [] },
      });
      creation.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      const rejection = expect(creation).rejects.toThrow('timed out after 900000ms');

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(requestCount).toBe(2);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it('attaches and uses a managed identity for private image pulls', async () => {
    const identityId =
      '/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.ManagedIdentity/userAssignedIdentities/sandbox-acr-pull';
    const { client, requests } = makeClient(
      [
        { status: 404, body: {} },
        { status: 201, body: {} },
        { status: 200, body: { id: 'group-1' } },
        { status: 200, body: { value: [] } },
        { status: 200, body: { refresh_token: 'acr-refresh-token' } },
        { status: 200, body: { id: 'disk-1', status: { state: 'Ready' } } },
        { status: 200, body: { id: 'disk-1', status: { state: 'Ready' } } },
        { status: 200, body: { id: 'sbx-1', state: 'Running' } },
        { status: 200, body: { id: 'sbx-1', state: 'Running' } },
      ],
      { imagePullIdentityResourceId: identityId },
    );

    await client.createSandbox({
      image: 'ewiacr.azurecr.io/autopod/test-app:latest',
      tier: 'L',
      env: {},
      egressPolicy: { defaultAction: 'Allow', hostRules: [] },
    });

    expect(jsonBody(requests[1] ?? failRequest())).toMatchObject({
      identity: {
        type: 'UserAssigned',
        userAssignedIdentities: { [identityId]: {} },
      },
    });
    expect(requests[4]?.url).toBe('https://ewiacr.azurecr.io/oauth2/exchange');
    const exchange = formBody(requests[4] ?? failRequest());
    expect(exchange.get('grant_type')).toBe('access_token');
    expect(exchange.get('service')).toBe('ewiacr.azurecr.io');
    expect(exchange.get('access_token')).toBe('test-token');
    expect(jsonBody(requests[5] ?? failRequest())).toMatchObject({
      image: { base: 'ewiacr.azurecr.io/autopod/test-app:latest' },
      managedIdentityResourceId: identityId,
      registryCredentials: {
        username: '00000000-0000-0000-0000-000000000000',
        token: 'acr-refresh-token',
      },
    });
  });

  it('passes transient registry credentials for disk-image creation', async () => {
    const { client, requests } = makeClient(
      [
        { status: 200, body: { value: [] } },
        { status: 200, body: { id: 'disk-1', status: { state: 'Ready' } } },
        { status: 200, body: { id: 'disk-1', status: { state: 'Ready' } } },
        { status: 200, body: { id: 'sbx-1', state: 'Running' } },
        { status: 200, body: { id: 'sbx-1', state: 'Running' } },
      ],
      {
        assumeGroupExists: true,
        registryCredentials: { username: 'token-user', token: 'secret-token' },
      },
    );

    await client.createSandbox({
      image: 'ewiacr.azurecr.io/autopod/test-app:latest',
      tier: 'L',
      env: {},
      egressPolicy: { defaultAction: 'Allow', hostRules: [] },
    });

    expect(requests[0]?.url).toContain('/diskimages');
    expect(jsonBody(requests[1] ?? failRequest())).toMatchObject({
      image: { base: 'ewiacr.azurecr.io/autopod/test-app:latest' },
      registryCredentials: { username: 'token-user', token: 'secret-token' },
    });
  });

  it('reuses a ready persistent disk image after sandbox deletion', async () => {
    const image = 'ewiacr.azurecr.io/autopod/test-app:latest';
    const sourceDigest = `sha256:${'1'.repeat(64)}`;
    const diskImage = {
      id: 'disk-digest1',
      image: { base: `ewiacr.azurecr.io/autopod/test-app@${sourceDigest}` },
      status: { state: 'Ready' },
      labels: diskImageLabelsFor(image, sourceDigest),
    };
    const { client, requests } = makeClient(
      [
        { status: 200, body: { value: [] } },
        { status: 200, body: diskImage },
        { status: 200, body: diskImage },
        { status: 200, body: { id: 'sbx-1', state: 'Running' } },
        { status: 200, body: { id: 'sbx-1', state: 'Running' } },
        { status: 202, body: {} },
        { status: 404, body: {} },
        { status: 200, body: { value: [diskImage] } },
        { status: 200, body: { id: 'sbx-2', state: 'Running' } },
        { status: 200, body: { id: 'sbx-2', state: 'Running' } },
      ],
      {
        assumeGroupExists: true,
        registryCredentials: { username: 'token-user', token: 'secret-token' },
        resolveImageDigest: async () => sourceDigest,
      },
    );

    await client.createSandbox({
      image,
      tier: 'L',
      env: {},
      egressPolicy: { defaultAction: 'Allow', hostRules: [] },
    });
    await client.destroy('sbx-1');
    await client.createSandbox({
      image,
      tier: 'L',
      env: {},
      egressPolicy: { defaultAction: 'Allow', hostRules: [] },
    });

    const diskImageCreates = requests.filter(
      (request) => request.init?.method === 'PUT' && request.url.includes('/diskimages'),
    );
    const diskImageDeletes = requests.filter(
      (request) => request.init?.method === 'DELETE' && request.url.includes('/diskimages/'),
    );
    const sandboxCreates = requests.filter(
      (request) => request.init?.method === 'PUT' && request.url.includes('/sandboxes'),
    );

    expect(diskImageCreates).toHaveLength(1);
    expect(diskImageDeletes).toHaveLength(0);
    expect(sandboxCreates).toHaveLength(2);
    expect(jsonBody(sandboxCreates[1] ?? failRequest())).toMatchObject({
      sourcesRef: { diskImage: { id: 'disk-digest1' } },
    });
  });

  it('garbage-collects stale disk images after the source digest changes', async () => {
    const image = 'ewiacr.azurecr.io/autopod/test-app:latest';
    const oldDiskImage = {
      id: 'disk-old',
      status: { state: 'Ready' },
      labels: diskImageLabelsFor(image, `sha256:${'2'.repeat(64)}`),
    };
    const newDiskImage = {
      id: 'disk-new',
      status: { state: 'Ready' },
      labels: diskImageLabelsFor(image, `sha256:${'3'.repeat(64)}`),
    };
    const { client, requests } = makeClient(
      [
        { status: 200, body: { value: [oldDiskImage] } },
        { status: 200, body: newDiskImage },
        { status: 200, body: newDiskImage },
        { status: 202, body: {} },
        { status: 404, body: {} },
        { status: 200, body: { id: 'sbx-1', state: 'Running' } },
        { status: 200, body: { id: 'sbx-1', state: 'Running' } },
      ],
      {
        assumeGroupExists: true,
        registryCredentials: { username: 'token-user', token: 'secret-token' },
        resolveImageDigest: async () => `sha256:${'3'.repeat(64)}`,
      },
    );

    await client.createSandbox({
      image,
      tier: 'L',
      env: {},
      egressPolicy: { defaultAction: 'Allow', hostRules: [] },
    });

    const staleDeletes = requests.filter(
      (request) =>
        request.init?.method === 'DELETE' && request.url.includes('/diskimages/disk-old'),
    );
    expect(staleDeletes).toHaveLength(1);
    expect(jsonBody(requests[1] ?? failRequest())).toMatchObject({
      labels: diskImageLabelsFor(image, `sha256:${'3'.repeat(64)}`),
    });
  });

  it('executes buffered shell commands and maps the response', async () => {
    const { client, requests } = makeClient([
      { status: 200, body: { stdout: 'out', stderr: 'err', exitCode: 7 } },
    ]);

    const result = await client.exec('sbx-1', ['sh', '-lc', 'echo "$FOO"'], {
      cwd: '/workspace',
      env: { FOO: "a'b" },
      timeoutMs: 5000,
      user: 'root',
    });

    expect(result).toEqual({ stdout: 'out', stderr: 'err', exitCode: 7 });
    expect(requests[0]?.url).toContain('/sandboxes/sbx-1/executeShellCommand');
    expect(jsonBody(requests[0] ?? failRequest())).toEqual({
      command: "env FOO='a'\\''b' sh -lc 'echo \"$FOO\"'",
      workingDirectory: '/workspace',
      user: 'root',
    });
  });

  it('rejects buffered exec responses that omit the exit code', async () => {
    const { client } = makeClient([
      { status: 200, body: { stdout: 'partial output', stderr: '' } },
    ]);

    await expect(client.exec('sbx-1', ['npm', 'test'])).rejects.toMatchObject({
      code: 'AZURE_SANDBOX_EXEC_INVALID_RESPONSE',
      statusCode: 502,
    });
  });

  it('stages a wrapper script then streams stdout/stderr and exit code over the exec WebSocket', async () => {
    const { client, sockets, wsUrls, wsHeaders, requests } = makeStreamingClient((socket) => {
      socket.onopen?.({});
      socket.emit({ type: 'stdout', data: Buffer.from('hello').toString('base64') });
      socket.emit({ type: 'stderr', data: Buffer.from('warn').toString('base64') });
      socket.emit({ type: 'exit_code', exitCode: 3 });
    });

    const chunks: SandboxExecChunk[] = [];
    for await (const chunk of client.execStream('sbx-1', ['echo', 'hello'], {
      cwd: '/workspace',
      env: { FOO: 'bar baz' },
    })) {
      chunks.push(chunk);
    }

    // The command is `execve`d as a single argv[0], so it is staged as an
    // executable wrapper script and the start frame execs that path.
    const writeReq = requests[0] ?? failRequest();
    expect(writeReq.url).toContain('/sandboxes/sbx-1/files');
    const scriptPath = new URL(writeReq.url).searchParams.get('path') ?? '';
    expect(scriptPath).toMatch(/^\/tmp\/\.autopod-execstream-\d+-\d+\.sh$/);
    expect(String(writeReq.init?.body)).toBe(
      [
        '#!/bin/sh',
        'if [ "${AUTOPOD_STREAM_SESSION:-}" != "1" ]; then',
        '  exec env AUTOPOD_STREAM_SESSION=1 setsid -w "$0"',
        'fi',
        'umask 077',
        'echo $$ > "$0.pid"',
        'if [ "$(id -u)" = "0" ]; then',
        "  exec env HOME=/home/autopod USER=autopod LOGNAME=autopod su -m -s /bin/sh autopod -c 'cd /workspace || exit 1\nexec echo hello'",
        'fi',
        'cd /workspace || exit 1',
        'exec echo hello',
        '',
      ].join('\n'),
    );
    // The files API writes the wrapper as root:0644, so it is chmod-ed executable as root.
    expect(jsonBody(requests[1] ?? failRequest())).toEqual({
      command: `chmod 0755 ${scriptPath}`,
      user: 'root',
    });

    expect(wsUrls).toEqual([
      'wss://management.swedencentral.azuredevcompute.io/subscriptions/sub-1/resourceGroups/rg-1/sandboxGroups/autopod-spike/sandboxes/sbx-1/exec/stream',
    ]);
    expect(wsHeaders[0]).toEqual({ Authorization: 'Bearer test-token' });
    expect(JSON.parse(sockets[0]?.sent[0] ?? '{}')).toEqual({
      type: 'start',
      start: {
        command: scriptPath,
        environment: { TERM: 'xterm-256color', LANG: 'C.UTF-8', FOO: 'bar baz' },
        tty: false,
        stdin: false,
        height: 24,
        width: 80,
      },
    });
    expect(chunks).toEqual([{ stdout: 'hello' }, { stderr: 'warn' }, { exitCode: 3 }]);
    expect(sockets[0]?.closed).toBe(true);
  });

  it('sends exec stdin frames over the native WebSocket when requested', async () => {
    const { client, sockets } = makeStreamingClient((socket) => {
      socket.onopen?.({});
      socket.emit({ type: 'exit_code', exitCode: 0 });
    });

    const chunks: SandboxExecChunk[] = [];
    for await (const chunk of client.execStream('sbx-1', ['cat'], {
      stdin: true,
      onStdinWriter: (write) => {
        write(Buffer.from('hello\n'));
      },
    })) {
      chunks.push(chunk);
    }

    expect(JSON.parse(sockets[0]?.sent[0] ?? '{}')).toEqual({
      type: 'start',
      start: {
        command: expect.stringMatching(/^\/tmp\/\.autopod-execstream-\d+-\d+\.sh$/),
        environment: { TERM: 'xterm-256color', LANG: 'C.UTF-8' },
        tty: false,
        stdin: true,
        height: 24,
        width: 80,
      },
    });

    expect(JSON.parse(sockets[0]?.sent[1] ?? '{}')).toEqual({
      type: 'stdin',
      data: Buffer.from('hello\n').toString('base64'),
    });
    expect(chunks).toEqual([{ exitCode: 0 }]);
  });

  it('cancels a streaming exec by killing its recorded process and closing the socket', async () => {
    let cancel: (() => Promise<void>) | undefined;
    const { client, sockets, requests } = makeStreamingClient(
      (socket) => {
        socket.onopen?.({});
      },
      [...STREAM_SETUP_RESPONSES, { status: 200, body: { stdout: '', stderr: '', exitCode: 0 } }],
    );
    const iterator = client
      .execStream('sbx-1', ['pi', 'rpc'], {
        stdin: true,
        onCancelReady: (callback) => {
          cancel = callback;
        },
      })
      [Symbol.asyncIterator]();
    const pending = iterator.next();
    await new Promise((resolve) => setImmediate(resolve));

    await cancel?.();

    await expect(pending).rejects.toThrow(/closed before reporting an exit code/);
    expect(sockets[0]?.closed).toBe(true);
    const killRequest = requests[2] ?? failRequest();
    const killBody = JSON.stringify(jsonBody(killRequest));
    expect(killBody).toMatch(/\.autopod-execstream-\d+-\d+\.sh\.pid/);
    expect(killBody).toContain('kill -TERM -');
    expect(killBody).toContain('kill -KILL -');
    expect(killBody).toContain('group_alive');
    expect(String((requests[0] ?? failRequest()).init?.body)).toContain('setsid -w "$0"');
  });

  it('rejects cancellation when a child survives process-group termination', async () => {
    let cancel: (() => Promise<void>) | undefined;
    const { client } = makeStreamingClient(
      (socket) => {
        socket.onopen?.({});
      },
      [...STREAM_SETUP_RESPONSES, { status: 200, body: { stdout: '', stderr: '', exitCode: 1 } }],
    );
    const iterator = client
      .execStream('sbx-1', ['pi', 'rpc'], {
        onCancelReady: (callback) => {
          cancel = callback;
        },
      })
      [Symbol.asyncIterator]();
    const pending = iterator.next();
    await new Promise((resolve) => setImmediate(resolve));

    await expect(cancel?.()).rejects.toThrow(/termination was not verified/);
    await expect(pending).rejects.toThrow(/closed before reporting an exit code/);
  });

  it('terminates the recorded process when a streaming exec times out', async () => {
    const { client, sockets, requests } = makeStreamingClient(
      (socket) => {
        socket.onopen?.({});
      },
      [...STREAM_SETUP_RESPONSES, { status: 200, body: { stdout: '', stderr: '', exitCode: 0 } }],
    );

    await expect(
      (async () => {
        for await (const _chunk of client.execStream('sbx-1', ['pi', 'rpc'], {
          timeoutMs: 1,
        })) {
          // No output is expected before timeout.
        }
      })(),
    ).rejects.toThrow(/timed out/);

    expect(sockets[0]?.closed).toBe(true);
    const killBody = JSON.stringify(jsonBody(requests[2] ?? failRequest()));
    expect(killBody).toContain('kill -TERM');
    expect(killBody).toContain('kill -KILL');
  });

  it('fails the exec stream when the socket closes before an exit code', async () => {
    const { client } = makeStreamingClient((socket) => {
      socket.onopen?.({});
      socket.emit({ type: 'stdout', data: Buffer.from('partial').toString('base64') });
      socket.close();
    });

    const chunks: SandboxExecChunk[] = [];
    await expect(
      (async () => {
        for await (const chunk of client.execStream('sbx-1', ['sleep', '60'])) {
          chunks.push(chunk);
        }
      })(),
    ).rejects.toThrow(/closed before reporting an exit code/);
    expect(chunks).toEqual([{ stdout: 'partial' }]);
  });

  it('fails the exec stream on an error frame', async () => {
    const { client } = makeStreamingClient((socket) => {
      socket.onopen?.({});
      socket.emit({ type: 'error', message: 'boom' });
    });

    const drained: SandboxExecChunk[] = [];
    await expect(
      (async () => {
        for await (const chunk of client.execStream('sbx-1', ['true'])) {
          drained.push(chunk);
        }
      })(),
    ).rejects.toThrow(/reported an error/);
    expect(drained).toEqual([]);
  });

  it('rejects streaming exec with a user option', async () => {
    const { client } = makeStreamingClient(() => {
      throw new Error('socket should not be created');
    });

    const drained: SandboxExecChunk[] = [];
    await expect(
      (async () => {
        for await (const chunk of client.execStream('sbx-1', ['true'], { user: 'root' })) {
          drained.push(chunk);
        }
      })(),
    ).rejects.toThrow(/cannot run as a specific user/);
    expect(drained).toEqual([]);
  });

  it('opens an interactive TTY terminal session, proxying stdin/resize/output', async () => {
    const { client, sockets, requests } = makeStreamingClient((socket) => {
      socket.onopen?.({});
    });

    const session = await client.attachTerminal('sbx-1', {
      cols: 100,
      rows: 30,
      shellCommand: 'exec /bin/bash -l',
      env: { FOO: 'bar' },
    });

    // The shell one-liner is staged as an executable wrapper (writeFile + root chmod).
    const writeReq = requests[0] ?? failRequest();
    const scriptPath = new URL(writeReq.url).searchParams.get('path') ?? '';
    expect(scriptPath).toMatch(/^\/tmp\/\.autopod-execstream-\d+-\d+\.sh$/);
    expect(String(writeReq.init?.body)).toBe(
      [
        '#!/bin/sh',
        'if [ "$(id -u)" = "0" ]; then',
        "  exec env HOME=/home/autopod USER=autopod LOGNAME=autopod su -m -s /bin/sh autopod -c 'exec /bin/bash -l'",
        'fi',
        'exec /bin/bash -l',
        '',
      ].join('\n'),
    );
    expect(jsonBody(requests[1] ?? failRequest())).toEqual({
      command: `chmod 0755 ${scriptPath}`,
      user: 'root',
    });

    // The start frame runs the wrapper with a TTY and stdin enabled.
    expect(JSON.parse(sockets[0]?.sent[0] ?? '{}')).toEqual({
      type: 'start',
      start: {
        command: scriptPath,
        environment: { TERM: 'xterm-256color', LANG: 'C.UTF-8', FOO: 'bar' },
        tty: true,
        stdin: true,
        height: 30,
        width: 100,
      },
    });

    const output: string[] = [];
    session.onData((chunk) => output.push(chunk.toString('utf-8')));
    let exitCode: number | undefined;
    session.onExit((code) => {
      exitCode = code;
    });

    session.write(Buffer.from('ls\n'));
    expect(JSON.parse(sockets[0]?.sent[1] ?? '{}')).toEqual({
      type: 'stdin',
      data: Buffer.from('ls\n').toString('base64'),
    });

    session.resize(120, 40);
    expect(JSON.parse(sockets[0]?.sent[2] ?? '{}')).toEqual({
      type: 'resize',
      width: 120,
      height: 40,
    });

    sockets[0]?.emit({ type: 'stdout', data: Buffer.from('hi').toString('base64') });
    sockets[0]?.emit({ type: 'stderr', data: Buffer.from('!').toString('base64') });
    expect(output).toEqual(['hi', '!']);

    sockets[0]?.emit({ type: 'exit_code', exitCode: 0 });
    expect(exitCode).toBe(0);
    expect(sockets[0]?.closed).toBe(true);
  });

  it('writes, reads, lists, stats files, and updates egress policy through the data plane', async () => {
    const { client, requests } = makeClient([
      { status: 204 },
      { status: 200, rawText: 'hello' },
      {
        status: 200,
        body: {
          path: '/tmp',
          entries: [
            {
              name: 'hello.txt',
              path: '/tmp/hello.txt',
              isDir: false,
              size: 5,
              mode: 420,
              modifiedTime: 1782467614,
            },
            {
              name: 'nested',
              path: '/tmp/nested',
              isDir: true,
              size: 4096,
              mode: 493,
              modifiedTime: 1782467614,
            },
          ],
        },
      },
      {
        status: 200,
        body: { name: 'hello.txt', path: '/tmp/hello.txt', isDir: false, size: 5 },
      },
      { status: 204 },
    ]);

    await client.writeFile('sbx-1', '/tmp/hello.txt', Buffer.from('hello'));
    const read = await client.readFile('sbx-1', '/tmp/hello.txt');
    const list = await client.listFiles('sbx-1', '/tmp');
    const stat = await client.statFile('sbx-1', '/tmp/hello.txt');
    await client.updateEgress('sbx-1', {
      defaultAction: 'Deny',
      hostRules: [{ pattern: 'api.github.com', action: 'Allow' }],
    });

    expect(requests[0]?.url).toContain('/sandboxes/sbx-1/files');
    expect(requests[0]?.url).toContain('path=%2Ftmp%2Fhello.txt');
    expect(requests[0]?.url).toContain('createDirs=true');
    expect(read.toString('utf-8')).toBe('hello');
    expect(list.entries[0]?.path).toBe('/tmp/hello.txt');
    expect(list.entries[0]?.isDirectory).toBe(false);
    expect(list.entries[0]?.mode).toBe('420');
    expect(list.entries[0]?.modifiedAt).toBe('2026-06-26T09:53:34.000Z');
    expect(list.entries[1]?.isDirectory).toBe(true);
    expect(stat.path).toBe('/tmp/hello.txt');
    expect(stat.isDirectory).toBe(false);
    expect(requests[2]?.url).toContain('/sandboxes/sbx-1/files/list');
    expect(requests[2]?.url).toContain('path=%2Ftmp');
    expect(requests[3]?.url).toContain('/sandboxes/sbx-1/files/stat');
    expect(requests[3]?.url).toContain('path=%2Ftmp%2Fhello.txt');
    expect(requests[4]?.url).toContain('/sandboxes/sbx-1/egresspolicy');
    expect(jsonBody(requests[4] ?? failRequest())).toEqual({
      defaultAction: 'Deny',
      hostRules: [{ pattern: 'api.github.com', action: 'Allow' }],
    });
  });

  it('retries empty data-plane 403s through the retry budget for file writes', async () => {
    const { client, requests } = makeClient(
      [
        { status: 403, rawText: '', headers: { 'x-ms-request-id': 'request-first' } },
        { status: 403, rawText: '', headers: { 'x-ms-request-id': 'request-second' } },
        { status: 204 },
      ],
      { retry: { maxAttempts: 3, maxDelayMs: 0 } },
    );

    await client.writeFile('sbx-1', '/home/autopod/.claude.json', Buffer.from('{}'));

    expect(requests).toHaveLength(3);
    expect(requests.every((request) => request.url.includes('/sandboxes/sbx-1/files'))).toBe(true);
  });

  it('does not retry a non-empty data-plane 403', async () => {
    const { client, requests } = makeClient([{ status: 403, body: { error: 'RBAC denied' } }], {
      retry: { maxDelayMs: 0 },
    });

    const error = await client.exec('sbx-1', ['true']).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(AutopodError);
    expect(error).toMatchObject({ code: 'AZURE_SANDBOX_HTTP_ERROR', statusCode: 403 });
    expect(error).not.toBeInstanceOf(SandboxInfrastructureError);
    expect(requests).toHaveLength(1);
  });

  it('classifies exhausted empty data-plane 403 as retryable sandbox infrastructure', async () => {
    const { client, requests } = makeClient(
      [
        { status: 403, rawText: '' },
        { status: 403, rawText: '' },
        {
          status: 403,
          rawText: '',
          headers: {
            'x-ms-request-id': 'request-final',
            'x-ms-correlation-request-id': 'correlation-final',
            authorization: 'secret-that-must-not-appear',
          },
        },
      ],
      { retry: { maxAttempts: 3, maxDelayMs: 0 } },
    );

    const error = await client.exec('sbx-1', ['true']).catch((cause: unknown) => cause);

    expect(requests).toHaveLength(3);
    expect(error).toBeInstanceOf(SandboxInfrastructureError);
    expect(error).toMatchObject({
      code: 'AZURE_SANDBOX_TRANSIENT_FORBIDDEN',
      retryable: true,
      statusCode: 403,
      diagnostics: {
        'x-ms-request-id': 'request-final',
        'x-ms-correlation-request-id': 'correlation-final',
      },
    });
    expect(JSON.stringify(error)).not.toContain('secret-that-must-not-appear');
  });

  it('honors a data-plane 429 (retryAfterSeconds) and retries the request', async () => {
    const { client, requests } = makeClient(
      [
        {
          status: 429,
          body: {
            title: 'Rate limit exceeded',
            status: 429,
            detail: 'API request rate limit exceeded (limit 600 requests/min).',
            retryAfterSeconds: 30,
          },
        },
        { status: 200, rawText: 'hello-after-retry' },
      ],
      { retry: { maxDelayMs: 0 } },
    );

    const read = await client.readFile('sbx-1', '/tmp/hello.txt');

    expect(read.toString('utf-8')).toBe('hello-after-retry');
    // First attempt 429, retried once → 2 requests to the same files endpoint.
    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toContain('/sandboxes/sbx-1/files');
    expect(requests[1]?.url).toContain('/sandboxes/sbx-1/files');
  });

  it('retries a transient data-plane GET 503', async () => {
    const { client, requests } = makeClient(
      [
        { status: 503, rawText: 'upstream connect error' },
        { status: 200, rawText: 'file-after-retry' },
      ],
      { retry: { maxDelayMs: 0 } },
    );

    const read = await client.readFile('sbx-1', '/workspace/file.ts');

    expect(read.toString('utf-8')).toBe('file-after-retry');
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.init?.method === 'GET')).toBe(true);
  });

  it('stops retrying transient data-plane GET 503 after the configured budget', async () => {
    const unavailable = () => ({ status: 503, rawText: 'connection termination' });
    const { client, requests } = makeClient([unavailable(), unavailable(), unavailable()], {
      retry: { maxAttempts: 3, maxDelayMs: 0 },
    });

    await expect(client.readFile('sbx-1', '/workspace/file.ts')).rejects.toThrow(/503/);

    expect(requests).toHaveLength(3);
  });

  it('does not retry a data-plane write after 503', async () => {
    const { client, requests } = makeClient([{ status: 503, rawText: 'connection termination' }], {
      retry: { maxDelayMs: 0 },
    });

    await expect(
      client.writeFile('sbx-1', '/workspace/file.ts', Buffer.from('content')),
    ).rejects.toThrow(/503/);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.init?.method).toBe('PUT');
  });

  it('honors the Retry-After header when the body has no retryAfterSeconds', async () => {
    const { client, requests } = makeClient(
      [
        { status: 429, rawText: 'slow down', headers: { 'retry-after': '1' } },
        { status: 200, body: { path: '/tmp', entries: [] } },
      ],
      { retry: { maxDelayMs: 0 } },
    );

    const list = await client.listFiles('sbx-1', '/tmp');
    expect(list.entries).toEqual([]);
    expect(requests).toHaveLength(2);
  });

  it('gives up after the retry budget is exhausted on persistent 429s', async () => {
    const rateLimited = () => ({
      status: 429,
      body: { status: 429, retryAfterSeconds: 30 },
    });
    const { client, requests } = makeClient([rateLimited(), rateLimited(), rateLimited()], {
      retry: { maxAttempts: 3, maxDelayMs: 0 },
    });

    await expect(client.readFile('sbx-1', '/tmp/hello.txt')).rejects.toThrow(/429/);
    // maxAttempts=3 → 3 tries then throw (no infinite loop).
    expect(requests).toHaveLength(3);
  });

  it('exposes an Entra-gated port and maps the returned public URL', async () => {
    const { client, requests } = makeClient([
      {
        status: 200,
        body: {
          port: 3000,
          protocol: 'Http',
          url: 'https://sbx-1-3000.swedencentral.azurecontainerapps.io',
        },
      },
    ]);

    const exposed = await client.addPort('sbx-1', 3000, {
      mode: 'entra',
      emails: ['ewi@projectum.com'],
    });

    expect(exposed).toEqual({
      port: 3000,
      hostPort: undefined,
      protocol: 'Http',
      url: 'https://sbx-1-3000.swedencentral.azurecontainerapps.io',
    });
    expect(requests[0]?.url).toContain('/sandboxes/sbx-1/ports/add');
    expect(jsonBody(requests[0] ?? failRequest())).toEqual({
      port: 3000,
      auth: { entraId: { enabled: true, emails: ['ewi@projectum.com'] } },
    });
  });

  it('exposes an anonymous port when explicitly opted in', async () => {
    const { client, requests } = makeClient([
      { status: 201, body: { port: 8080, url: 'https://x' } },
    ]);

    await client.addPort('sbx-1', 8080, { mode: 'anonymous' });

    expect(jsonBody(requests[0] ?? failRequest())).toEqual({
      port: 8080,
      auth: { anonymous: true },
    });
  });

  it('omits auth when none is given (platform default) and removes ports idempotently', async () => {
    const { client, requests } = makeClient([
      { status: 200, body: { port: 3000, url: 'https://y' } },
      { status: 404 },
    ]);

    await client.addPort('sbx-1', 3000);
    expect(jsonBody(requests[0] ?? failRequest())).toEqual({ port: 3000 });

    await expect(client.removePort('sbx-1', 3000)).resolves.toBeUndefined();
    expect(requests[1]?.url).toContain('/sandboxes/sbx-1/ports/remove');
    expect(jsonBody(requests[1] ?? failRequest())).toEqual({ port: 3000 });
  });

  it('creates a snapshot and returns its id', async () => {
    const { client, requests } = makeClient([{ status: 200, body: { id: 'snap-1' } }]);

    const snapshot = await client.createSnapshot('sbx-1', 'warm-node22');

    expect(snapshot).toEqual({ id: 'snap-1' });
    expect(requests[0]?.url).toContain('/sandboxes/sbx-1/snapshot');
    expect(jsonBody(requests[0] ?? failRequest())).toEqual({ labels: { name: 'warm-node22' } });
  });

  it('provisions a sandbox from a snapshot with only sourcesRef, polling to Running', async () => {
    const { client, requests } = makeClient(
      [
        { status: 200, body: { id: 'sbx-2', state: 'Creating' } }, // PUT sandboxes
        { status: 200, body: { id: 'sbx-2', state: 'Running' } }, // poll
      ],
      { assumeGroupExists: true },
    );

    const id = await client.createFromSnapshot('snap-1');

    expect(id).toBe('sbx-2');
    const putReq = requests[0] ?? failRequest();
    expect(putReq.url).toContain('/sandboxGroups/autopod-spike/sandboxes');
    expect(jsonBody(putReq)).toEqual({
      sourcesRef: { snapshot: { id: 'snap-1' } },
      labels: { purpose: 'autopod-sandbox' },
    });
  });

  it('deletes a snapshot idempotently', async () => {
    const { client, requests } = makeClient([{ status: 404 }]);

    await expect(client.deleteSnapshot('snap-1')).resolves.toBeUndefined();
    expect(requests[0]?.url).toContain('/sandboxGroups/autopod-spike/snapshots/snap-1');
  });

  it('reports a deleted sandbox distinctly from stopped and unknown', async () => {
    const { client, requests } = makeClient([{ status: 404 }]);

    await expect(client.getStatus('sbx-deleted')).resolves.toBe('deleted');
    expect(requests[0]?.url).toContain('/sandboxes/sbx-deleted');
  });

  it('treats existing directories as successful mkdirs', async () => {
    const { client, requests } = makeClient([
      { status: 409, body: { title: 'FileAlreadyExists', detail: 'directory already exists' } },
    ]);

    await expect(client.mkdir('sbx-1', '/mnt')).resolves.toBeUndefined();

    expect(requests[0]?.url).toContain('/sandboxes/sbx-1/files/mkdir');
    expect(jsonBody(requests[0] ?? failRequest())).toEqual({ path: '/mnt' });
  });

  it('destroys sandbox without deleting reusable disk images', async () => {
    const { client, requests } = makeClient([
      { status: 202, body: {} },
      { status: 404, body: {} },
    ]);

    await client.destroy('sbx-1');

    expect(requests.map((request) => request.init?.method)).toEqual(['DELETE', 'GET']);
    expect(requests.some((request) => request.url.includes('/diskimages/'))).toBe(false);
  });
});

function failRequest(): CapturedRequest {
  throw new Error('missing request');
}

function diskImageLabelsFor(image: string, sourceDigest: string): Record<string, string> {
  const sourceImageHash = testHash(image, 16);
  const name = `autopod-${sourceImageHash}-${testHash(sourceDigest, 12)}`;
  return {
    managedBy: 'autopod',
    name,
    sourceImageHash,
    sourceDigest,
  };
}

function testHash(value: string, length: number): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

it.each(['array', 'value', 'items'])(
  'managed discovery supports %s without duplicating identity',
  async (shape) => {
    const row = {
      id: 'sandbox-one',
      labels: { podId: 'managed-one', executionSpecDigest: `sha256:${'a'.repeat(64)}` },
    };
    const body = shape === 'array' ? [row] : { [shape]: [row] };
    const { client, requests } = makeClient([{ status: 200, body }]);
    expect(await client.findManagedSandbox('managed-one', `sha256:${'a'.repeat(64)}`)).toBe(
      'sandbox-one',
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]?.init?.method).toBe('GET');
  },
);
it.each([
  null,
  {},
  { value: [], nextLink: 'more' },
  [null],
  [{ id: 'one', labels: { podId: 'managed-one', executionSpecDigest: 'other' } }],
  [
    {
      id: 'one',
      labels: { podId: 'managed-one', executionSpecDigest: `sha256:${'a'.repeat(64)}` },
    },
    {
      id: 'two',
      labels: { podId: 'managed-one', executionSpecDigest: `sha256:${'a'.repeat(64)}` },
    },
  ],
])(
  'managed discovery fails closed on unknown, truncated or conflicting responses',
  async (body) => {
    const { client } = makeClient([{ status: 200, body }]);
    await expect(
      client.findManagedSandbox('managed-one', `sha256:${'a'.repeat(64)}`),
    ).rejects.toThrow();
  },
);

it('managed image staging refuses a mutable tag before any credential or network effects', async () => {
  const { client, requests } = makeClient([]);
  await expect(client.prepareManagedImage('registry/image:latest')).rejects.toThrow(
    'digest-required',
  );
  expect(requests).toEqual([]);
});

it('managed create uses a lossless label-safe digest and restart discovery accepts it', async () => {
  const digest = `sha256:${'f'.repeat(64)}`;
  const { client, requests } = makeClient(
    [
      { status: 200, body: [] },
      { status: 200, body: { id: 'disk' } },
      { status: 200, body: { id: 'disk', status: { state: 'Ready' } } },
      { status: 200, body: { id: 'sandbox' } },
      { status: 200, body: { id: 'sandbox', state: 'Running' } },
    ],
    { assumeGroupExists: true },
  );
  await client.createSandbox({
    image: `registry.example/image@sha256:${'b'.repeat(64)}`,
    podId: 'managed-one',
    managedSpecDigest: digest,
    tier: 'S',
    egressPolicy: { defaultAction: 'Deny', hostRules: [] },
  });
  const create = requests.find((r) => r.url.includes('/sandboxes?'));
  const label = JSON.parse(String(create?.init?.body)).labels.executionSpecDigest;
  expect(label).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{0,61}[A-Za-z0-9]$/);
  expect(Buffer.from(label.slice(1, -1), 'base64url').toString('hex')).toBe(digest.slice(7));
  const restart = makeClient([
    {
      status: 200,
      body: [{ id: 'sandbox', labels: { podId: 'managed-one', executionSpecDigest: label } }],
    },
  ]).client;
  expect(await restart.findManagedSandbox('managed-one', digest)).toBe('sandbox');
  const conflict = makeClient([
    {
      status: 200,
      body: [{ id: 'sandbox', labels: { podId: 'managed-one', executionSpecDigest: label } }],
    },
  ]).client;
  await expect(
    conflict.findManagedSandbox('managed-one', `sha256:${'e'.repeat(64)}`),
  ).rejects.toThrow('identity-conflict');
});
it('invalid managed digest is refused before credentials or creation', async () => {
  const { client, requests } = makeClient([]);
  await expect(
    client.createSandbox({
      image: 'image',
      podId: 'managed-one',
      managedSpecDigest: 'invalid',
      tier: 'S',
      egressPolicy: { defaultAction: 'Deny', hostRules: [] },
    }),
  ).rejects.toThrow('invalid-managed-spec-digest');
  expect(requests).toHaveLength(0);
});

it('managed Full inspection is sent and read back before acceptance', async () => {
  const policy = {
    defaultAction: 'Deny' as const,
    hostRules: [],
    trafficInspection: 'Full' as const,
  };
  const { client, requests } = makeClient([
    { status: 204 },
    { status: 200, body: { egressPolicy: policy } },
  ]);
  await client.updateEgress('one', policy);
  expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
    defaultAction: 'Deny',
    trafficInspection: 'Full',
  });
  expect(requests[1]?.init?.method).toBe('GET');
  expect(requests[1]?.url).not.toContain('/egresspolicy');
});
it.each([
  { defaultAction: 'Deny', trafficInspection: 'None' },
  { defaultAction: 'Allow', trafficInspection: 'Full' },
  {
    defaultAction: 'Deny',
    trafficInspection: 'Full',
    hostRules: [{ pattern: '*', action: 'Allow' }],
  },
])('managed egress readback drift fails closed', async (body) => {
  const { client } = makeClient([{ status: 204 }, { status: 200, body: { egressPolicy: body } }]);
  await expect(
    client.updateEgress('one', { defaultAction: 'Deny', hostRules: [], trafficInspection: 'Full' }),
  ).rejects.toThrow('egress-unconfirmed');
});

describe('observed sandbox allocation', () => {
  it.each([
    ['2000m', '4096Mi', 2, 4294967296],
    ['0.5', '4Gi', 0.5, 4294967296],
    ['0', '0Gi', null, null],
    ['Infinity', '9007199254740992Gi', null, null],
    ['-2', '4GB', null, null],
  ])(
    'decodes provider quantities %s / %s without guessing',
    async (cpu, memory, cpuLimit, memoryLimitBytes) => {
      const { client, requests } = makeClient([
        {
          status: 200,
          body: {
            id: 'observed',
            state: 'Running',
            resources: { cpu, memory },
          },
        },
      ]);
      expect(await client.getResourceAllocation('observed')).toEqual({
        cpuLimit,
        memoryLimitBytes,
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.init?.method).toBe('GET');
    },
  );

  it.each([
    { id: 'other', state: 'Running', resources: { cpu: '2', memory: '4Gi' } },
    { id: 'observed', state: 'Suspended', resources: { cpu: '2', memory: '4Gi' } },
    { id: 'observed', resources: { cpu: '2', memory: '4Gi' } },
    { id: 'observed', state: 'Running' },
  ])('does not invent allocation from missing or mismatched live identity', async (body) => {
    const { client } = makeClient([{ status: 200, body }]);
    expect(await client.getResourceAllocation('observed')).toEqual({
      cpuLimit: null,
      memoryLimitBytes: null,
    });
  });
});

it('pins the imported image to the digest resolved before creation', async () => {
  const digest = `sha256:${'a'.repeat(64)}`;
  const { client, requests } = makeClient(
    [
      { status: 200, body: { value: [] } },
      { status: 200, body: { id: 'disk-pinned', status: { state: 'Ready' } } },
      { status: 200, body: { id: 'disk-pinned', status: { state: 'Ready' } } },
      { status: 200, body: { id: 'sandbox-pinned', state: 'Running' } },
      { status: 200, body: { id: 'sandbox-pinned', state: 'Running' } },
    ],
    {
      assumeGroupExists: true,
      registryCredentials: { username: 'fixture', token: 'fixture' },
      resolveImageDigest: async () => digest,
    },
  );
  await client.createSandbox({
    image: 'registry.test:5000/team/image:latest',
    tier: 'L',
    env: {},
    egressPolicy: { defaultAction: 'Deny', hostRules: [] },
  });
  expect(jsonBody(requests[1] ?? failRequest())).toMatchObject({
    image: { base: `registry.test:5000/team/image@${digest}` },
  });
});

it('does not reuse a mutable import carrying a resolved digest label', async () => {
  const image = 'registry.test/team/image:latest';
  const digest = `sha256:${'a'.repeat(64)}`;
  const old = {
    id: 'mutable-import',
    image: { base: image },
    labels: diskImageLabelsFor(image, digest),
    status: { state: 'Ready' },
  };
  const { client, requests } = makeClient(
    [
      { status: 200, body: { value: [old] } },
      { status: 200, body: { id: 'pinned-import', status: { state: 'Ready' } } },
      { status: 200, body: { id: 'pinned-import', status: { state: 'Ready' } } },
      { status: 200, body: { id: 'sandbox', state: 'Running' } },
      { status: 200, body: { id: 'sandbox', state: 'Running' } },
    ],
    {
      assumeGroupExists: true,
      registryCredentials: { username: 'fixture', token: 'fixture' },
      resolveImageDigest: async () => digest,
    },
  );
  await client.createSandbox({
    image,
    tier: 'L',
    env: {},
    egressPolicy: { defaultAction: 'Deny', hostRules: [] },
  });
  expect(jsonBody(requests[1] ?? failRequest())).toMatchObject({
    image: { base: `registry.test/team/image@${digest}` },
  });
  expect(jsonBody(requests[3] ?? failRequest())).toMatchObject({
    sourcesRef: { diskImage: { id: 'pinned-import' } },
  });
  expect(requests.some((request) => request.init?.method === 'DELETE')).toBe(false);
});

it('rejects a malformed resolved digest before creating any resource', async () => {
  const { client, requests } = makeClient([], {
    resolveImageDigest: async () => 'sha256:invalid',
    assumeGroupExists: true,
  });
  await expect(
    client.createSandbox({
      image: 'registry.test/image:latest',
      tier: 'L',
      env: {},
      egressPolicy: { defaultAction: 'Deny', hostRules: [] },
    }),
  ).rejects.toMatchObject({ code: 'AZURE_SANDBOX_IMAGE_DIGEST' });
  expect(requests).toHaveLength(0);
});
