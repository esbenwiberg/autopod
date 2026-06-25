import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContainerSpawnConfig } from '../interfaces/container-manager.js';
import { AzureSandboxApiClient } from './azure-sandbox-api-client.js';
import type {
  CreateSandboxOptions,
  SandboxApiClient,
  SandboxEgressPolicy,
  SandboxExecChunk,
  SandboxExecOptions,
  SandboxExecResult,
  SandboxStatus,
} from './sandbox-api-client.js';
import {
  SandboxContainerManager,
  sandboxEgressRefreshPayload,
} from './sandbox-container-manager.js';

const logger = pino({ level: 'silent' });

interface FakeSandbox {
  status: SandboxStatus;
  files: Map<string, Buffer>;
}

type ExecHandler = (
  id: string,
  command: string[],
  options?: SandboxExecOptions,
) => SandboxExecResult;

class FakeSandboxApiClient implements SandboxApiClient {
  readonly created: CreateSandboxOptions[] = [];
  readonly execCalls: Array<{ id: string; command: string[]; options?: SandboxExecOptions }> = [];
  readonly egressUpdates: Array<{ id: string; policy: SandboxEgressPolicy }> = [];
  readonly mkdirCalls: Array<{ id: string; path: string }> = [];
  readonly sandboxes = new Map<string, FakeSandbox>();
  private counter = 0;

  constructor(private readonly execHandler?: ExecHandler) {}

  async createSandbox(options: CreateSandboxOptions): Promise<string> {
    this.created.push(options);
    const id = `sbx-${++this.counter}`;
    this.sandboxes.set(id, { status: 'running', files: new Map() });
    return id;
  }

  async destroy(sandboxId: string): Promise<void> {
    this.sandboxes.delete(sandboxId);
  }

  async exec(
    sandboxId: string,
    command: string[],
    options?: SandboxExecOptions,
  ): Promise<SandboxExecResult> {
    this.execCalls.push({ id: sandboxId, command, options });
    if (this.execHandler) return this.execHandler(sandboxId, command, options);
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  async writeFile(sandboxId: string, path: string, content: Buffer): Promise<void> {
    this.sandbox(sandboxId).files.set(path, content);
  }

  async readFile(sandboxId: string, path: string): Promise<Buffer> {
    const file = this.sandboxes.get(sandboxId)?.files.get(path);
    if (!file) throw new Error(`no such file: ${path}`);
    return file;
  }

  async mkdir(sandboxId: string, path: string): Promise<void> {
    this.sandbox(sandboxId);
    this.mkdirCalls.push({ id: sandboxId, path });
  }

  async updateEgress(sandboxId: string, policy: SandboxEgressPolicy): Promise<void> {
    this.egressUpdates.push({ id: sandboxId, policy });
  }

  async suspend(sandboxId: string): Promise<void> {
    this.sandbox(sandboxId).status = 'stopped';
  }

  async resume(sandboxId: string): Promise<void> {
    this.sandbox(sandboxId).status = 'running';
  }

  async getStatus(sandboxId: string): Promise<SandboxStatus> {
    return this.sandboxes.get(sandboxId)?.status ?? 'unknown';
  }

  seedFile(sandboxId: string, path: string, content: Buffer): void {
    this.sandbox(sandboxId).files.set(path, content);
  }

  private sandbox(id: string): FakeSandbox {
    const s = this.sandboxes.get(id);
    if (!s) throw new Error(`unknown sandbox: ${id}`);
    return s;
  }
}

/** A client variant exposing a native streaming exec. */
class StreamingFakeClient extends FakeSandboxApiClient {
  async *execStream(): AsyncIterable<SandboxExecChunk> {
    yield { stdout: 'chunk-1 ' };
    yield { stdout: 'chunk-2' };
    yield { stderr: 'warn' };
    yield { exitCode: 7 };
  }
}

function readStream(stream: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    stream.on('error', reject);
  });
}

const baseConfig: ContainerSpawnConfig = { image: 'autopod-node22', podId: 'pod-1', env: {} };

describe('SandboxContainerManager', () => {
  describe('spawn', () => {
    it('creates a sandbox and returns its id', async () => {
      const client = new FakeSandboxApiClient();
      const mgr = new SandboxContainerManager(client, logger);
      const id = await mgr.spawn(baseConfig);
      expect(id).toBe('sbx-1');
      expect(client.created).toHaveLength(1);
      expect(client.created[0]?.image).toBe('autopod-node22');
      expect(client.created[0]?.env).toEqual({});
    });

    it('uses the default tier when no memory hint is given', async () => {
      const client = new FakeSandboxApiClient();
      await new SandboxContainerManager(client, logger).spawn(baseConfig);
      expect(client.created[0]?.tier).toBe('L');

      const client2 = new FakeSandboxApiClient();
      await new SandboxContainerManager(client2, logger, { defaultTier: 'M' }).spawn(baseConfig);
      expect(client2.created[0]?.tier).toBe('M');
    });

    it('derives the tier from memoryBytes', async () => {
      const client = new FakeSandboxApiClient();
      await new SandboxContainerManager(client, logger).spawn({
        ...baseConfig,
        memoryBytes: 1.5 * 1024 * 1024 * 1024,
      });
      expect(client.created[0]?.tier).toBe('M');
    });

    it('maps network policy + allowed hosts to an egress policy', async () => {
      const client = new FakeSandboxApiClient();
      await new SandboxContainerManager(client, logger).spawn({
        ...baseConfig,
        networkPolicyMode: 'restricted',
        allowedHosts: ['api.github.com'],
      });
      expect(client.created[0]?.egressPolicy).toEqual({
        defaultAction: 'Deny',
        hostRules: [{ pattern: 'api.github.com', action: 'Allow' }],
      });
    });

    it('defaults to an allow-all egress policy', async () => {
      const client = new FakeSandboxApiClient();
      await new SandboxContainerManager(client, logger).spawn(baseConfig);
      expect(client.created[0]?.egressPolicy).toEqual({ defaultAction: 'Allow', hostRules: [] });
    });

    it('uploads host volumes because sandboxes have no bind mounts', async () => {
      const hostDir = mkdtempSync(join(tmpdir(), 'sandbox-upload-'));
      try {
        mkdirSync(join(hostDir, 'src'));
        mkdirSync(join(hostDir, 'node_modules'));
        writeFileSync(join(hostDir, 'README.md'), 'hello');
        writeFileSync(join(hostDir, 'src', 'index.ts'), 'console.log("hi");');
        writeFileSync(join(hostDir, 'node_modules', 'left-pad.js'), 'skip');
        symlinkSync('README.md', join(hostDir, 'README-link'));

        const client = new FakeSandboxApiClient();
        const id = await new SandboxContainerManager(client, logger).spawn({
          ...baseConfig,
          volumes: [{ host: hostDir, container: '/mnt/worktree' }],
        });

        const files = client.sandboxes.get(id)?.files;
        expect(files?.get('/mnt/worktree/README.md')?.toString('utf-8')).toBe('hello');
        expect(files?.get('/mnt/worktree/src/index.ts')?.toString('utf-8')).toBe(
          'console.log("hi");',
        );
        expect(files?.get('/mnt/worktree/README-link')?.toString('utf-8')).toBe('README.md');
        expect(files?.has('/mnt/worktree/node_modules/left-pad.js')).toBe(false);
        expect(client.mkdirCalls.map((call) => call.path)).toEqual([
          '/mnt/worktree',
          '/mnt/worktree/src',
        ]);
      } finally {
        rmSync(hostDir, { recursive: true, force: true });
      }
    });
  });

  describe('lifecycle', () => {
    it('kill destroys the sandbox', async () => {
      const client = new FakeSandboxApiClient();
      const mgr = new SandboxContainerManager(client, logger);
      const id = await mgr.spawn(baseConfig);
      await mgr.kill(id);
      expect(client.sandboxes.has(id)).toBe(false);
    });

    it('stop/start map to suspend/resume', async () => {
      const client = new FakeSandboxApiClient();
      const mgr = new SandboxContainerManager(client, logger);
      const id = await mgr.spawn(baseConfig);

      await mgr.stop(id);
      expect(await mgr.getStatus(id)).toBe('stopped');
      await mgr.start(id);
      expect(await mgr.getStatus(id)).toBe('running');
    });

    it('getStatus returns unknown for a missing sandbox', async () => {
      const mgr = new SandboxContainerManager(new FakeSandboxApiClient(), logger);
      expect(await mgr.getStatus('nope')).toBe('unknown');
    });

    it('refreshFirewall reapplies the last known policy by default', async () => {
      const client = new FakeSandboxApiClient();
      const mgr = new SandboxContainerManager(client, logger);
      const id = await mgr.spawn({
        ...baseConfig,
        networkPolicyMode: 'restricted',
        allowedHosts: ['api.github.com'],
      });
      await expect(mgr.refreshFirewall(id, '#!/bin/sh\niptables ...')).resolves.toBeUndefined();
      expect(client.egressUpdates).toEqual([
        {
          id,
          policy: {
            defaultAction: 'Deny',
            hostRules: [{ pattern: 'api.github.com', action: 'Allow' }],
          },
        },
      ]);
    });

    it('refreshFirewall accepts a sandbox egress refresh payload', async () => {
      const client = new FakeSandboxApiClient();
      const mgr = new SandboxContainerManager(client, logger);
      const id = await mgr.spawn(baseConfig);
      await mgr.refreshFirewall(
        id,
        sandboxEgressRefreshPayload('restricted', ['api.github.com', 'pypi.org']),
      );
      expect(client.egressUpdates.at(-1)).toEqual({
        id,
        policy: {
          defaultAction: 'Deny',
          hostRules: [
            { pattern: 'api.github.com', action: 'Allow' },
            { pattern: 'pypi.org', action: 'Allow' },
          ],
        },
      });
    });
  });

  describe('file I/O', () => {
    it('writes and reads back a string file', async () => {
      const client = new FakeSandboxApiClient();
      const mgr = new SandboxContainerManager(client, logger);
      const id = await mgr.spawn(baseConfig);
      await mgr.writeFile(id, '/work/hello.txt', 'hi there');
      expect(await mgr.readFile(id, '/work/hello.txt')).toBe('hi there');
    });

    it('readFileBinary returns raw bytes', async () => {
      const client = new FakeSandboxApiClient();
      const mgr = new SandboxContainerManager(client, logger);
      const id = await mgr.spawn(baseConfig);
      const bytes = Buffer.from([0x00, 0xff, 0x10]);
      await mgr.writeFile(id, '/work/blob.bin', bytes);
      expect(await mgr.readFileBinary(id, '/work/blob.bin')).toEqual(bytes);
    });
  });

  describe('exec', () => {
    it('maps exec result and options', async () => {
      const client = new FakeSandboxApiClient(() => ({
        stdout: 'out',
        stderr: 'err',
        exitCode: 3,
      }));
      const mgr = new SandboxContainerManager(client, logger);
      const id = await mgr.spawn(baseConfig);
      const result = await mgr.execInContainer(id, ['ls', '-la'], {
        cwd: '/work',
        timeout: 5000,
        user: 'root',
        env: { FOO: 'bar' },
      });
      expect(result).toEqual({ stdout: 'out', stderr: 'err', exitCode: 3 });
      const call = client.execCalls.at(-1);
      expect(call?.command).toEqual(['ls', '-la']);
      expect(call?.options).toEqual({
        cwd: '/work',
        timeoutMs: 5000,
        user: 'root',
        env: { FOO: 'bar' },
      });
    });

    it('execStreaming falls back to buffered output when no native stream', async () => {
      const client = new FakeSandboxApiClient(() => ({
        stdout: 'hello world',
        stderr: '',
        exitCode: 0,
      }));
      const mgr = new SandboxContainerManager(client, logger);
      const id = await mgr.spawn(baseConfig);
      const stream = await mgr.execStreaming(id, ['echo', 'hi']);
      const [out, code] = await Promise.all([readStream(stream.stdout), stream.exitCode]);
      expect(out).toBe('hello world');
      expect(code).toBe(0);
    });

    it('execStreaming uses the native stream when available', async () => {
      const client = new StreamingFakeClient();
      const mgr = new SandboxContainerManager(client, logger);
      const id = await mgr.spawn(baseConfig);
      const stream = await mgr.execStreaming(id, ['slow']);
      const [out, err, code] = await Promise.all([
        readStream(stream.stdout),
        readStream(stream.stderr),
        stream.exitCode,
      ]);
      expect(out).toBe('chunk-1 chunk-2');
      expect(err).toBe('warn');
      expect(code).toBe(7);
    });
  });

  describe('extractDirectoryFromContainer', () => {
    it('throws a clear unsupported error', async () => {
      const client = new FakeSandboxApiClient();
      const mgr = new SandboxContainerManager(client, logger);
      const id = await mgr.spawn(baseConfig);
      await expect(mgr.extractDirectoryFromContainer(id, '/work', '/tmp/out')).rejects.toThrow(
        /unsupported for Azure Container Apps Sandboxes/,
      );
    });
  });

  describe('withAzureClient', () => {
    it('constructs a manager backed by the Azure adapter', () => {
      const mgr = SandboxContainerManager.withAzureClient(
        { subscriptionId: 'sub', resourceGroup: 'rg', location: 'swedencentral' },
        logger,
      );
      expect(mgr).toBeInstanceOf(SandboxContainerManager);
    });

    it('exposes the AzureSandboxApiClient as the default backend', () => {
      const client = new AzureSandboxApiClient(
        { subscriptionId: 'sub', resourceGroup: 'rg', location: 'swedencentral' },
        logger,
      );
      expect(client).toBeInstanceOf(AzureSandboxApiClient);
    });
  });
});
