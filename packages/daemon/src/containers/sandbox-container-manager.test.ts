import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, posix } from 'node:path';
import type { Readable } from 'node:stream';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContainerSpawnConfig } from '../interfaces/container-manager.js';
import { AzureSandboxApiClient } from './azure-sandbox-api-client.js';
import type {
  CreateSandboxOptions,
  SandboxApiClient,
  SandboxDirListing,
  SandboxEgressPolicy,
  SandboxExecChunk,
  SandboxExecOptions,
  SandboxExecResult,
  SandboxExposedPort,
  SandboxFileInfo,
  SandboxPortAuth,
  SandboxStatus,
} from './sandbox-api-client.js';
import {
  SandboxContainerManager,
  sandboxEgressRefreshPayload,
} from './sandbox-container-manager.js';

const logger = pino({ level: 'silent' });

interface FakeSandbox {
  status: SandboxStatus;
  dirs: Set<string>;
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
    this.sandboxes.set(id, { status: 'running', dirs: new Set(['/']), files: new Map() });
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
    const sandbox = this.sandbox(sandboxId);
    this.ensureDir(sandbox, dirname(path));
    sandbox.files.set(normalizeSandboxPath(path), content);
  }

  async readFile(sandboxId: string, path: string): Promise<Buffer> {
    const file = this.sandboxes.get(sandboxId)?.files.get(path);
    if (!file) throw new Error(`no such file: ${path}`);
    return file;
  }

  async mkdir(sandboxId: string, path: string): Promise<void> {
    this.ensureDir(this.sandbox(sandboxId), path);
    this.mkdirCalls.push({ id: sandboxId, path });
  }

  async listFiles(sandboxId: string, path: string): Promise<SandboxDirListing> {
    const sandbox = this.sandbox(sandboxId);
    const dir = normalizeSandboxPath(path);
    if (!sandbox.dirs.has(dir)) throw new Error(`no such directory: ${path}`);

    const entries = new Map<string, SandboxFileInfo>();
    for (const candidate of sandbox.dirs) {
      if (candidate === dir) continue;
      const rel = relativeSandboxPath(dir, candidate);
      if (!rel || rel.includes('/')) continue;
      entries.set(rel, {
        name: rel,
        path: candidate,
        isDirectory: true,
      });
    }
    for (const [candidate, content] of sandbox.files) {
      const rel = relativeSandboxPath(dir, candidate);
      if (!rel || rel.includes('/')) continue;
      entries.set(rel, {
        name: rel,
        path: candidate,
        size: content.byteLength,
        isDirectory: false,
      });
    }

    return {
      path: dir,
      entries: [...entries.values()].sort((a, b) => a.path.localeCompare(b.path)),
    };
  }

  async updateEgress(sandboxId: string, policy: SandboxEgressPolicy): Promise<void> {
    this.egressUpdates.push({ id: sandboxId, policy });
  }

  readonly addPortCalls: Array<{ id: string; port: number; auth?: SandboxPortAuth }> = [];
  readonly removePortCalls: Array<{ id: string; port: number }> = [];

  async addPort(
    sandboxId: string,
    port: number,
    auth?: SandboxPortAuth,
  ): Promise<SandboxExposedPort> {
    this.addPortCalls.push({ id: sandboxId, port, auth });
    return { port, url: `https://${sandboxId}--${port}.test.adcproxy.io` };
  }

  async removePort(sandboxId: string, port: number): Promise<void> {
    this.removePortCalls.push({ id: sandboxId, port });
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
    const sandbox = this.sandbox(sandboxId);
    this.ensureDir(sandbox, dirname(path));
    sandbox.files.set(normalizeSandboxPath(path), content);
  }

  private sandbox(id: string): FakeSandbox {
    const s = this.sandboxes.get(id);
    if (!s) throw new Error(`unknown sandbox: ${id}`);
    return s;
  }

  private ensureDir(sandbox: FakeSandbox, path: string): void {
    const normalized = normalizeSandboxPath(path);
    sandbox.dirs.add('/');
    let current = '';
    for (const segment of normalized.split('/').filter(Boolean)) {
      current += `/${segment}`;
      sandbox.dirs.add(current);
    }
  }
}

class StrictParentFakeClient extends FakeSandboxApiClient {
  override async mkdir(sandboxId: string, path: string): Promise<void> {
    this.assertParentExists(sandboxId, path);
    await super.mkdir(sandboxId, path);
  }

  override async writeFile(sandboxId: string, path: string, content: Buffer): Promise<void> {
    this.assertParentExists(sandboxId, path);
    await super.writeFile(sandboxId, path, content);
  }

  private assertParentExists(sandboxId: string, path: string): void {
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox) throw new Error(`unknown sandbox: ${sandboxId}`);
    const parent = normalizeSandboxPath(posix.dirname(normalizeSandboxPath(path)));
    if (parent !== '/' && !sandbox.dirs.has(parent)) {
      throw new Error(`parent directory missing: ${parent}`);
    }
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

const baseConfig: ContainerSpawnConfig = {
  image: 'ewiacr.azurecr.io/autopod-node22:latest',
  podId: 'pod-1',
  env: {},
};

describe('SandboxContainerManager', () => {
  describe('spawn', () => {
    it('creates a sandbox and returns its id', async () => {
      const client = new FakeSandboxApiClient();
      const mgr = new SandboxContainerManager(client, logger);
      const id = await mgr.spawn(baseConfig);
      expect(id).toBe('sbx-1');
      expect(client.created).toHaveLength(1);
      expect(client.created[0]?.image).toBe('ewiacr.azurecr.io/autopod-node22:latest');
      expect(client.created[0]?.env).toEqual({});
    });

    it('rejects local-only warm image tags before calling Azure', async () => {
      const client = new FakeSandboxApiClient();
      const mgr = new SandboxContainerManager(client, logger);
      await expect(mgr.spawn({ ...baseConfig, image: 'autopod/test-app:latest' })).rejects.toThrow(
        /registry-qualified OCI image/,
      );
      expect(client.created).toHaveLength(0);
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
          '/mnt',
          '/mnt/worktree',
          '/mnt/worktree/src',
        ]);
        expect(client.execCalls).toEqual([]);
      } finally {
        rmSync(hostDir, { recursive: true, force: true });
      }
    });

    it('creates sandbox parent directories before uploading nested volume paths', async () => {
      const hostDir = mkdtempSync(join(tmpdir(), 'sandbox-nested-upload-'));
      try {
        writeFileSync(join(hostDir, 'README.md'), 'hello');

        const client = new StrictParentFakeClient();
        const id = await new SandboxContainerManager(client, logger).spawn({
          ...baseConfig,
          volumes: [{ host: hostDir, container: '/home/ewi/.autopod/repos/worktree' }],
        });

        expect(
          client.sandboxes.get(id)?.files.get('/home/ewi/.autopod/repos/worktree/README.md'),
        ).toEqual(Buffer.from('hello'));
        expect(client.mkdirCalls.map((call) => call.path)).toEqual([
          '/home',
          '/home/ewi',
          '/home/ewi/.autopod',
          '/home/ewi/.autopod/repos',
          '/home/ewi/.autopod/repos/worktree',
        ]);
      } finally {
        rmSync(hostDir, { recursive: true, force: true });
      }
    });

    it('cleans up the sandbox when volume upload fails', async () => {
      const hostDir = mkdtempSync(join(tmpdir(), 'sandbox-upload-fail-'));
      try {
        writeFileSync(join(hostDir, 'README.md'), 'hello');
        class FailingWriteClient extends FakeSandboxApiClient {
          override async writeFile(): Promise<void> {
            throw new Error('write failed');
          }
        }
        const client = new FailingWriteClient();
        await expect(
          new SandboxContainerManager(client, logger).spawn({
            ...baseConfig,
            volumes: [{ host: hostDir, container: '/mnt/worktree' }],
          }),
        ).rejects.toThrow('write failed');
        expect(client.created).toHaveLength(1);
        expect(client.sandboxes.size).toBe(0);
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

    it('execStreaming rejects when no native stream is available', async () => {
      const client = new FakeSandboxApiClient(() => ({
        stdout: 'hello world',
        stderr: '',
        exitCode: 0,
      }));
      const mgr = new SandboxContainerManager(client, logger);
      const id = await mgr.spawn(baseConfig);
      await expect(mgr.execStreaming(id, ['echo', 'hi'])).rejects.toThrow(
        /Sandbox streaming exec is not supported/,
      );
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

  describe('exposePort', () => {
    it('exposes a port with an Entra allowlist and returns the URL', async () => {
      const client = new FakeSandboxApiClient();
      const mgr = new SandboxContainerManager(client, logger);
      const id = await mgr.spawn(baseConfig);

      const exposed = await mgr.exposePort(id, 3000, { entraEmails: ['ewi@projectum.com'] });

      expect(exposed.url).toBe(`https://${id}--3000.test.adcproxy.io`);
      expect(client.addPortCalls).toEqual([
        { id, port: 3000, auth: { mode: 'entra', emails: ['ewi@projectum.com'] } },
      ]);
    });

    it('exposes anonymously only when explicitly requested', async () => {
      const client = new FakeSandboxApiClient();
      const mgr = new SandboxContainerManager(client, logger);
      const id = await mgr.spawn(baseConfig);

      await mgr.exposePort(id, 8080, { anonymous: true });

      expect(client.addPortCalls[0]?.auth).toEqual({ mode: 'anonymous' });
    });

    it('unexposePort delegates to the client', async () => {
      const client = new FakeSandboxApiClient();
      const mgr = new SandboxContainerManager(client, logger);
      const id = await mgr.spawn(baseConfig);

      await mgr.unexposePort(id, 3000);

      expect(client.removePortCalls).toEqual([{ id, port: 3000 }]);
    });
  });

  describe('extractDirectoryFromContainer', () => {
    it('mirrors a sandbox directory back to the host through list/read', async () => {
      const hostDir = mkdtempSync(join(tmpdir(), 'sandbox-extract-'));
      const client = new FakeSandboxApiClient();
      const mgr = new SandboxContainerManager(client, logger);
      const id = await mgr.spawn(baseConfig);

      try {
        writeFileSync(join(hostDir, 'stale.txt'), 'delete me');
        mkdirSync(join(hostDir, 'node_modules'));
        writeFileSync(join(hostDir, 'node_modules', 'local-cache.txt'), 'keep excluded');

        client.seedFile(id, '/mnt/worktree/README.md', Buffer.from('hello'));
        client.seedFile(id, '/mnt/worktree/src/index.ts', Buffer.from('console.log("hi");'));
        client.seedFile(id, '/mnt/worktree/node_modules/left-pad.js', Buffer.from('skip'));

        await mgr.extractDirectoryFromContainer(id, '/mnt/worktree', hostDir, ['node_modules']);

        expect(readFileSync(join(hostDir, 'README.md'), 'utf-8')).toBe('hello');
        expect(readFileSync(join(hostDir, 'src', 'index.ts'), 'utf-8')).toBe('console.log("hi");');
        expect(existsSync(join(hostDir, 'stale.txt'))).toBe(false);
        expect(existsSync(join(hostDir, 'node_modules', 'left-pad.js'))).toBe(false);
        expect(readFileSync(join(hostDir, 'node_modules', 'local-cache.txt'), 'utf-8')).toBe(
          'keep excluded',
        );
      } finally {
        rmSync(hostDir, { recursive: true, force: true });
      }
    });

    it('round-trips runtime state through extract and next spawn', async () => {
      const hostDir = mkdtempSync(join(tmpdir(), 'sandbox-runtime-state-'));
      const client = new FakeSandboxApiClient();
      const mgr = new SandboxContainerManager(client, logger);
      const firstId = await mgr.spawn(baseConfig);
      const containerPath = '/home/autopod/.codex/sessions';
      const rolloutPath = `${containerPath}/2026/07/12/rollout-thread-123.jsonl`;

      try {
        client.seedFile(firstId, rolloutPath, Buffer.from('{"type":"session_meta"}\n'));

        await mgr.extractDirectoryFromContainer(firstId, containerPath, hostDir);
        const secondId = await mgr.spawn({
          ...baseConfig,
          volumes: [{ host: hostDir, container: containerPath }],
        });

        expect(client.sandboxes.get(secondId)?.files.get(rolloutPath)?.toString('utf-8')).toBe(
          '{"type":"session_meta"}\n',
        );
      } finally {
        rmSync(hostDir, { recursive: true, force: true });
      }
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

function normalizeSandboxPath(pathname: string): string {
  const normalized = pathname.split('/').filter(Boolean).join('/');
  return normalized ? `/${normalized}` : '/';
}

function relativeSandboxPath(parent: string, child: string): string {
  const relative = posix.relative(normalizeSandboxPath(parent), normalizeSandboxPath(child));
  return relative && !relative.startsWith('..') ? relative : '';
}
