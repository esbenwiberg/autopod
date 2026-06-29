import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
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
  type SandboxRegistryCredentials,
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
  /** User-assigned managed identity used by the sandbox group to pull private ACR images. */
  imagePullIdentityResourceId?: string;
  /** Transient registry credentials used for disk-image creation. Prefer managed identity. */
  registryCredentials?: SandboxRegistryCredentials;
  /** Resolve mutable image tags to their current manifest digest for persistent disk-image keys. */
  resolveImageDigest?: (image: string) => Promise<string | undefined>;
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
 *   - `extractDirectoryFromContainer` → list/read recursively into the same
 *     staging-and-mirror sync-back strategy as Docker
 *   - `execStreaming` → native streaming when the client exposes it; otherwise
 *     rejected because buffered exec breaks long-running agent runtime semantics
 *
 * The Azure adapter uses the preview data-plane shape confirmed by
 * `spikes/aca-sandbox/probe.py`: buffered exec, file read/write, host-rule egress,
 * directory list/read extraction, and stop/resume lifecycle.
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
        imagePullIdentityResourceId: config.imagePullIdentityResourceId,
        registryCredentials: config.registryCredentials,
        resolveImageDigest: config.resolveImageDigest,
      },
      logger,
    );
    return new SandboxContainerManager(client, logger, { defaultTier: config.tier ?? 'L' });
  }

  async spawn(config: ContainerSpawnConfig): Promise<string> {
    assertRegistryQualifiedImage(config.image);

    const tier = pickSandboxTier(config.memoryBytes, this.defaultTier);
    const egressPolicy = egressPolicyForMode(config.networkPolicyMode, config.allowedHosts ?? []);

    const sandboxId = await this.client.createSandbox({
      image: config.image,
      tier,
      egressPolicy,
      env: config.env,
    });
    this.egressPolicies.set(sandboxId, egressPolicy);

    try {
      if (config.volumes?.length) {
        await this.uploadVolumes(sandboxId, config.volumes);
      }
    } catch (err) {
      await this.kill(sandboxId).catch((deleteErr) => {
        this.logger.warn({ err: deleteErr, sandboxId }, 'Failed to clean up sandbox after upload');
      });
      throw err;
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
    containerId: string,
    containerPath: string,
    hostPath: string,
    excludes?: string[],
  ): Promise<void> {
    mkdirSync(hostPath, { recursive: true });
    removeStaleSyncStagingDirs(hostPath);

    const rootPath = normalizeSandboxPath(containerPath);
    const stagingBase = `.autopod-extract-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const stagingPath = join(hostPath, stagingBase);
    mkdirSync(stagingPath, { recursive: true });

    try {
      await this.extractSandboxPath(containerId, rootPath, rootPath, stagingPath, excludes);
      mirrorStagedDirectory(stagingPath, hostPath, excludes, stagingBase);
    } finally {
      rmSync(stagingPath, { recursive: true, force: true });
    }
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
    throw new Error(
      'Sandbox streaming exec is not supported by the Azure Sandboxes data plane yet. Buffered exec is available for short commands, but agent runtimes and terminals require native streaming/TTY support.',
    );
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

  private async uploadVolumes(
    sandboxId: string,
    volumes: NonNullable<ContainerSpawnConfig['volumes']>,
  ): Promise<void> {
    const createdDirs = new Set<string>();
    for (const volume of volumes) {
      if (!existsSync(volume.host)) {
        this.logger.debug(
          { sandboxId, hostPath: volume.host, containerPath: volume.container },
          'Skipping missing sandbox volume source',
        );
        continue;
      }
      await this.uploadPath(sandboxId, volume.host, volume.container, createdDirs);
    }
  }

  private async uploadPath(
    sandboxId: string,
    hostPath: string,
    containerPath: string,
    createdDirs: Set<string>,
  ): Promise<void> {
    const stat = lstatSync(hostPath);
    if (stat.isDirectory()) {
      await this.ensureSandboxDirectory(sandboxId, containerPath, createdDirs);
      for (const entry of readdirSync(hostPath)) {
        if (shouldSkipUploadedVolumeEntry(entry)) continue;
        await this.uploadPath(
          sandboxId,
          join(hostPath, entry),
          `${containerPath}/${entry}`,
          createdDirs,
        );
      }
      return;
    }
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(hostPath);
      await this.ensureSandboxDirectory(sandboxId, posix.dirname(containerPath), createdDirs);
      await this.client.writeFile(sandboxId, containerPath, Buffer.from(target, 'utf-8'));
      return;
    }
    if (stat.isFile()) {
      await this.ensureSandboxDirectory(sandboxId, posix.dirname(containerPath), createdDirs);
      await this.client.writeFile(sandboxId, containerPath, await readFile(hostPath));
    }
  }

  private async ensureSandboxDirectory(
    sandboxId: string,
    path: string,
    createdDirs: Set<string>,
  ): Promise<void> {
    if (!this.client.mkdir) return;

    const normalized = normalizeSandboxPath(path);
    if (normalized === '/' || createdDirs.has(normalized)) return;

    await this.ensureSandboxDirectory(sandboxId, posix.dirname(normalized), createdDirs);
    await this.client.mkdir(sandboxId, normalized);
    createdDirs.add(normalized);
  }

  private async extractSandboxPath(
    sandboxId: string,
    rootPath: string,
    currentPath: string,
    stagingPath: string,
    excludes?: string[],
  ): Promise<void> {
    const listing = await this.client.listFiles(sandboxId, currentPath);

    for (const entry of listing.entries) {
      const entryPath = normalizeSandboxPath(entry.path || posix.join(currentPath, entry.name));
      const relPath = normalizeExtractPath(posix.relative(rootPath, entryPath));
      if (!relPath || isExcludedPath(relPath, excludes)) continue;

      const target = join(stagingPath, ...relPath.split('/'));
      if (entry.isDirectory) {
        mkdirSync(target, { recursive: true });
        await this.extractSandboxPath(sandboxId, rootPath, entryPath, stagingPath, excludes);
        continue;
      }

      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, await this.client.readFile(sandboxId, entryPath));
    }
  }
}

function assertRegistryQualifiedImage(image: string): void {
  if (isRegistryQualifiedImage(image)) return;
  throw new Error(
    `Sandbox execution requires a registry-qualified OCI image, got "${image}". Build and push a warm image to ACR, then store the ACR tag in profile.warmImageTag.`,
  );
}

function isRegistryQualifiedImage(image: string): boolean {
  const [firstComponent = ''] = image.split('/');
  return image.includes('/') && (firstComponent.includes('.') || firstComponent.includes(':'));
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

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function normalizeExtractPath(pathname: string): string {
  return pathname.split('/').filter(Boolean).join('/');
}

function normalizeSandboxPath(pathname: string): string {
  const normalized = pathname.split('/').filter(Boolean).join('/');
  return normalized ? `/${normalized}` : '/';
}

function isExcludedPath(relPath: string, excludes?: string[]): boolean {
  if (!excludes?.length) return false;
  const normalizedRel = normalizeExtractPath(relPath);
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

function removeStaleSyncStagingDirs(hostPath: string): void {
  for (const entry of readdirSync(hostPath)) {
    if (entry.startsWith('.autopod-sync-') || entry.startsWith('.autopod-extract-')) {
      rmSync(join(hostPath, entry), { recursive: true, force: true });
    }
  }
}

function collectRelativeEntries(
  root: string,
  excludes?: string[],
  skipTopLevel?: string,
): string[] {
  const entries: string[] = [];

  function walk(relativeDir: string): void {
    const absoluteDir = relativeDir ? join(root, relativeDir) : root;
    for (const dirent of readdirSync(absoluteDir, { withFileTypes: true })) {
      const relPath = relativeDir ? `${relativeDir}/${dirent.name}` : dirent.name;
      const topLevel = relPath.split('/')[0];
      if (topLevel === skipTopLevel || isExcludedPath(relPath, excludes)) {
        continue;
      }
      entries.push(relPath);
      if (dirent.isDirectory() && !dirent.isSymbolicLink()) {
        walk(relPath);
      }
    }
  }

  walk('');
  return entries;
}

function mirrorStagedDirectory(
  stagingPath: string,
  hostPath: string,
  excludes?: string[],
  stagingBase?: string,
): void {
  for (const entry of readdirSync(stagingPath)) {
    cpSync(join(stagingPath, entry), join(hostPath, entry), {
      recursive: true,
      force: true,
      errorOnExist: false,
      dereference: false,
      verbatimSymlinks: true,
      preserveTimestamps: true,
    });
  }

  const hostEntries = collectRelativeEntries(hostPath, excludes, stagingBase).sort(
    (a, b) => b.length - a.length,
  );
  for (const relPath of hostEntries) {
    if (!pathExists(join(stagingPath, relPath))) {
      rmSync(join(hostPath, relPath), { recursive: true, force: true });
    }
  }
}
