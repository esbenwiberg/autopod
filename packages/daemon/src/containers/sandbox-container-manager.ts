import { existsSync, lstatSync, readdirSync, readlinkSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { Logger } from 'pino';
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

export interface SandboxContainerManagerOptions {
  /** Tier used when a spawn carries no `memoryBytes` hint (default: 'L'). */
  defaultTier?: SandboxResourceTier;
}

export interface SandboxContainerManagerConfig {
  /** Azure subscription ID. */
  subscriptionId: string;
  /** Resource group hosting the SandboxGroup (Microsoft.App/SandboxGroups). */
  resourceGroup: string;
  /** Azure region for sandbox placement (e.g. "swedencentral"). */
  location: string;
  /** Sandbox group name. Defaults to `autopod-spike` for the prototype. */
  sandboxGroup?: string;
  /** Skip ARM group read/create; use when the group is managed out-of-band. */
  assumeGroupExists?: boolean;
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
 *   - host bind mounts → best-effort upload at spawn (Sandboxes have no bind mounts)
 *   - `extractDirectoryFromContainer` → explicit unsupported error until a durable
 *     sync-back strategy exists
 *   - `execStreaming` → native streaming when the client exposes it, else a
 *     buffered `exec()` surfaced through one-shot streams
 *
 * The Azure adapter uses the preview data-plane shape confirmed by
 * `spikes/aca-sandbox/probe.py`: buffered exec, file read/write, host-rule egress,
 * and stop/resume lifecycle. Directory extraction stays intentionally unsupported
 * until a durable sync-back strategy exists.
 */
export class SandboxContainerManager implements ContainerManager {
  private readonly client: SandboxApiClient;
  private readonly logger: Logger;
  private readonly defaultTier: SandboxResourceTier;
  private readonly egressPolicies = new Map<string, ReturnType<typeof egressPolicyForMode>>();

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
   * Build a manager backed by the Azure adapter — the wiring entry point
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
        sandboxGroup: config.sandboxGroup,
        assumeGroupExists: config.assumeGroupExists,
      },
      logger,
    );
    return new SandboxContainerManager(client, logger, { defaultTier: config.tier ?? 'L' });
  }

  async spawn(config: ContainerSpawnConfig): Promise<string> {
    const tier = pickSandboxTier(config.memoryBytes, this.defaultTier);
    const egressPolicy = egressPolicyForMode(config.networkPolicyMode, config.allowedHosts ?? []);

    const sandboxId = await this.client.createSandbox({
      image: config.image,
      tier,
      egressPolicy,
      env: config.env,
    });
    this.egressPolicies.set(sandboxId, egressPolicy);

    if (config.volumes?.length) {
      await this.uploadVolumes(sandboxId, config.volumes);
    }

    this.logger.info(
      {
        podId: config.podId,
        sandboxId,
        tier,
        networkPolicyMode: config.networkPolicyMode ?? 'allow-all',
        egressDefault: egressPolicy.defaultAction,
        egressRules: egressPolicy.hostRules.length,
      },
      'Sandbox spawned',
    );
    return sandboxId;
  }

  async kill(containerId: string): Promise<void> {
    await this.client.destroy(containerId);
    this.egressPolicies.delete(containerId);
  }

  async refreshFirewall(containerId: string, script: string): Promise<void> {
    const policy = parseSandboxEgressRefresh(script) ?? this.egressPolicies.get(containerId);
    if (!policy) {
      throw new Error(
        `No sandbox egress policy available for ${containerId}; pass a sandbox egress refresh payload`,
      );
    }
    await this.client.updateEgress(containerId, policy);
    this.egressPolicies.set(containerId, policy);
    this.logger.debug(
      {
        sandboxId: containerId,
        defaultAction: policy.defaultAction,
        rules: policy.hostRules.length,
      },
      'Sandbox egress policy refreshed',
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

  async extractDirectoryFromContainer(
    _containerId: string,
    containerPath: string,
    _hostPath: string,
    _excludes?: string[],
  ): Promise<void> {
    throw new Error(
      `extractDirectoryFromContainer is unsupported for Azure Container Apps Sandboxes (${containerPath}). Use Docker/local until sandbox sync-back is implemented.`,
    );
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

  private async uploadVolumes(
    sandboxId: string,
    volumes: NonNullable<ContainerSpawnConfig['volumes']>,
  ): Promise<void> {
    for (const volume of volumes) {
      if (!existsSync(volume.host)) {
        this.logger.debug(
          { sandboxId, hostPath: volume.host, containerPath: volume.container },
          'Skipping missing sandbox volume source',
        );
        continue;
      }
      await this.uploadPath(sandboxId, volume.host, volume.container);
    }
  }

  private async uploadPath(
    sandboxId: string,
    hostPath: string,
    containerPath: string,
  ): Promise<void> {
    const stat = lstatSync(hostPath);
    if (stat.isDirectory()) {
      if (this.client.mkdir) {
        await this.client.mkdir(sandboxId, containerPath);
      }
      for (const entry of readdirSync(hostPath)) {
        if (shouldSkipUploadedVolumeEntry(entry)) continue;
        await this.uploadPath(sandboxId, join(hostPath, entry), `${containerPath}/${entry}`);
      }
      return;
    }
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(hostPath);
      await this.client.writeFile(sandboxId, containerPath, Buffer.from(target, 'utf-8'));
      return;
    }
    if (stat.isFile()) {
      await this.client.writeFile(sandboxId, containerPath, await readFile(hostPath));
    }
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

export function sandboxEgressRefreshPayload(
  mode: ContainerSpawnConfig['networkPolicyMode'],
  allowedHosts: string[] = [],
): string {
  return JSON.stringify({ sandboxEgressPolicy: egressPolicyForMode(mode, allowedHosts) });
}

function parseSandboxEgressRefresh(script: string): ReturnType<typeof egressPolicyForMode> | null {
  try {
    const parsed = JSON.parse(script) as { sandboxEgressPolicy?: unknown };
    const policy = parsed.sandboxEgressPolicy as ReturnType<typeof egressPolicyForMode> | undefined;
    if (
      policy &&
      (policy.defaultAction === 'Allow' || policy.defaultAction === 'Deny') &&
      Array.isArray(policy.hostRules)
    ) {
      return policy;
    }
  } catch {
    // Docker firewall scripts are not JSON; fall back to the last known policy.
  }
  return null;
}

function shouldSkipUploadedVolumeEntry(entry: string): boolean {
  return (
    entry === 'node_modules' ||
    entry.startsWith('.autopod-sync-') ||
    entry.startsWith('.autopod-extract-')
  );
}
