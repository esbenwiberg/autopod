import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { AutopodError } from '@autopod/shared';
import pino from 'pino';
import * as tar from 'tar-stream';
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
import { EXTRACT_TAR_PATH, SandboxContainerManager } from './sandbox-container-manager.js';

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

function buildGzippedTar(
  entries: Array<{ name: string; content?: string; dir?: boolean }>,
): Promise<Buffer> {
  const pack = tar.pack();
  for (const e of entries) {
    if (e.dir) {
      pack.entry({ name: e.name, type: 'directory' });
    } else {
      pack.entry({ name: e.name }, e.content ?? '');
    }
  }
  pack.finalize();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    pack.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
    pack.on('end', () => resolve(gzipSync(Buffer.concat(chunks))));
    pack.on('error', reject);
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
        rules: [{ match: { host: 'api.github.com' }, action: 'Allow' }],
      });
    });

    it('defaults to an allow-all egress policy', async () => {
      const client = new FakeSandboxApiClient();
      await new SandboxContainerManager(client, logger).spawn(baseConfig);
      expect(client.created[0]?.egressPolicy).toEqual({ defaultAction: 'Allow', rules: [] });
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

    it('refreshFirewall is a no-op (egress applied at spawn)', async () => {
      const client = new FakeSandboxApiClient();
      const mgr = new SandboxContainerManager(client, logger);
      const id = await mgr.spawn(baseConfig);
      await expect(mgr.refreshFirewall(id, '#!/bin/sh\niptables ...')).resolves.toBeUndefined();
      expect(client.egressUpdates).toHaveLength(0);
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
    let hostDir: string;

    beforeEach(() => {
      hostDir = mkdtempSync(join(tmpdir(), 'sandbox-extract-'));
    });
    afterEach(() => {
      rmSync(hostDir, { recursive: true, force: true });
    });

    it('tars in the sandbox, downloads, and extracts honouring excludes', async () => {
      const tarball = await buildGzippedTar([
        { name: './a.txt', content: 'A' },
        { name: './sub', dir: true },
        { name: './sub/b.txt', content: 'B' },
        { name: './node_modules', dir: true },
        { name: './node_modules/junk.txt', content: 'junk' },
      ]);

      const client = new FakeSandboxApiClient((_id, command) => {
        // The tar command should target the requested container path.
        expect(command[0]).toBe('sh');
        expect(command[2]).toContain('tar czf');
        expect(command[2]).toContain("-C '/work'");
        return { stdout: '', stderr: '', exitCode: 0 };
      });
      const mgr = new SandboxContainerManager(client, logger);
      const id = await mgr.spawn(baseConfig);
      client.seedFile(id, EXTRACT_TAR_PATH, tarball);

      await mgr.extractDirectoryFromContainer(id, '/work', hostDir, ['node_modules']);

      expect(readFileSync(join(hostDir, 'a.txt'), 'utf-8')).toBe('A');
      expect(readFileSync(join(hostDir, 'sub', 'b.txt'), 'utf-8')).toBe('B');
      expect(existsSync(join(hostDir, 'node_modules'))).toBe(false);
    });

    it('throws when the in-sandbox tar fails', async () => {
      const client = new FakeSandboxApiClient(() => ({
        stdout: '',
        stderr: 'tar: permission denied',
        exitCode: 2,
      }));
      const mgr = new SandboxContainerManager(client, logger);
      const id = await mgr.spawn(baseConfig);
      await expect(mgr.extractDirectoryFromContainer(id, '/work', hostDir)).rejects.toThrow(
        /permission denied/,
      );
    });
  });

  describe('withAzureClient (stub wiring)', () => {
    it('surfaces NOT_IMPLEMENTED from the unwired Azure adapter', async () => {
      const mgr = SandboxContainerManager.withAzureClient(
        { subscriptionId: 'sub', resourceGroup: 'rg', location: 'westeurope' },
        logger,
      );
      await expect(mgr.spawn(baseConfig)).rejects.toMatchObject({
        code: 'NOT_IMPLEMENTED',
        statusCode: 501,
      });
      await expect(mgr.spawn(baseConfig)).rejects.toBeInstanceOf(AutopodError);
    });

    it('exposes the AzureSandboxApiClient as the default backend', () => {
      const client = new AzureSandboxApiClient(
        { subscriptionId: 'sub', resourceGroup: 'rg', location: 'westeurope' },
        logger,
      );
      expect(client).toBeInstanceOf(AzureSandboxApiClient);
    });
  });
});
