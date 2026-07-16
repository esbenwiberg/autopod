import { createHash } from 'node:crypto';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { AzureSandboxApiClient, type WebSocketLike } from './azure-sandbox-api-client.js';
import type { SandboxExecChunk } from './sandbox-api-client.js';

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
      egressPolicy: {
        defaultAction: 'Deny',
        hostRules: [{ pattern: 'api.github.com', action: 'Allow' }],
      },
    });
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
    const sourceDigest = 'sha256:digest1';
    const diskImage = {
      id: 'disk-digest1',
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
      labels: diskImageLabelsFor(image, 'sha256:old'),
    };
    const newDiskImage = {
      id: 'disk-new',
      status: { state: 'Ready' },
      labels: diskImageLabelsFor(image, 'sha256:new'),
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
        resolveImageDigest: async () => 'sha256:new',
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
      labels: diskImageLabelsFor(image, 'sha256:new'),
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
      '#!/bin/sh\numask 077\necho $$ > "$0.pid"\ncd /workspace || exit 1\nexec echo hello\n',
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
      [
        ...STREAM_SETUP_RESPONSES,
        { status: 200, body: { stdout: '', stderr: '', exitCode: 0 } },
      ],
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
    expect(String(writeReq.init?.body)).toBe('#!/bin/sh\nexec /bin/bash -l\n');
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
