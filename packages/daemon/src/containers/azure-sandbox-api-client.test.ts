import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { AzureSandboxApiClient } from './azure-sandbox-api-client.js';

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
    expect(requests).toHaveLength(7);
    expect(requests[0]?.url).toContain(
      'https://management.azure.com/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.App/sandboxGroups/autopod-spike',
    );
    expect(requests[3]?.url).toContain(
      'https://management.swedencentral.azuredevcompute.io/subscriptions/sub-1/resourceGroups/rg-1/sandboxGroups/autopod-spike/diskimages',
    );
    expect(jsonBody(requests[3] ?? failRequest())).toMatchObject({
      image: { base: 'mcr.microsoft.com/cbl-mariner/base/core:2.0' },
    });
    expect(jsonBody(requests[5] ?? failRequest())).toMatchObject({
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
    expect(requests[3]?.url).toBe('https://ewiacr.azurecr.io/oauth2/exchange');
    const exchange = formBody(requests[3] ?? failRequest());
    expect(exchange.get('grant_type')).toBe('access_token');
    expect(exchange.get('service')).toBe('ewiacr.azurecr.io');
    expect(exchange.get('access_token')).toBe('test-token');
    expect(jsonBody(requests[4] ?? failRequest())).toMatchObject({
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
    expect(jsonBody(requests[0] ?? failRequest())).toMatchObject({
      image: { base: 'ewiacr.azurecr.io/autopod/test-app:latest' },
      registryCredentials: { username: 'token-user', token: 'secret-token' },
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

  it('treats existing directories as successful mkdirs', async () => {
    const { client, requests } = makeClient([
      { status: 409, body: { title: 'FileAlreadyExists', detail: 'directory already exists' } },
    ]);

    await expect(client.mkdir('sbx-1', '/mnt')).resolves.toBeUndefined();

    expect(requests[0]?.url).toContain('/sandboxes/sbx-1/files/mkdir');
    expect(jsonBody(requests[0] ?? failRequest())).toEqual({ path: '/mnt' });
  });

  it('destroys sandbox and associated disk image idempotently', async () => {
    const { client, requests } = makeClient([
      { status: 200, body: { id: 'sbx-1', sourcesRef: { diskImage: { id: 'disk-1' } } } },
      { status: 202, body: {} },
      { status: 404, body: {} },
      { status: 202, body: {} },
      { status: 404, body: {} },
    ]);

    await client.destroy('sbx-1');

    expect(requests.map((request) => request.init?.method)).toEqual([
      'GET',
      'DELETE',
      'GET',
      'DELETE',
      'GET',
    ]);
    expect(requests[3]?.url).toContain('/diskimages/disk-1');
  });
});

function failRequest(): CapturedRequest {
  throw new Error('missing request');
}
