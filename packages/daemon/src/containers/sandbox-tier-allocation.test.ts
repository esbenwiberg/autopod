/**
 * End-to-end sizing for hosted sandboxes, with Azure mocked at `fetch`:
 * advertised capabilities → launch admission (frozen allocation) → memory
 * request → SandboxContainerManager (ordinary and managed spawn) → Azure
 * create payload. No cloud calls.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  environmentPresetSchema,
  executionSettingsSchema,
  type ResolvedExecution,
} from '@autopod/shared';
import Database from 'better-sqlite3';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { sandboxCapabilities } from '../configuration/backend-capabilities.js';
import { resolveExecution } from '../configuration/resolve-execution.js';
import { AzureSandboxApiClient } from './azure-sandbox-api-client.js';
import { containerMemoryRequestBytes } from './container-memory.js';
import { SandboxContainerManager } from './sandbox-container-manager.js';

const logger = pino({ level: 'silent' });
const sourceDigest = `sha256:${'1'.repeat(64)}`;
const image = `ewiacr.azurecr.io/autopod/test-app@${sourceDigest}`;
const hash = (value: string, length: number) =>
  createHash('sha256').update(value).digest('hex').slice(0, length);
const diskImage = {
  id: 'disk-1',
  image: { base: image },
  status: { state: 'Ready' },
  labels: {
    managedBy: 'autopod',
    name: `autopod-${hash(image, 16)}-${hash(sourceDigest, 12)}`,
    sourceImageHash: hash(image, 16),
    sourceDigest,
  },
};

/** Routes the Sandboxes data plane and records every sandbox create payload. */
function azure() {
  const creates: Array<{ resources: unknown; labels: Record<string, string> }> = [];
  const sandboxes: Array<{
    id: string;
    state: string;
    labels: Record<string, string>;
    egressPolicy?: unknown;
  }> = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? 'GET';
    if (method === 'GET' && path.endsWith('/diskimages')) return json({ value: [diskImage] });
    if (method === 'GET' && path.endsWith('/diskimages/disk-1')) return json(diskImage);
    if (method === 'GET' && path.endsWith('/sandboxes')) return json(sandboxes);
    if (method === 'PUT' && path.endsWith('/sandboxes')) {
      const body = JSON.parse(String(init?.body)) as (typeof creates)[number];
      creates.push(body);
      const sandbox = { id: `sbx-${creates.length}`, state: 'Running', labels: body.labels };
      sandboxes.push(sandbox);
      return json(sandbox);
    }
    const sandbox = sandboxes.find((entry) => path.includes(`/sandboxes/${entry.id}`));
    if (method === 'GET' && sandbox && path.endsWith(`/sandboxes/${sandbox.id}`))
      return json(sandbox);
    if (method === 'POST' && sandbox && path.endsWith(`/sandboxes/${sandbox.id}/egresspolicy`)) {
      sandbox.egressPolicy = JSON.parse(String(init?.body));
      return json({});
    }
    if (method === 'POST' && path.endsWith('/executeShellCommand'))
      return json({ exitCode: 0, stdout: '', stderr: '' });
    throw new Error(`unexpected request ${method} ${path}`);
  };
  const client = new AzureSandboxApiClient(
    {
      subscriptionId: 'sub-1',
      resourceGroup: 'rg-1',
      location: 'swedencentral',
      sandboxGroup: 'autopod-spike',
      assumeGroupExists: true,
      credential: {
        getToken: async () => ({ token: 'token', expiresOnTimestamp: Date.now() + 1e6 }),
      },
      fetch,
      resolveImageDigest: async () => sourceDigest,
      pollIntervalMs: 0,
    },
    logger,
  );
  return { client, creates };
}

function admit(memoryGb?: number): ResolvedExecution {
  return resolveExecution({
    environment: environmentPresetSchema.parse({ template: 'node22', sidecars: [] }),
    execution: executionSettingsSchema.parse({
      target: 'sandbox',
      main: memoryGb === undefined ? {} : { memoryGb },
    }),
    requiredSidecarIds: [],
    trustedRepository: false,
    capabilities: sandboxCapabilities({ enabled: true, defaultTier: 'L' }),
  });
}

const L = { cpu: '2000m', memory: '4096Mi', disk: '40Gi' };
const XL = { cpu: '4000m', memory: '8192Mi', disk: '80Gi' };
const XXL = { cpu: '8000m', memory: '16384Mi', disk: '160Gi' };
const XXXL = { cpu: '16000m', memory: '32768Mi', disk: '320Gi' };

describe('hosted sandbox sizing from admission to the Azure create payload', () => {
  it.each([
    ['omitted', undefined, L],
    ['XL', 8, XL],
    ['2XL', 16, XXL],
    ['3XL', 32, XXXL],
  ] as const)('ordinary spawn: %s selection', async (_name, selected, resources) => {
    const frozen = admit(selected);
    const { client, creates } = azure();
    const manager = new SandboxContainerManager(client, logger);
    await manager.spawn({
      image,
      podId: 'pod-1',
      env: {},
      memoryBytes: containerMemoryRequestBytes(frozen.main.memoryGb, 'sandbox'),
    });
    expect(creates.map((create) => create.resources)).toEqual([resources]);
  });

  it.each([
    ['omitted', undefined, L],
    ['XL', 8, XL],
    ['2XL', 16, XXL],
    ['3XL', 32, XXXL],
  ] as const)('managed allocation: %s selection, reused without duplication', async (_name, selected, resources) => {
    const db = new Database(':memory:');
    db.exec(
      readFileSync(
        new URL('../db/migrations/149_managed_sandbox_allocations.sql', import.meta.url),
        'utf8',
      ),
    );
    try {
      const frozen = admit(selected);
      const { client, creates } = azure();
      const config = {
        image,
        podId: 'managed-1',
        env: {},
        networkPolicyMode: 'deny-all' as const,
        managedSpecDigest: `sha256:${'2'.repeat(64)}`,
        memoryBytes: containerMemoryRequestBytes(frozen.main.memoryGb, 'sandbox'),
      };
      const manager = () => new SandboxContainerManager(client, logger, { managedDatabase: db });
      const first = await manager().ensureManagedContainer(config);
      // Retry/recovery with the same frozen allocation reuses the same sandbox.
      expect(await manager().ensureManagedContainer(config)).toBe(first);
      expect(creates.map((create) => create.resources)).toEqual([resources]);
    } finally {
      db.close();
    }
  });

  it('a legacy sandbox pod without a size gets the L default, not 2XL', async () => {
    const { client, creates } = azure();
    await new SandboxContainerManager(client, logger).spawn({
      image,
      podId: 'legacy',
      env: {},
      memoryBytes: containerMemoryRequestBytes(null, 'sandbox'),
    });
    expect(creates.map((create) => create.resources)).toEqual([L]);
  });

  it('a size above 3XL (64 GB) fails at admission and, if replayed past it, before any Azure request', async () => {
    expect(() => admit(64)).toThrow(expect.objectContaining({ code: 'ALLOCATION_UNSUPPORTED' }));
    const { client, creates } = azure();
    await expect(
      new SandboxContainerManager(client, logger).spawn({
        image,
        podId: 'pod-1',
        env: {},
        memoryBytes: containerMemoryRequestBytes(64, 'sandbox'),
      }),
    ).rejects.toMatchObject({ code: 'PREFLIGHT_INSUFFICIENT_MEMORY' });
    expect(creates).toHaveLength(0);
  });
});
