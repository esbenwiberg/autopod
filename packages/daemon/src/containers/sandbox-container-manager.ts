import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import type { Logger } from 'pino';
import * as tar from 'tar-stream';
import type {
  ContainerManager,
  ContainerSpawnConfig,
  ExecOptions,
  ExecResult,
  StreamingExecResult,
} from '../interfaces/container-manager.js';
import { AzureSandboxApiClient } from './azure-sandbox-api-client.js';
import {
  type SandboxApiClient,
  type SandboxExecOptions,
  type SandboxResourceTier,
  egressPolicyForMode,
  pickSandboxTier,
} from './sandbox-api-client.js';

/** Temp path inside the sandbox used to stage a tarball for directory extraction. */
export const EXTRACT_TAR_PATH = '/tmp/.autopod-sandbox-extract.tar.gz';

export interface SandboxContainerManagerOptions {
  /** Tier used when a spawn carries no `memoryBytes` hint (default: 'L'). */
  defaultTier?: SandboxResourceTier;
}

export interface SandboxContainerManagerConfig {
  /** Azure subscription ID. */
  subscriptionId: string;
  /** Resource group hosting the SandboxGroup (Microsoft.App/SandboxGroups). */
  resourceGroup: string;
  /** Azure region for sandbox placement (e.g. "westeurope"). */
  location: string;
  /** Resource tier per sandbox (default: 'L' — the largest preview tier). */
  tier?: SandboxResourceTier;
}

/**
 * Azure Container Apps **Sandboxes** container manager — the replacement for the
 * removed ACI backend (`executionTarget: 'sandbox'`).
 *
 * All the mapping logic between the `ContainerManager` contract and the
 * Sandboxes data-plane lives here and is fully unit-testable against a fake
 * {@link SandboxApiClient}:
 *   - `ContainerSpawnConfig` → create args (image, tier from `memoryBytes`,
 *     initial egress policy from `networkPolicyMode` + `allowedHosts`)
 *   - `stop()`/`start()` → snapshot suspend/resume
 *   - `extractDirectoryFromContainer` → tar-in-sandbox + download + host untar
 *     (something ACI could not do)
 *   - `execStreaming` → native streaming when the client exposes it, else a
 *     buffered `exec()` surfaced through one-shot streams
 *
 * The single unconfirmed surface is the injected client. {@link AzureSandboxApiClient}
 * is a stub that throws `NOT_IMPLEMENTED` until the preview SDK is confirmed via
 * `spikes/aca-sandbox/probe.py`; wire a real client in and this manager is live.
 */
export class SandboxContainerManager implements ContainerManager {
  private readonly client: SandboxApiClient;
  private readonly logger: Logger;
  private readonly defaultTier: SandboxResourceTier;

  constructor(
    client: SandboxApiClient,
    logger: Logger,
    options: SandboxContainerManagerOptions = {},
  ) {
    this.client = client;
    this.logger = logger;
    this.defaultTier = options.defaultTier ?? 'L';
  }

  /**
   * Build a manager backed by the (stub) Azure adapter — the wiring entry point
   * used by the daemon. Equivalent to
   * `new SandboxContainerManager(new AzureSandboxApiClient(config, logger), logger, ...)`.
   */
  static withAzureClient(
    config: SandboxContainerManagerConfig,
    logger: Logger,
  ): SandboxContainerManager {
    const client = new AzureSandboxApiClient(
      {
        subscriptionId: config.subscriptionId,
        resourceGroup: config.resourceGroup,
        location: config.location,
      },
      logger,
    );
    return new SandboxContainerManager(client, logger, { defaultTier: config.tier ?? 'L' });
  }

  async spawn(config: ContainerSpawnConfig): Promise<string> {
    if (config.volumes?.length) {
      // Sandboxes have no host bind mounts; worktree files are pushed in via
      // writeFile and pulled back out via extractDirectoryFromContainer.
      this.logger.debug(
        { podId: config.podId, volumes: config.volumes.length },
        'Sandbox spawn ignores host volume mounts (no bind mounts in Sandboxes)',
      );
    }

    const tier = pickSandboxTier(config.memoryBytes, this.defaultTier);
    const egressPolicy = egressPolicyForMode(config.networkPolicyMode, config.allowedHosts ?? []);

    const sandboxId = await this.client.createSandbox({
      image: config.image,
      tier,
      egressPolicy,
      env: config.env,
    });

    this.logger.info(
      {
        podId: config.podId,
        sandboxId,
        tier,
        networkPolicyMode: config.networkPolicyMode ?? 'allow-all',
        egressDefault: egressPolicy.defaultAction,
        egressRules: egressPolicy.rules.length,
      },
      'Sandbox spawned',
    );
    return sandboxId;
  }

  async kill(containerId: string): Promise<void> {
    await this.client.destroy(containerId);
  }

  /**
   * The Sandboxes egress policy is set at spawn from `networkPolicyMode` +
   * `allowedHosts`; it does not consume an iptables/HAProxy script the way the
   * Docker backend does. There is no SNI-proxy to live-refresh, so this is a
   * no-op. A typed runtime egress-update path (host add/remove via
   * `SandboxApiClient.updateEgress`) is a follow-up once the data-plane is wired.
   */
  async refreshFirewall(containerId: string, _script: string): Promise<void> {
    this.logger.debug(
      { sandboxId: containerId },
      'refreshFirewall is a no-op for the sandbox backend (egress applied at spawn)',
    );
  }

  async stop(containerId: string): Promise<void> {
    await this.client.suspend(containerId, 'memory');
  }

  async start(containerId: string): Promise<void> {
    await this.client.resume(containerId);
  }

  async writeFile(containerId: string, path: string, content: string | Buffer): Promise<void> {
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
    await this.client.writeFile(containerId, path, buf);
  }

  async readFile(containerId: string, path: string): Promise<string> {
    const buf = await this.client.readFile(containerId, path);
    return buf.toString('utf-8');
  }

  async readFileBinary(containerId: string, path: string): Promise<Buffer> {
    return this.client.readFile(containerId, path);
  }

  /**
   * Tar the directory inside the sandbox, download the tarball, and extract it to
   * `hostPath` honouring `excludes`. `hostPath` is created if missing and its
   * existing (non-excluded) contents are cleared first, matching the Docker
   * backend's contract.
   */
  async extractDirectoryFromContainer(
    containerId: string,
    containerPath: string,
    hostPath: string,
    excludes?: string[],
  ): Promise<void> {
    const quoted = shellSingleQuote(containerPath);
    const result = await this.client.exec(containerId, [
      'sh',
      '-c',
      `tar czf ${shellSingleQuote(EXTRACT_TAR_PATH)} -C ${quoted} .`,
    ]);
    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to tar ${containerPath} in sandbox ${containerId} (exit ${result.exitCode}): ${result.stderr.trim()}`,
      );
    }

    const tarball = await this.client.readFile(containerId, EXTRACT_TAR_PATH);
    mkdirSync(hostPath, { recursive: true });
    clearDirectory(hostPath, excludes);
    await extractTarballToHost(gunzipSync(tarball), hostPath, excludes, this.logger);
  }

  async getStatus(containerId: string): Promise<'running' | 'stopped' | 'unknown'> {
    try {
      return await this.client.getStatus(containerId);
    } catch (err) {
      this.logger.debug({ err, sandboxId: containerId }, 'Sandbox getStatus failed — unknown');
      return 'unknown';
    }
  }

  async execInContainer(
    containerId: string,
    command: string[],
    options?: ExecOptions,
  ): Promise<ExecResult> {
    const result = await this.client.exec(containerId, command, toSandboxExecOptions(options));
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
  }

  async execStreaming(
    containerId: string,
    command: string[],
    options?: ExecOptions,
  ): Promise<StreamingExecResult> {
    const sandboxOptions = toSandboxExecOptions(options);

    if (this.client.execStream) {
      return this.streamNative(containerId, command, sandboxOptions);
    }
    return this.streamBuffered(containerId, command, sandboxOptions);
  }

  /** Native streaming path — pipe SDK chunks into stdout/stderr streams. */
  private streamNative(
    containerId: string,
    command: string[],
    options: SandboxExecOptions,
  ): StreamingExecResult {
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    let cancelled = false;

    const exitCode = (async () => {
      let code = 0;
      try {
        // biome-ignore lint/style/noNonNullAssertion: guarded by caller (execStream defined)
        for await (const chunk of this.client.execStream!(containerId, command, options)) {
          if (cancelled) break;
          if (chunk.stdout) stdout.push(chunk.stdout);
          if (chunk.stderr) stderr.push(chunk.stderr);
          if (chunk.exitCode != null) code = chunk.exitCode;
        }
      } catch (err) {
        stderr.push(String(err instanceof Error ? err.message : err));
        code = 1;
      } finally {
        stdout.push(null);
        stderr.push(null);
      }
      return code;
    })();

    return {
      stdout,
      stderr,
      exitCode,
      kill: async () => {
        cancelled = true;
      },
    };
  }

  /** Buffered fallback — run exec() and surface the whole output through one-shot streams. */
  private streamBuffered(
    containerId: string,
    command: string[],
    options: SandboxExecOptions,
  ): StreamingExecResult {
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });

    const exitCode = (async () => {
      try {
        const result = await this.client.exec(containerId, command, options);
        if (result.stdout) stdout.push(result.stdout);
        if (result.stderr) stderr.push(result.stderr);
        return result.exitCode;
      } catch (err) {
        stderr.push(String(err instanceof Error ? err.message : err));
        return 1;
      } finally {
        stdout.push(null);
        stderr.push(null);
      }
    })();

    return {
      stdout,
      stderr,
      exitCode,
      // Buffered exec cannot be interrupted mid-flight; the promise still resolves.
      kill: async () => {},
    };
  }
}

function toSandboxExecOptions(options?: ExecOptions): SandboxExecOptions | undefined {
  if (!options) return undefined;
  return {
    cwd: options.cwd,
    timeoutMs: options.timeout,
    user: options.user,
    env: options.env,
  };
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------------------
// Host-side tar extraction + exclude filtering. Mirrors the Docker backend's
// `isExcludedPath` semantics: a bare exclude (no slash) matches any path
// segment; an exclude with a slash matches that relative path and its
// descendants.
// ---------------------------------------------------------------------------

function normalizeExtractPath(pathname: string): string {
  return pathname.replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
}

export function isExcludedPath(relPath: string, excludes?: string[]): boolean {
  if (!excludes?.length) return false;
  const normalizedRel = normalizeExtractPath(relPath);
  if (!normalizedRel) return false;
  const segments = normalizedRel.split('/');
  return excludes.some((exclude) => {
    const normalizedExclude = normalizeExtractPath(exclude);
    if (!normalizedExclude) return false;
    if (!normalizedExclude.includes('/')) {
      return segments.includes(normalizedExclude);
    }
    return normalizedRel === normalizedExclude || normalizedRel.startsWith(`${normalizedExclude}/`);
  });
}

/** Remove the existing (non-excluded) contents of `hostPath`. */
function clearDirectory(hostPath: string, excludes?: string[]): void {
  for (const entry of readdirSync(hostPath)) {
    if (isExcludedPath(entry, excludes)) continue;
    rmSync(join(hostPath, entry), { recursive: true, force: true });
  }
}

function extractTarballToHost(
  tarball: Buffer,
  hostPath: string,
  excludes: string[] | undefined,
  logger: Logger,
): Promise<void> {
  const extract = tar.extract();
  const pendingHardlinks: Array<{ fullPath: string; targetPath: string }> = [];

  return new Promise<void>((resolve, reject) => {
    extract.on('entry', (header, stream, next) => {
      const rel = normalizeExtractPath(header.name);
      if (!rel || isExcludedPath(rel, excludes)) {
        stream.resume();
        stream.on('end', next);
        return;
      }

      const fullPath = join(hostPath, rel);

      if (header.type === 'directory') {
        mkdirSync(fullPath, { recursive: true });
        stream.resume();
        stream.on('end', next);
      } else if (header.type === 'symlink') {
        mkdirSync(dirname(fullPath), { recursive: true });
        try {
          symlinkSync(header.linkname ?? '', fullPath);
        } catch (err) {
          logger.debug({ err, fullPath }, 'Skipping unextractable symlink');
        }
        stream.resume();
        stream.on('end', next);
      } else if (header.type === 'link') {
        const targetRel = normalizeExtractPath(header.linkname ?? '');
        pendingHardlinks.push({ fullPath, targetPath: join(hostPath, targetRel) });
        stream.resume();
        stream.on('end', next);
      } else {
        mkdirSync(dirname(fullPath), { recursive: true });
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () => {
          try {
            writeFileSync(fullPath, Buffer.concat(chunks));
            next();
          } catch (err) {
            reject(err);
          }
        });
        stream.on('error', reject);
      }
    });

    extract.on('finish', () => {
      for (const { fullPath, targetPath } of pendingHardlinks) {
        if (!existsSync(targetPath)) {
          logger.warn({ fullPath, targetPath }, 'Skipping archive hardlink with missing target');
          continue;
        }
        try {
          symlinkSync(targetPath, fullPath);
        } catch (err) {
          logger.debug({ err, fullPath }, 'Skipping unextractable hardlink');
        }
      }
      resolve();
    });

    extract.on('error', reject);
    // Wrap in an array so the whole buffer is emitted as a single chunk rather
    // than Readable.from iterating it byte-by-byte.
    Readable.from([tarball]).pipe(extract);
  });
}
