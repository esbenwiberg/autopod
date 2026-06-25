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

function makeClient(responses: MockHttpResponse[]): {
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
      },
      logger,
    ),
    requests,
  };
}

function jsonBody(request: CapturedRequest): unknown {
  return JSON.parse(String(request.init?.body));
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

  it('executes buffered shell commands and maps the response', async () => {
    const { client, requests } = makeClient([
      { status: 200, body: { stdout: 'out', stderr: 'err', exitCode: 7 } },
    ]);

    const result = await client.exec('sbx-1', ['sh', '-lc', 'echo "$FOO"'], {
      cwd: '/workspace',
      env: { FOO: "a'b" },
      timeoutMs: 5000,
    });

    expect(result).toEqual({ stdout: 'out', stderr: 'err', exitCode: 7 });
    expect(requests[0]?.url).toContain('/sandboxes/sbx-1/executeShellCommand');
    expect(jsonBody(requests[0] ?? failRequest())).toEqual({
      command: "env FOO='a'\\''b' sh -lc 'echo \"$FOO\"'",
      workingDirectory: '/workspace',
    });
  });

  it('writes files, reads files, and updates egress policy through the data plane', async () => {
    const { client, requests } = makeClient([
      { status: 204 },
      { status: 200, rawText: 'hello' },
      { status: 204 },
    ]);

    await client.writeFile('sbx-1', '/tmp/hello.txt', Buffer.from('hello'));
    const read = await client.readFile('sbx-1', '/tmp/hello.txt');
    await client.updateEgress('sbx-1', {
      defaultAction: 'Deny',
      hostRules: [{ pattern: 'api.github.com', action: 'Allow' }],
    });

    expect(requests[0]?.url).toContain('/sandboxes/sbx-1/files');
    expect(requests[0]?.url).toContain('path=%2Ftmp%2Fhello.txt');
    expect(requests[0]?.url).toContain('createDirs=true');
    expect(read.toString('utf-8')).toBe('hello');
    expect(requests[2]?.url).toContain('/sandboxes/sbx-1/egresspolicy');
    expect(jsonBody(requests[2] ?? failRequest())).toEqual({
      defaultAction: 'Deny',
      hostRules: [{ pattern: 'api.github.com', action: 'Allow' }],
    });
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
