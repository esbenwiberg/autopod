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
import { Readable, Writable } from 'node:stream';
import { createGzip } from 'node:zlib';
import type { Logger } from 'pino';
import { type Headers as TarHeaders, type Pack as TarPack, pack as tarPack } from 'tar-stream';
import type {
  ContainerManager,
  ContainerSpawnConfig,
  ExecOptions,
  ExecResult,
  ExposePortOptions,
  ExposedPort,
  StreamingExecResult,
  TerminalSession,
  TerminalSessionOptions,
} from '../interfaces/container-manager.js';
import { AzureSandboxApiClient } from './azure-sandbox-api-client.js';
import type { SandboxPortAuth } from './sandbox-api-client.js';
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
  /** Test seam for exercising multi-part archive uploads. */
  volumeUploadChunkBytes?: number;
}

const SANDBOX_VOLUME_EXTRACT_TIMEOUT_MS = 5 * 60 * 1000;
const SANDBOX_VOLUME_UPLOAD_CHUNK_BYTES = 64 * 1024 * 1024;
const SANDBOX_ARCHIVE_UID = 1000;
const SANDBOX_ARCHIVE_GID = 1000;

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
 * directory list/read extraction, and stop/resume lifecycle — plus WebSocket
 * streaming exec (`/exec/stream`), confirmed from the JS reference SDK and
 * documented in `docs/azure-container-apps-sandboxes.md`.
 */
export class SandboxContainerManager implements ContainerManager {
  private readonly client: SandboxApiClient;
  private readonly logger: Logger;
  private readonly defaultTier: SandboxResourceTier;
  private readonly volumeUploadChunkBytes: number;
  private readonly egressPolicies = new Map<string, ReturnType<typeof egressPolicyForMode>>();

  constructor(
    client: SandboxApiClient,
    logger: Logger,
    options: SandboxContainerManagerOptions = {},
  ) {
    this.client = client;
    this.logger = logger;
    this.defaultTier = options.defaultTier ?? 'L';
    this.volumeUploadChunkBytes = Math.max(
      1,
      options.volumeUploadChunkBytes ?? SANDBOX_VOLUME_UPLOAD_CHUNK_BYTES,
    );
  }

  get supportsStreamingExec(): boolean {
    return typeof this.client.execStream === 'function';
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
        config.onProgress?.('Uploading workspace to sandbox…');
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

  async attachTerminal(
    containerId: string,
    options: TerminalSessionOptions,
  ): Promise<TerminalSession> {
    if (!this.client.attachTerminal) {
      throw new Error(
        'Sandbox interactive terminal is not supported by this data-plane client (no exec-stream TTY support).',
      );
    }
    // The platform auto-suspends idle sandboxes (memory snapshot after ~15 min),
    // which a human workspace session will routinely hit. resume() is idempotent —
    // it early-returns when the sandbox is already Running.
    await this.client.resume(containerId);
    // Mirror the Docker terminal: cd into the workspace, then prefer a persistent
    // tmux session ("new-session -A -s main" creates or reattaches, so WebSocket
    // reconnects resume where the user left off) and fall back to a login bash.
    // The `\;` stays literal in the wrapper script so tmux (not the shell) parses
    // it as its command separator. The one-liner is staged as an executable
    // wrapper because the exec-stream `command` is `execve`d literally.
    const shellCommand =
      'cd /workspace 2>/dev/null; ' +
      'command -v tmux >/dev/null 2>&1 && ' +
      'exec tmux new-session -A -s main \\; set -g mouse on || ' +
      'exec /bin/bash -l';
    return this.client.attachTerminal(containerId, {
      cols: options.cols,
      rows: options.rows,
      shellCommand,
      env: { COLUMNS: String(options.cols), LINES: String(options.rows) },
    });
  }

  async exposePort(
    containerId: string,
    port: number,
    options?: ExposePortOptions,
  ): Promise<ExposedPort> {
    if (!this.client.addPort) {
      throw new Error('Sandbox port exposure is not supported by this data-plane client.');
    }
    let auth: SandboxPortAuth | undefined;
    if (options?.anonymous) {
      auth = { mode: 'anonymous' };
    } else if (options?.entraEmails?.length) {
      auth = { mode: 'entra', emails: options.entraEmails };
    }
    const exposed = await this.client.addPort(containerId, port, auth);
    return { port: exposed.port, url: exposed.url };
  }

  async unexposePort(containerId: string, port: number): Promise<void> {
    if (!this.client.removePort) return;
    await this.client.removePort(containerId, port);
  }

  /** Native streaming path — pipe SDK chunks into stdout/stderr streams. */
  private streamNative(
    containerId: string,
    command: string[],
    options: SandboxExecOptions = {},
  ): StreamingExecResult {
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    let cancelled = false;
    let cancelRemote: (() => Promise<void>) | null = null;
    let resolveCancelReady: ((cancel: () => Promise<void>) => void) | null = null;
    const cancelReady = new Promise<() => Promise<void>>((resolve) => {
      resolveCancelReady = resolve;
    });
    let writeRemoteStdin: ((data: Buffer) => void) | null = null;
    const pendingStdin: Buffer[] = [];
    const stdin =
      options.stdin === true
        ? new Writable({
            write(chunk: Buffer | string, _encoding, callback) {
              const data = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk);
              if (writeRemoteStdin) {
                writeRemoteStdin(data);
              } else {
                pendingStdin.push(data);
              }
              callback();
            },
          })
        : undefined;
    const streamOptions: SandboxExecOptions = {
      ...options,
      onCancelReady: (cancel) => {
        cancelRemote = cancel;
        resolveCancelReady?.(cancel);
        resolveCancelReady = null;
      },
      onStdinWriter: stdin
        ? (write) => {
            writeRemoteStdin = write;
            while (pendingStdin.length > 0) {
              const data = pendingStdin.shift();
              if (data) write(data);
            }
          }
        : undefined,
    };

    const exitCode = (async () => {
      let code = 0;
      try {
        // biome-ignore lint/style/noNonNullAssertion: guarded by caller (execStream defined)
        for await (const chunk of this.client.execStream!(containerId, command, streamOptions)) {
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
      stdin,
      exitCode,
      kill: async () => {
        cancelled = true;
        stdin?.destroy();
        try {
          const cancel =
            cancelRemote ?? (await Promise.race([cancelReady, exitCode.then(() => null)]));
          if (cancel) await cancel();
        } finally {
          stdout.push(null);
          stderr.push(null);
        }
      },
    };
  }

  private async uploadVolumes(
    sandboxId: string,
    volumes: NonNullable<ContainerSpawnConfig['volumes']>,
  ): Promise<void> {
    for (const [index, volume] of volumes.entries()) {
      if (!existsSync(volume.host)) {
        this.logger.debug(
          { sandboxId, hostPath: volume.host, containerPath: volume.container },
          'Skipping missing sandbox volume source',
        );
        continue;
      }
      await this.uploadPath(sandboxId, volume.host, volume.container, index);
    }
  }

  private async uploadPath(
    sandboxId: string,
    hostPath: string,
    containerPath: string,
    volumeIndex: number,
  ): Promise<void> {
    const stat = lstatSync(hostPath);
    if (stat.isDirectory()) {
      const startedAt = Date.now();
      const archive = await createSandboxVolumeArchive(hostPath);
      const safeSandboxId = sandboxId.replace(/[^A-Za-z0-9_-]/g, '-');
      const archivePath = `/tmp/.autopod-volume-${safeSandboxId}-${volumeIndex}.tar.gz`;
      const archiveParts: string[] = [];

      for (
        let offset = 0, part = 0;
        offset < archive.content.byteLength;
        offset += this.volumeUploadChunkBytes, part++
      ) {
        const end = Math.min(offset + this.volumeUploadChunkBytes, archive.content.byteLength);
        const partPath =
          archive.content.byteLength <= this.volumeUploadChunkBytes
            ? archivePath
            : `${archivePath}.part-${part.toString().padStart(4, '0')}`;
        await this.client.writeFile(sandboxId, partPath, archive.content.subarray(offset, end));
        archiveParts.push(partPath);
      }

      const extraction = await this.client.exec(
        sandboxId,
        [
          'sh',
          '-c',
          [
            'destination=$1; archive=$2; shift 2',
            'mkdir -p -- "$destination" || exit $?',
            'if [ "$#" -eq 1 ] && [ "$1" = "$archive" ]; then source=$archive; else cat -- "$@" > "$archive" || exit $?; source=$archive; fi',
            'tar -xzf "$source" -C "$destination"; status=$?',
            'rm -f -- "$archive" "$@"',
            'exit $status',
          ].join('; '),
          'autopod-volume-extract',
          normalizeSandboxPath(containerPath),
          archivePath,
          ...archiveParts,
        ],
        { user: 'root', timeoutMs: SANDBOX_VOLUME_EXTRACT_TIMEOUT_MS },
      );
      if (extraction.exitCode !== 0) {
        throw new Error(
          `Sandbox volume extraction failed for ${containerPath} (exit ${extraction.exitCode}): ${(
            extraction.stderr || extraction.stdout
          ).slice(0, 500)}`,
        );
      }

      this.logger.info(
        {
          sandboxId,
          hostPath,
          containerPath,
          entries: archive.entries,
          archiveBytes: archive.content.byteLength,
          uploadRequests: archiveParts.length,
          durationMs: Date.now() - startedAt,
        },
        'Uploaded sandbox volume as bulk archive',
      );
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

interface SandboxVolumeArchive {
  content: Buffer;
  entries: number;
}

async function createSandboxVolumeArchive(rootPath: string): Promise<SandboxVolumeArchive> {
  const pack = tarPack();
  const gzip = createGzip({ level: 1 });
  const chunks: Buffer[] = [];
  let entries = 0;

  const compressed = new Promise<Buffer>((resolve, reject) => {
    pack.on('error', reject);
    gzip.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    gzip.on('end', () => resolve(Buffer.concat(chunks)));
    gzip.on('error', reject);
  });
  pack.pipe(gzip);

  async function addPath(hostPath: string, archivePath: string): Promise<void> {
    const stat = lstatSync(hostPath);
    const common: TarHeaders = {
      name: archivePath,
      mode: stat.mode & 0o777,
      uid: SANDBOX_ARCHIVE_UID,
      gid: SANDBOX_ARCHIVE_GID,
      mtime: stat.mtime,
    };

    if (stat.isDirectory()) {
      await addTarEntry(pack, { ...common, type: 'directory' });
      entries++;
      for (const entry of readdirSync(hostPath).sort()) {
        if (shouldSkipUploadedVolumeEntry(entry)) continue;
        await addPath(join(hostPath, entry), posix.join(archivePath, entry));
      }
      return;
    }

    if (stat.isSymbolicLink()) {
      await addTarEntry(pack, {
        ...common,
        type: 'symlink',
        linkname: readlinkSync(hostPath),
      });
      entries++;
      return;
    }

    if (stat.isFile()) {
      await addTarEntry(
        pack,
        { ...common, type: 'file', size: stat.size },
        await readFile(hostPath),
      );
      entries++;
    }
  }

  for (const entry of readdirSync(rootPath).sort()) {
    if (shouldSkipUploadedVolumeEntry(entry)) continue;
    await addPath(join(rootPath, entry), entry);
  }
  pack.finalize();

  return { content: await compressed, entries };
}

function addTarEntry(pack: TarPack, headers: TarHeaders, content?: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const callback = (err?: Error | null) => {
      if (err) reject(err);
      else resolve();
    };
    if (content === undefined) pack.entry(headers, callback);
    else pack.entry(headers, content, callback);
  });
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
    stdin: options.stdin,
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
