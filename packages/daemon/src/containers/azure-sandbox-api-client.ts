import { createHash } from 'node:crypto';
import { AutopodError } from '@autopod/shared';
import { DefaultAzureCredential } from '@azure/identity';
import type { Logger } from 'pino';
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
  SandboxRegistryCredentials,
  SandboxSnapshot,
  SandboxStatus,
  SandboxTerminalOptions,
  SandboxTerminalSession,
} from './sandbox-api-client.js';

const API_VERSION = '2026-02-01-preview';
const ARM_SCOPE = 'https://management.azure.com/.default';
const DATA_SCOPE = 'https://dynamicsessions.io/.default';
const ACR_TOKEN_SCOPE = 'https://containerregistry.azure.net/.default';
const ACR_DOCKER_USERNAME = '00000000-0000-0000-0000-000000000000';
const ACR_EXCHANGE_TIMEOUT_MS = 30_000;
const AZURE_TOKEN_TIMEOUT_MS = 30_000;
const CREATE_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
/** Max polls for a freshly-added port's public URL to surface on the sandbox. */
const PORT_URL_POLL_ATTEMPTS = 20;

interface AccessToken {
  token: string;
}

interface TokenCredentialLike {
  getToken(scopes: string | string[]): Promise<AccessToken | null>;
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
export type ImageDigestResolver = (image: string) => Promise<string | undefined>;

/**
 * Structural mirror of the WHATWG `WebSocket` (Node ≥22 global). The daemon's
 * tsconfig has no DOM lib, and tests need a seam, so we type only what we use.
 */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
}

export type WebSocketFactory = (url: string, headers: Record<string, string>) => WebSocketLike;

export interface AzureSandboxApiClientConfig {
  /** Azure subscription ID. */
  subscriptionId: string;
  /** Resource group hosting the SandboxGroup (Microsoft.App/SandboxGroups). */
  resourceGroup: string;
  /** Azure region for sandbox placement (e.g. "swedencentral"). */
  location: string;
  /** Sandbox group name. Defaults to `autopod-spike` for the prototype. */
  sandboxGroup?: string;
  /** Skip ARM group read/create; use when the identity has data-plane-only RBAC. */
  assumeGroupExists?: boolean;
  /** User-assigned managed identity used by the sandbox group to pull private ACR images. */
  imagePullIdentityResourceId?: string;
  /** Transient registry credentials used for disk-image creation. Prefer managed identity. */
  registryCredentials?: SandboxRegistryCredentials;
  /** Test seam. Defaults to DefaultAzureCredential. */
  credential?: TokenCredentialLike;
  /** Test seam. Defaults to global fetch. */
  fetch?: FetchLike;
  /** Test seam. Defaults to the global WebSocket constructor (Node ≥22). */
  webSocket?: WebSocketFactory;
  /** Resolve mutable image tags to their current manifest digest for persistent disk-image keys. */
  resolveImageDigest?: ImageDigestResolver;
  /** Test seam. Defaults to 3s to match the Python SDK poller. */
  pollIntervalMs?: number;
}

interface DiskImageResponse {
  id?: string;
  name?: string;
  labels?: Record<string, string>;
  properties?: {
    labels?: Record<string, string>;
    status?: { state?: string; message?: string };
  };
  status?: { state?: string; message?: string };
}

interface DiskImageListResponse {
  value?: DiskImageResponse[];
  items?: DiskImageResponse[];
  diskImages?: DiskImageResponse[];
}

interface DiskImageKey {
  name: string;
  sourceImageHash: string;
  sourceDigest: string;
  labels: Record<string, string>;
}

interface SandboxResponse {
  id?: string;
  state?: string;
  sourcesRef?: { diskImage?: { id?: string } };
  ports?: WireSandboxPort[];
}

interface ExecResponse {
  stdout?: string;
  output?: string;
  stderr?: string;
  exitCode?: number;
  exit_code?: number;
}

interface WireSandboxFileInfo {
  name?: string;
  path?: string;
  size?: number;
  isDirectory?: boolean;
  isDir?: boolean;
  modifiedAt?: string;
  modifiedTime?: number;
  mode?: string | number;
}

interface WireSandboxDirListing {
  path?: string;
  entries?: WireSandboxFileInfo[];
}

type WirePortAuth = { anonymous: true } | { entraId: { enabled: true; emails: string[] } };

interface WireSandboxPort {
  port?: number;
  hostPort?: number;
  protocol?: string;
  url?: string;
}

export class AzureSandboxApiClient implements SandboxApiClient {
  private readonly config: Required<
    Pick<
      AzureSandboxApiClientConfig,
      'subscriptionId' | 'resourceGroup' | 'location' | 'sandboxGroup' | 'assumeGroupExists'
    >
  > & {
    imagePullIdentityResourceId?: string;
    registryCredentials?: SandboxRegistryCredentials;
  };
  private readonly logger: Logger;
  private readonly credential: TokenCredentialLike;
  private readonly fetchFn: FetchLike;
  private readonly webSocketFactory: WebSocketFactory;
  private readonly resolveImageDigest?: ImageDigestResolver;
  private readonly pollIntervalMs: number;
  private readonly dataEndpoint: string;
  private groupReady: Promise<void> | null = null;
  /** Monotonic counter for unique per-exec streaming wrapper-script paths. */
  private execStreamSeq = 0;

  constructor(config: AzureSandboxApiClientConfig, logger: Logger) {
    this.config = {
      subscriptionId: config.subscriptionId,
      resourceGroup: config.resourceGroup,
      location: config.location,
      sandboxGroup: config.sandboxGroup ?? 'autopod-spike',
      assumeGroupExists: config.assumeGroupExists ?? false,
      imagePullIdentityResourceId: config.imagePullIdentityResourceId,
      registryCredentials: config.registryCredentials,
    };
    this.logger = logger.child({ component: 'azure-sandbox-api-client' });
    this.credential = config.credential ?? new DefaultAzureCredential();
    this.fetchFn = config.fetch ?? globalThis.fetch.bind(globalThis);
    this.webSocketFactory = config.webSocket ?? defaultWebSocketFactory;
    this.resolveImageDigest = config.resolveImageDigest;
    this.pollIntervalMs = config.pollIntervalMs ?? 3000;
    this.dataEndpoint = endpointForRegion(config.location);
    this.logger.info(
      {
        subscriptionId: this.config.subscriptionId,
        resourceGroup: this.config.resourceGroup,
        location: this.config.location,
        sandboxGroup: this.config.sandboxGroup,
        assumeGroupExists: this.config.assumeGroupExists,
        imagePullIdentityConfigured: Boolean(this.config.imagePullIdentityResourceId),
        registryCredentialsConfigured: Boolean(this.config.registryCredentials),
      },
      'Azure Sandbox API client configured',
    );
  }

  async createSandbox(options: CreateSandboxOptions): Promise<string> {
    await this.ensureSandboxGroup();
    const diskImage = await this.ensureDiskImage(options.image);
    const diskImageId = requiredId(diskImage, 'disk image');
    const sandbox = await this.createSandboxFromDiskImage(diskImageId, options);
    return requiredId(sandbox, 'sandbox');
  }

  async destroy(sandboxId: string): Promise<void> {
    await this.requestData('DELETE', `${this.sandboxPath(sandboxId)}`, {
      okStatuses: [200, 202, 204, 404],
    });
    await this.pollDeleted(() => this.getSandbox(sandboxId), `sandbox ${sandboxId}`);
  }

  async createSnapshot(sandboxId: string, name?: string): Promise<SandboxSnapshot> {
    const response = await this.requestData<SandboxResponse>(
      'POST',
      `${this.sandboxPath(sandboxId)}/snapshot`,
      {
        json: name ? { labels: { name } } : {},
        okStatuses: [200, 201, 202],
        timeoutMs: CREATE_REQUEST_TIMEOUT_MS,
      },
    );
    return { id: requiredId(response, 'snapshot') };
  }

  async createFromSnapshot(snapshotId: string): Promise<string> {
    await this.ensureSandboxGroup();
    this.logger.info({ snapshotId }, 'Creating Azure sandbox from snapshot');
    // Snapshot creates accept only `sourcesRef` — the data plane rejects
    // resources/lifecycle/environment/egress (the snapshot carries them).
    const initial = await this.requestData<SandboxResponse>(
      'PUT',
      `${this.groupPath()}/sandboxes`,
      {
        json: {
          sourcesRef: { snapshot: { id: snapshotId } },
          labels: { purpose: 'autopod-sandbox' },
        },
        timeoutMs: CREATE_REQUEST_TIMEOUT_MS,
      },
    );
    const id = requiredId(initial, 'sandbox');
    this.logger.info({ sandboxId: id, snapshotId }, 'Azure sandbox create-from-snapshot accepted');
    const running = await this.pollState(
      () => this.getSandbox(id),
      (sandbox) => sandbox.state === 'Running',
      `sandbox ${id}`,
      (sandbox) => sandbox.state === 'Failed' || sandbox.state === 'Deleting',
    );
    return requiredId(running, 'sandbox');
  }

  async deleteSnapshot(snapshotId: string): Promise<void> {
    await this.requestData('DELETE', `${this.groupPath()}/snapshots/${seg(snapshotId)}`, {
      okStatuses: [200, 202, 204, 404],
    });
  }

  async exec(
    sandboxId: string,
    command: string[],
    options?: SandboxExecOptions,
  ): Promise<SandboxExecResult> {
    const commandText = commandToShell(command, options?.env);
    const body: { command: string; workingDirectory?: string; user?: string } = {
      command: commandText,
    };
    if (options?.cwd) body.workingDirectory = options.cwd;
    if (options?.user) body.user = options.user;
    const response = await this.requestData<ExecResponse>(
      'POST',
      `${this.sandboxPath(sandboxId)}/executeShellCommand`,
      { json: body, timeoutMs: options?.timeoutMs },
    );
    return {
      stdout: String(response.stdout ?? response.output ?? ''),
      stderr: String(response.stderr ?? ''),
      exitCode: Number(response.exitCode ?? response.exit_code ?? 0),
    };
  }

  /**
   * Native streaming exec over the data plane's WebSocket endpoint
   * (`wss://…/sandboxes/{id}/exec/stream`).
   *
   * Wire protocol (mirrors `@azure/containerapps-sandbox` 1.0.0-beta.1's
   * `ExecStreamSession`): the client sends a `{"type":"start","start":{…}}`
   * frame on open, then the server streams `{"type":"stdout"|"stderr","data":
   * "<base64>"}` frames and finishes with `{"type":"exit_code","exitCode":N}`.
   * `stdin`/`resize` frames exist for interactive TTY sessions but are not
   * needed for the runtime-stream contract. The reference SDK sends no
   * `api-version` query parameter on this endpoint.
   */
  async *execStream(
    sandboxId: string,
    command: string[],
    options?: SandboxExecOptions,
  ): AsyncIterable<SandboxExecChunk> {
    if (options?.user) {
      // The start frame has no user field (unlike buffered executeShellCommand).
      throw new AutopodError(
        'Sandbox streaming exec cannot run as a specific user; drop the user option or use buffered exec',
        'AZURE_SANDBOX_EXEC_USER',
        400,
      );
    }

    // The exec-stream `start.command` is a single string the sandbox runtime
    // `execve`s literally as argv[0] — it is NOT shell-interpreted and carries
    // no arguments (confirmed live: a joined `sh -lc '…'` string fails with
    // "executable file not found in $PATH"). To run an arbitrary argv with
    // streaming output we stage the command as an executable wrapper script and
    // exec that single path instead. cwd/env fold into the script + start frame.
    const scriptPath = await this.stageExecutableWrapper(
      sandboxId,
      streamExecScript(command, options?.cwd),
    );

    const token = await this.getAzureToken(DATA_SCOPE, 'data access token', 'AZURE_AUTH');
    const wsUrl = `${this.dataEndpoint.replace(/^https:/, 'wss:')}${this.sandboxPath(
      sandboxId,
    )}/exec/stream`;
    const socket = this.webSocketFactory(wsUrl, { Authorization: `Bearer ${token.token}` });

    const queue: SandboxExecChunk[] = [];
    let failure: Error | null = null;
    let exitReceived = false;
    let closed = false;
    let notify: (() => void) | null = null;
    const wake = () => {
      const pending = notify;
      notify = null;
      pending?.();
    };
    const fail = (err: Error) => {
      failure ??= err;
      wake();
    };

    const timeoutTimer = options?.timeoutMs
      ? setTimeout(() => {
          fail(
            new AutopodError(
              `Sandbox streaming exec on ${sandboxId} timed out after ${options.timeoutMs}ms`,
              'AZURE_SANDBOX_TIMEOUT',
              504,
            ),
          );
          socket.close();
        }, options.timeoutMs)
      : null;

    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          type: 'start',
          start: {
            command: scriptPath,
            environment: { TERM: 'xterm-256color', LANG: 'C.UTF-8', ...options?.env },
            tty: false,
            stdin: false,
            height: 24,
            width: 80,
          },
        }),
      );
    };
    socket.onmessage = (event) => {
      try {
        const frame = JSON.parse(String(event.data)) as {
          type?: string;
          data?: string;
          exitCode?: number;
        };
        if (frame.type === 'stdout' || frame.type === 'stderr') {
          const text = Buffer.from(frame.data ?? '', 'base64').toString('utf-8');
          queue.push(frame.type === 'stdout' ? { stdout: text } : { stderr: text });
        } else if (frame.type === 'exit_code') {
          exitReceived = true;
          queue.push({ exitCode: Number(frame.exitCode ?? 0) });
          socket.close();
        } else if (frame.type === 'error') {
          fail(
            new AutopodError(
              `Sandbox streaming exec on ${sandboxId} reported an error: ${String(event.data)}`,
              'AZURE_SANDBOX_EXEC_STREAM',
              502,
            ),
          );
        }
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)));
      }
      wake();
    };
    socket.onerror = () => {
      fail(
        new AutopodError(
          `Sandbox streaming exec WebSocket failed for ${sandboxId}`,
          'AZURE_SANDBOX_EXEC_STREAM',
          502,
        ),
      );
    };
    socket.onclose = () => {
      if (!exitReceived) {
        fail(
          new AutopodError(
            `Sandbox streaming exec on ${sandboxId} closed before reporting an exit code`,
            'AZURE_SANDBOX_EXEC_STREAM',
            502,
          ),
        );
      }
      closed = true;
      wake();
    };

    try {
      while (true) {
        const chunk = queue.shift();
        if (chunk) {
          yield chunk;
          if (chunk.exitCode !== undefined) return;
          continue;
        }
        if (failure) throw failure;
        if (closed) return;
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      socket.close();
    }
  }

  /**
   * Stage `scriptBody` as an executable wrapper under `/tmp` and return its path.
   * The files API writes as `root:0644`, so the non-root sandbox process can
   * neither `execve` nor chmod it itself — we `chmod 0755` as root and verify,
   * since a silent failure here resurfaces later as an opaque "permission
   * denied" execve error. Shared by `execStream` and `attachTerminal`, both of
   * which need `command` to be a single executable path.
   */
  private async stageExecutableWrapper(sandboxId: string, scriptBody: string): Promise<string> {
    const scriptPath = `/tmp/.autopod-execstream-${Date.now()}-${this.execStreamSeq++}.sh`;
    await this.writeFile(sandboxId, scriptPath, Buffer.from(scriptBody, 'utf-8'));
    const chmod = await this.exec(sandboxId, ['chmod', '0755', scriptPath], { user: 'root' });
    if (chmod.exitCode !== 0) {
      throw new AutopodError(
        `Failed to stage sandbox exec-stream wrapper ${scriptPath}: chmod exited ${chmod.exitCode} ${chmod.stderr.trim()}`,
        'AZURE_SANDBOX_EXEC_STREAM',
        502,
      );
    }
    return scriptPath;
  }

  /**
   * Open an interactive TTY session over the exec-stream WebSocket (`tty:true`,
   * `stdin:true`). The shell one-liner is staged as an executable wrapper (the
   * `command` field is `execve`d literally — see `execStream`), then driven via
   * `stdin`/`resize` frames; the server merges stdout+stderr into TTY output.
   */
  async attachTerminal(
    sandboxId: string,
    options: SandboxTerminalOptions,
  ): Promise<SandboxTerminalSession> {
    const shellCommand = options.shellCommand ?? 'exec /bin/bash -l';
    const scriptPath = await this.stageExecutableWrapper(sandboxId, `#!/bin/sh\n${shellCommand}\n`);

    const token = await this.getAzureToken(DATA_SCOPE, 'data access token', 'AZURE_AUTH');
    const wsUrl = `${this.dataEndpoint.replace(/^https:/, 'wss:')}${this.sandboxPath(
      sandboxId,
    )}/exec/stream`;
    const socket = this.webSocketFactory(wsUrl, { Authorization: `Bearer ${token.token}` });

    const dataListeners: ((chunk: Buffer) => void)[] = [];
    const exitListeners: ((code: number) => void)[] = [];
    const errorListeners: ((err: Error) => void)[] = [];
    let exited = false;
    let closed = false;

    const emitExit = (code: number) => {
      if (exited) return;
      exited = true;
      for (const listener of exitListeners) listener(code);
    };
    const emitError = (err: Error) => {
      for (const listener of errorListeners) listener(err);
    };

    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          type: 'start',
          start: {
            command: scriptPath,
            environment: { TERM: 'xterm-256color', LANG: 'C.UTF-8', ...options.env },
            tty: true,
            stdin: true,
            height: options.rows,
            width: options.cols,
          },
        }),
      );
    };
    socket.onmessage = (event) => {
      try {
        const frame = JSON.parse(String(event.data)) as {
          type?: string;
          data?: string;
          exitCode?: number;
        };
        if (frame.type === 'stdout' || frame.type === 'stderr') {
          const buf = Buffer.from(frame.data ?? '', 'base64');
          for (const listener of dataListeners) listener(buf);
        } else if (frame.type === 'exit_code') {
          emitExit(Number(frame.exitCode ?? 0));
          socket.close();
        } else if (frame.type === 'error') {
          emitError(
            new AutopodError(
              `Sandbox terminal on ${sandboxId} reported an error: ${String(event.data)}`,
              'AZURE_SANDBOX_EXEC_STREAM',
              502,
            ),
          );
        }
      } catch (err) {
        emitError(err instanceof Error ? err : new Error(String(err)));
      }
    };
    socket.onerror = () => {
      emitError(
        new AutopodError(
          `Sandbox terminal WebSocket failed for ${sandboxId}`,
          'AZURE_SANDBOX_EXEC_STREAM',
          502,
        ),
      );
    };
    socket.onclose = () => {
      closed = true;
      // A clean shell exit sends `exit_code` first; if the socket closes without
      // one, still surface a terminal exit so the route can close the client.
      emitExit(0);
    };

    return {
      onData: (listener) => dataListeners.push(listener),
      onExit: (listener) => exitListeners.push(listener),
      onError: (listener) => errorListeners.push(listener),
      write: (data) => {
        if (closed) return;
        socket.send(JSON.stringify({ type: 'stdin', data: Buffer.from(data).toString('base64') }));
      },
      resize: (cols, rows) => {
        if (closed) return;
        socket.send(JSON.stringify({ type: 'resize', width: cols, height: rows }));
      },
      close: () => {
        if (closed) return;
        closed = true;
        socket.close();
      },
    };
  }

  async writeFile(sandboxId: string, path: string, content: Buffer): Promise<void> {
    await this.requestData('PUT', `${this.sandboxPath(sandboxId)}/files`, {
      body: content,
      headers: { 'Content-Type': 'application/octet-stream' },
      params: { path, createDirs: 'true' },
      okStatuses: [200, 201, 204],
    });
  }

  async readFile(sandboxId: string, path: string): Promise<Buffer> {
    return this.requestDataBuffer('GET', `${this.sandboxPath(sandboxId)}/files`, {
      params: { path },
    });
  }

  async listFiles(sandboxId: string, path: string): Promise<SandboxDirListing> {
    const listing = await this.requestData<WireSandboxDirListing>(
      'GET',
      `${this.sandboxPath(sandboxId)}/files/list`,
      {
        params: { path },
      },
    );
    return {
      path: listing.path ?? path,
      entries: (listing.entries ?? []).map(normalizeSandboxFileInfo),
    };
  }

  async statFile(sandboxId: string, path: string): Promise<SandboxFileInfo> {
    const info = await this.requestData<WireSandboxFileInfo>(
      'GET',
      `${this.sandboxPath(sandboxId)}/files/stat`,
      {
        params: { path },
      },
    );
    return normalizeSandboxFileInfo(info);
  }

  async mkdir(sandboxId: string, path: string): Promise<void> {
    await this.requestData('POST', `${this.sandboxPath(sandboxId)}/files/mkdir`, {
      json: { path },
      okStatuses: [200, 201, 204, 409],
    });
  }

  async updateEgress(sandboxId: string, policy: SandboxEgressPolicy): Promise<void> {
    await this.requestData('POST', `${this.sandboxPath(sandboxId)}/egresspolicy`, {
      json: toWireEgressPolicy(policy),
      okStatuses: [200, 201, 204],
    });
  }

  async addPort(
    sandboxId: string,
    port: number,
    auth?: SandboxPortAuth,
  ): Promise<SandboxExposedPort> {
    const body: { port: number; auth?: WirePortAuth } = { port };
    if (auth?.mode === 'anonymous') {
      body.auth = { anonymous: true };
    } else if (auth?.mode === 'entra') {
      body.auth = { entraId: { enabled: true, emails: auth.emails } };
    }
    const response = await this.requestData<WireSandboxPort>(
      'POST',
      `${this.sandboxPath(sandboxId)}/ports/add`,
      { json: body, okStatuses: [200, 201, 202] },
    );
    let resolved: WireSandboxPort = response;
    // The public URL is assigned asynchronously (confirmed live: the POST response
    // has no `url`; it appears on the sandbox's `ports[]` a few seconds later), so
    // poll the sandbox until the URL for this port materializes.
    if (!resolved.url) {
      for (let attempt = 0; attempt < PORT_URL_POLL_ATTEMPTS; attempt++) {
        await sleep(this.pollIntervalMs);
        const sandbox = await this.getSandbox(sandboxId).catch(() => null);
        const match = sandbox?.ports?.find((p) => Number(p.port) === port && p.url);
        if (match) {
          resolved = match;
          break;
        }
      }
    }
    return {
      port: Number(resolved.port ?? port),
      hostPort: resolved.hostPort,
      protocol: resolved.protocol,
      url: resolved.url,
    };
  }

  async removePort(sandboxId: string, port: number): Promise<void> {
    await this.requestData('POST', `${this.sandboxPath(sandboxId)}/ports/remove`, {
      json: { port },
      okStatuses: [200, 202, 204, 404],
    });
  }

  async suspend(sandboxId: string, _mode: 'memory' | 'disk' = 'memory'): Promise<void> {
    const current = await this.getSandbox(sandboxId).catch(() => null);
    if (current && stoppedStates.has(current.state ?? '')) return;
    await this.requestData('POST', `${this.sandboxPath(sandboxId)}/stop`, {
      okStatuses: [200, 202, 204],
    });
    await this.pollState(
      () => this.getSandbox(sandboxId),
      (sandbox) => stoppedStates.has(sandbox.state ?? ''),
      `sandbox ${sandboxId} stop`,
    );
  }

  async resume(sandboxId: string): Promise<void> {
    const current = await this.getSandbox(sandboxId).catch(() => null);
    if (current?.state === 'Running') return;
    await this.requestData('POST', `${this.sandboxPath(sandboxId)}/resume`, {
      okStatuses: [200, 202, 204],
    });
    await this.pollState(
      () => this.getSandbox(sandboxId),
      (sandbox) => sandbox.state === 'Running',
      `sandbox ${sandboxId} resume`,
    );
  }

  async getStatus(sandboxId: string): Promise<SandboxStatus> {
    const sandbox = await this.getSandbox(sandboxId);
    if (sandbox.state === 'Running') return 'running';
    if (stoppedStates.has(sandbox.state ?? '')) return 'stopped';
    return 'unknown';
  }

  private async ensureSandboxGroup(): Promise<void> {
    if (this.config.assumeGroupExists) return;
    this.groupReady ??= this.ensureSandboxGroupOnce();
    return this.groupReady;
  }

  private async ensureSandboxGroupOnce(): Promise<void> {
    const path = this.armGroupPath();
    const existing = await this.requestArm('GET', path, { okStatuses: [200, 404] });
    if (existing.status !== 404) return;

    this.logger.info(
      { sandboxGroup: this.config.sandboxGroup, location: this.config.location },
      'Creating Azure sandbox group',
    );
    const created = await this.requestArm('PUT', path, {
      json: {
        location: this.config.location,
        ...(this.config.imagePullIdentityResourceId
          ? { identity: userAssignedIdentity(this.config.imagePullIdentityResourceId) }
          : {}),
      },
      okStatuses: [200, 201, 202],
      raw: true,
    });
    await this.pollArmOperation(created.response, path);
  }

  private async ensureDiskImage(baseImage: string): Promise<DiskImageResponse> {
    const key = await this.buildDiskImageKey(baseImage);
    const existingImages = await this.listDiskImages();
    const reusable = await this.findReusableDiskImage(key, existingImages);
    if (reusable) {
      await this.gcStaleDiskImages(key, existingImages);
      return reusable;
    }

    const created = await this.createDiskImage(baseImage, key);
    await this.gcStaleDiskImages(key, existingImages);
    return created;
  }

  private async buildDiskImageKey(baseImage: string): Promise<DiskImageKey> {
    const sourceImageHash = stableHash(baseImage, 16);
    const digestFromReference = imageDigestFromReference(baseImage);
    const resolvedDigest =
      digestFromReference === undefined && this.resolveImageDigest
        ? await this.resolveImageDigest(baseImage)
        : undefined;
    const sourceDigest =
      digestFromReference ?? resolvedDigest ?? `tag:${stableHash(baseImage, 32)}`;
    if (!sourceDigest) {
      throw new AutopodError(
        `Could not resolve image digest for ${baseImage}`,
        'AZURE_SANDBOX_IMAGE_DIGEST',
        502,
      );
    }

    const digestHash = stableHash(sourceDigest, 12);
    const name = `autopod-${sourceImageHash}-${digestHash}`;
    return {
      name,
      sourceImageHash,
      sourceDigest,
      labels: {
        managedBy: 'autopod',
        name,
        sourceImageHash,
        sourceDigest,
      },
    };
  }

  private async findReusableDiskImage(
    key: DiskImageKey,
    images: DiskImageResponse[],
  ): Promise<DiskImageResponse | undefined> {
    for (const image of images) {
      const labels = diskImageLabels(image);
      if (
        labels.managedBy !== 'autopod' ||
        labels.sourceImageHash !== key.sourceImageHash ||
        labels.sourceDigest !== key.sourceDigest
      ) {
        continue;
      }

      const id = image.id;
      if (!id) {
        this.logger.warn({ diskImage: image }, 'Skipping disk image without id');
        continue;
      }

      const state = diskImageState(image);
      if (readyStates.has(state)) {
        this.logger.info(
          { diskImageId: id, sourceImageHash: key.sourceImageHash, sourceDigest: key.sourceDigest },
          'Reusing Azure sandbox disk image',
        );
        return image;
      }
      if (state === 'Failed' || state === 'Deleting') {
        this.logger.warn({ diskImageId: id, state }, 'Discarding unusable disk image');
        await this.deleteDiskImage(id).catch((err) => {
          this.logger.warn({ err, diskImageId: id }, 'Failed to delete unusable disk image');
        });
        continue;
      }

      this.logger.info({ diskImageId: id, state }, 'Waiting for existing disk image');
      return this.pollState(
        () => this.getDiskImage(id),
        (diskImage) => readyStates.has(diskImageState(diskImage)),
        `disk image ${id}`,
        (diskImage) => diskImageState(diskImage) === 'Failed',
      );
    }
    return undefined;
  }

  private async gcStaleDiskImages(key: DiskImageKey, images: DiskImageResponse[]): Promise<void> {
    const staleIds = images
      .filter((image) => {
        const labels = diskImageLabels(image);
        return (
          labels.managedBy === 'autopod' &&
          labels.sourceImageHash === key.sourceImageHash &&
          labels.sourceDigest !== key.sourceDigest &&
          typeof image.id === 'string' &&
          image.id.length > 0
        );
      })
      .map((image) => image.id as string);

    for (const id of staleIds) {
      await this.deleteDiskImage(id).catch((err) => {
        this.logger.warn({ err, diskImageId: id }, 'Failed to delete stale disk image');
      });
    }
  }

  private async listDiskImages(): Promise<DiskImageResponse[]> {
    const response = await this.requestData<DiskImageListResponse | DiskImageResponse[]>(
      'GET',
      `${this.groupPath()}/diskimages`,
      { okStatuses: [200, 404] },
    );
    if (Array.isArray(response)) return response;
    return response.value ?? response.items ?? response.diskImages ?? [];
  }

  private async createDiskImage(baseImage: string, key: DiskImageKey): Promise<DiskImageResponse> {
    this.logger.info(
      { image: baseImage, sourceImageHash: key.sourceImageHash, sourceDigest: key.sourceDigest },
      'Creating Azure sandbox disk image',
    );
    const registryCredentials =
      this.config.registryCredentials ?? (await this.resolveAcrRegistryCredentials(baseImage));
    const initial = await this.requestData<DiskImageResponse>(
      'PUT',
      `${this.groupPath()}/diskimages`,
      {
        json: {
          image: { base: baseImage },
          ...(this.config.imagePullIdentityResourceId
            ? { managedIdentityResourceId: this.config.imagePullIdentityResourceId }
            : {}),
          ...(registryCredentials ? { registryCredentials } : {}),
          labels: key.labels,
        },
        timeoutMs: CREATE_REQUEST_TIMEOUT_MS,
      },
    );
    const id = requiredId(initial, 'disk image');
    this.logger.info({ diskImageId: id }, 'Azure sandbox disk image accepted');
    return this.pollState(
      () => this.getDiskImage(id),
      (image) => readyStates.has(diskImageState(image)),
      `disk image ${id}`,
      (image) => diskImageState(image) === 'Failed',
    );
  }

  private async resolveAcrRegistryCredentials(
    baseImage: string,
  ): Promise<SandboxRegistryCredentials | undefined> {
    const registry = registryHostFromImage(baseImage);
    if (!registry?.endsWith('.azurecr.io')) {
      return undefined;
    }

    this.logger.info({ registry }, 'Minting ACR refresh token for Azure sandbox image pull');
    const token = await this.getAzureToken(ACR_TOKEN_SCOPE, 'ACR access token', 'AZURE_ACR_AUTH');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ACR_EXCHANGE_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.fetchFn(`https://${registry}/oauth2/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'access_token',
          service: registry,
          access_token: token.token,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (isAbortError(err)) {
        throw new AutopodError(
          `ACR token exchange timed out for ${registry} after ${ACR_EXCHANGE_TIMEOUT_MS}ms`,
          'AZURE_ACR_AUTH',
          504,
        );
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      const body = await response.text();
      throw new AutopodError(
        `ACR token exchange failed for ${registry} (${response.status} ${response.statusText}): ${body.slice(
          0,
          300,
        )}`,
        'AZURE_ACR_AUTH',
        401,
      );
    }

    const body = (await response.json()) as { refresh_token?: unknown };
    if (typeof body.refresh_token !== 'string' || body.refresh_token.length === 0) {
      throw new AutopodError(
        `ACR token exchange for ${registry} did not return a refresh token`,
        'AZURE_ACR_AUTH',
        401,
      );
    }

    return { username: ACR_DOCKER_USERNAME, token: body.refresh_token };
  }

  private async createSandboxFromDiskImage(
    diskImageId: string,
    options: CreateSandboxOptions,
  ): Promise<SandboxResponse> {
    this.logger.info({ diskImageId, tier: options.tier }, 'Creating Azure sandbox from disk image');
    const initial = await this.requestData<SandboxResponse>(
      'PUT',
      `${this.groupPath()}/sandboxes`,
      {
        json: {
          sourcesRef: { diskImage: { id: diskImageId } },
          resources: resourcesForTier(options.tier),
          lifecycle: {
            autoSuspendPolicy: { enabled: true, interval: 900, mode: 'Memory' },
          },
          environment: options.env ?? {},
          egressPolicy: toWireEgressPolicy(options.egressPolicy),
          labels: { purpose: 'autopod-sandbox' },
        },
        timeoutMs: CREATE_REQUEST_TIMEOUT_MS,
      },
    );
    const id = requiredId(initial, 'sandbox');
    this.logger.info({ sandboxId: id, diskImageId }, 'Azure sandbox create accepted');
    return this.pollState(
      () => this.getSandbox(id),
      (sandbox) => sandbox.state === 'Running',
      `sandbox ${id}`,
      (sandbox) => sandbox.state === 'Failed' || sandbox.state === 'Deleting',
    );
  }

  private async getSandbox(sandboxId: string): Promise<SandboxResponse> {
    return this.requestData<SandboxResponse>('GET', this.sandboxPath(sandboxId));
  }

  private async getDiskImage(diskImageId: string): Promise<DiskImageResponse> {
    return this.requestData<DiskImageResponse>(
      'GET',
      `${this.groupPath()}/diskimages/${seg(diskImageId)}`,
    );
  }

  private async deleteDiskImage(diskImageId: string): Promise<void> {
    await this.requestData('DELETE', `${this.groupPath()}/diskimages/${seg(diskImageId)}`, {
      okStatuses: [200, 202, 204, 404],
    });
    await this.pollDeleted(() => this.getDiskImage(diskImageId), `disk image ${diskImageId}`);
  }

  private groupPath(): string {
    return `/subscriptions/${seg(this.config.subscriptionId)}/resourceGroups/${seg(
      this.config.resourceGroup,
    )}/sandboxGroups/${seg(this.config.sandboxGroup)}`;
  }

  private sandboxPath(sandboxId: string): string {
    return `${this.groupPath()}/sandboxes/${seg(sandboxId)}`;
  }

  private armGroupPath(): string {
    return `/subscriptions/${seg(this.config.subscriptionId)}/resourceGroups/${seg(
      this.config.resourceGroup,
    )}/providers/Microsoft.App/sandboxGroups/${seg(this.config.sandboxGroup)}`;
  }

  private async requestArm(
    method: string,
    path: string,
    options: RequestOptions & { raw: true },
  ): Promise<{ status: number; response: Response; data: unknown }>;
  private async requestArm(
    method: string,
    path: string,
    options?: RequestOptions,
  ): Promise<{ status: number; data: unknown }>;
  private async requestArm(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<{ status: number; response?: Response; data: unknown }> {
    const baseUrl = options.rawUrl ? path : `https://management.azure.com${path}`;
    const response = await this.request('arm', method, baseUrl, {
      ...options,
      params: { 'api-version': API_VERSION, ...options.params },
    });
    const data = await readJsonOrEmpty(response);
    return options.raw
      ? { status: response.status, response, data }
      : { status: response.status, data };
  }

  private async requestData<T>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const response = await this.request('data', method, `${this.dataEndpoint}${path}`, {
      ...options,
      params: { 'api-version': API_VERSION, ...options.params },
    });
    return readJsonOrEmpty(response) as Promise<T>;
  }

  private async requestDataBuffer(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<Buffer> {
    const response = await this.request('data', method, `${this.dataEndpoint}${path}`, {
      ...options,
      params: { 'api-version': API_VERSION, ...options.params },
    });
    return Buffer.from(await response.arrayBuffer());
  }

  private async request(
    plane: 'arm' | 'data',
    method: string,
    baseUrl: string,
    options: RequestOptions,
  ): Promise<Response> {
    const token = await this.getAzureToken(
      plane === 'arm' ? ARM_SCOPE : DATA_SCOPE,
      `${plane} access token`,
      'AZURE_AUTH',
    );

    const url = withQuery(baseUrl, options.params);
    const headers = new Headers(options.headers);
    headers.set('Authorization', `Bearer ${token.token}`);
    if (options.json !== undefined) {
      headers.set('Content-Type', 'application/json');
    }

    const controller = options.timeoutMs ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), options.timeoutMs) : null;
    try {
      const response = await this.fetchFn(url, {
        method,
        headers,
        body: options.json !== undefined ? JSON.stringify(options.json) : options.body,
        signal: controller?.signal,
      });
      const okStatuses = options.okStatuses ?? [200, 201, 202, 204];
      if (!okStatuses.includes(response.status)) {
        await throwAzureHttpError(response, method, url);
      }
      return response;
    } catch (err) {
      if (controller && isAbortError(err)) {
        throw new AutopodError(
          `Azure Sandboxes ${method} ${url} timed out after ${options.timeoutMs}ms`,
          'AZURE_SANDBOX_TIMEOUT',
          504,
        );
      }
      throw err;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async getAzureToken(scope: string, label: string, code: string): Promise<AccessToken> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        reject(
          new AutopodError(
            `Azure credential timed out while acquiring ${label} after ${AZURE_TOKEN_TIMEOUT_MS}ms`,
            code,
            504,
          ),
        );
      }, AZURE_TOKEN_TIMEOUT_MS);
    });

    try {
      const token = await Promise.race([this.credential.getToken(scope), timedOut]);
      if (!token) {
        throw new AutopodError(`Azure credential did not return ${label}`, code, 401);
      }
      return token;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async pollArmOperation(response: Response, fallbackGetPath: string): Promise<void> {
    const operationUrl =
      response.headers.get('Azure-AsyncOperation') ?? response.headers.get('Location');
    if (operationUrl) {
      await this.pollState(
        () =>
          this.requestArm('GET', operationUrl, { rawUrl: true }).then(
            (r) => r.data as { status?: string },
          ),
        (operation) => operation.status === 'Succeeded' || operation.status === undefined,
        `ARM operation ${operationUrl}`,
        (operation) => operation.status === 'Failed' || operation.status === 'Canceled',
      );
    }
    await this.pollState(
      () => this.requestArm('GET', fallbackGetPath).then((r) => r.data),
      () => true,
      `sandbox group ${this.config.sandboxGroup}`,
    );
  }

  private async pollState<T>(
    getter: () => Promise<T>,
    done: (resource: T) => boolean,
    label: string,
    failed: (resource: T) => boolean = () => false,
  ): Promise<T> {
    const deadline = Date.now() + 15 * 60 * 1000;
    let last: T;
    while (true) {
      last = await getter();
      if (done(last)) return last;
      if (failed(last)) {
        throw new AutopodError(`${label} entered failed state`, 'AZURE_SANDBOX_FAILED', 502);
      }
      if (Date.now() > deadline) {
        throw new AutopodError(
          `${label} did not become ready in time`,
          'AZURE_SANDBOX_TIMEOUT',
          504,
        );
      }
      await sleep(this.pollIntervalMs);
    }
  }

  private async pollDeleted(getter: () => Promise<unknown>, label: string): Promise<void> {
    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() <= deadline) {
      try {
        await getter();
      } catch (err) {
        if (isStatusError(err, 404)) return;
        throw err;
      }
      await sleep(this.pollIntervalMs);
    }
    throw new AutopodError(`${label} was not deleted in time`, 'AZURE_SANDBOX_TIMEOUT', 504);
  }
}

interface RequestOptions {
  params?: Record<string, string | undefined>;
  headers?: Record<string, string>;
  json?: unknown;
  body?: BodyInit;
  okStatuses?: number[];
  timeoutMs?: number;
  raw?: boolean;
  rawUrl?: boolean;
}

const readyStates = new Set(['Ready', 'Succeeded']);
const stoppedStates = new Set(['Stopped', 'Suspended', 'Idle']);

function endpointForRegion(location: string): string {
  return `https://management.${location.toLowerCase().replace(/\s+/g, '')}.azuredevcompute.io`;
}

function resourcesForTier(tier: CreateSandboxOptions['tier']): {
  cpu: string;
  memory: string;
  disk: string;
} {
  const tiers = {
    XS: { cpu: '250m', memory: '512Mi', disk: '5Gi' },
    S: { cpu: '500m', memory: '1024Mi', disk: '10Gi' },
    M: { cpu: '1000m', memory: '2048Mi', disk: '20Gi' },
    L: { cpu: '2000m', memory: '4096Mi', disk: '40Gi' },
  };
  return tiers[tier];
}

function userAssignedIdentity(resourceId: string): {
  type: 'UserAssigned';
  userAssignedIdentities: Record<string, Record<string, never>>;
} {
  return {
    type: 'UserAssigned',
    userAssignedIdentities: { [resourceId]: {} },
  };
}

function toWireEgressPolicy(policy: SandboxEgressPolicy): {
  defaultAction: 'Allow' | 'Deny';
  hostRules?: Array<{ pattern: string; action: 'Allow' | 'Deny' }>;
} {
  return {
    defaultAction: policy.defaultAction,
    ...(policy.hostRules.length > 0 ? { hostRules: policy.hostRules } : {}),
  };
}

function defaultWebSocketFactory(url: string, headers: Record<string, string>): WebSocketLike {
  const ctor = (
    globalThis as {
      WebSocket?: new (url: string, options?: { headers: Record<string, string> }) => WebSocketLike;
    }
  ).WebSocket;
  if (!ctor) {
    throw new AutopodError(
      'Global WebSocket is unavailable; Node 22+ is required for sandbox streaming exec',
      'AZURE_SANDBOX_EXEC_STREAM',
      500,
    );
  }
  // Node's undici WebSocket accepts a non-standard `headers` option in the
  // second argument — the same mechanism the reference SDK uses for auth.
  return new ctor(url, { headers });
}

/**
 * The exec-stream `start.command` is `execve`d literally as a single argv[0]
 * (not shell-interpreted, no arguments), so an arbitrary argv can only be run
 * by staging it as an executable wrapper script and exec-ing that path. This
 * builds that script: a `#!/bin/sh` shebang, an optional `cd` into `cwd`, then
 * `exec <argv>` so the command's exit code propagates as the script's own.
 */
function streamExecScript(command: string[], cwd?: string): string {
  const argv = command.map(shellQuote).join(' ');
  const lines = ['#!/bin/sh'];
  if (cwd) lines.push(`cd ${shellQuote(cwd)} || exit 1`);
  lines.push(`exec ${argv}`);
  return `${lines.join('\n')}\n`;
}

function commandToShell(command: string[], env?: Record<string, string>): string {
  const envPrefix = env
    ? Object.entries(env)
        .map(([key, value]) => `${key}=${shellQuote(value)}`)
        .join(' ')
    : '';
  const commandText = command.map(shellQuote).join(' ');
  return envPrefix ? `env ${envPrefix} ${commandText}` : commandText;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function withQuery(baseUrl: string, params?: Record<string, string | undefined>): string {
  const url = new URL(baseUrl);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

function seg(value: string): string {
  return encodeURIComponent(value);
}

function registryHostFromImage(image: string): string | undefined {
  const [firstComponent = ''] = image.split('/');
  if (!image.includes('/') || (!firstComponent.includes('.') && !firstComponent.includes(':'))) {
    return undefined;
  }
  return firstComponent.toLowerCase();
}

function imageDigestFromReference(image: string): string | undefined {
  const digestIndex = image.indexOf('@sha256:');
  if (digestIndex === -1) return undefined;
  return image.slice(digestIndex + 1);
}

function stableHash(value: string, length: number): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

function diskImageLabels(image: DiskImageResponse): Record<string, string> {
  return image.labels ?? image.properties?.labels ?? {};
}

function diskImageState(image: DiskImageResponse): string {
  return image.status?.state ?? image.properties?.status?.state ?? '';
}

function normalizeSandboxFileInfo(info: WireSandboxFileInfo): SandboxFileInfo {
  const path = String(info.path ?? '');
  const name = String(info.name ?? path.split('/').filter(Boolean).at(-1) ?? '');
  return {
    name,
    path,
    isDirectory: Boolean(info.isDirectory ?? info.isDir ?? false),
    ...(typeof info.size === 'number' ? { size: info.size } : {}),
    ...(info.modifiedAt
      ? { modifiedAt: info.modifiedAt }
      : typeof info.modifiedTime === 'number'
        ? { modifiedAt: new Date(info.modifiedTime * 1000).toISOString() }
        : {}),
    ...(info.mode !== undefined ? { mode: String(info.mode) } : {}),
  };
}

function requiredId(resource: { id?: string }, label: string): string {
  if (!resource.id) {
    throw new AutopodError(
      `Azure ${label} response did not include an id`,
      'AZURE_BAD_RESPONSE',
      502,
    );
  }
  return resource.id;
}

async function readJsonOrEmpty(response: Response): Promise<unknown> {
  if (response.status === 204) return {};
  const text = await response.text();
  if (!text) return {};
  return JSON.parse(text) as unknown;
}

async function throwAzureHttpError(
  response: Response,
  method: string,
  url: string,
): Promise<never> {
  const content = await response.text().catch(() => '');
  throw new AutopodError(
    `Azure Sandboxes ${method} ${url} failed with ${response.status}: ${content.slice(0, 1000)}`,
    'AZURE_SANDBOX_HTTP_ERROR',
    response.status,
  );
}

function isStatusError(err: unknown, status: number): boolean {
  return err instanceof AutopodError && err.statusCode === status;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
