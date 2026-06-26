import { AutopodError } from '@autopod/shared';
import { DefaultAzureCredential } from '@azure/identity';
import type { Logger } from 'pino';
import type {
  CreateSandboxOptions,
  SandboxApiClient,
  SandboxDirListing,
  SandboxEgressPolicy,
  SandboxExecOptions,
  SandboxExecResult,
  SandboxFileInfo,
  SandboxRegistryCredentials,
  SandboxStatus,
} from './sandbox-api-client.js';

const API_VERSION = '2026-02-01-preview';
const ARM_SCOPE = 'https://management.azure.com/.default';
const DATA_SCOPE = 'https://dynamicsessions.io/.default';
const ACR_TOKEN_SCOPE = 'https://containerregistry.azure.net/.default';
const ACR_DOCKER_USERNAME = '00000000-0000-0000-0000-000000000000';

interface AccessToken {
  token: string;
}

interface TokenCredentialLike {
  getToken(scopes: string | string[]): Promise<AccessToken | null>;
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

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
  /** Test seam. Defaults to 3s to match the Python SDK poller. */
  pollIntervalMs?: number;
}

interface DiskImageResponse {
  id?: string;
  status?: { state?: string; message?: string };
}

interface SandboxResponse {
  id?: string;
  state?: string;
  sourcesRef?: { diskImage?: { id?: string } };
}

interface ExecResponse {
  stdout?: string;
  output?: string;
  stderr?: string;
  exitCode?: number;
  exit_code?: number;
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
  private readonly pollIntervalMs: number;
  private readonly dataEndpoint: string;
  private readonly diskImagesBySandbox = new Map<string, string>();
  private groupReady: Promise<void> | null = null;

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
    const diskImage = await this.createDiskImage(options.image);
    const diskImageId = requiredId(diskImage, 'disk image');
    try {
      const sandbox = await this.createSandboxFromDiskImage(diskImageId, options);
      const sandboxId = requiredId(sandbox, 'sandbox');
      this.diskImagesBySandbox.set(sandboxId, diskImageId);
      return sandboxId;
    } catch (err) {
      await this.deleteDiskImage(diskImageId).catch((deleteErr) => {
        this.logger.warn({ err: deleteErr, diskImageId }, 'Failed to delete partial disk image');
      });
      throw err;
    }
  }

  async destroy(sandboxId: string): Promise<void> {
    let diskImageId = this.diskImagesBySandbox.get(sandboxId);
    if (!diskImageId) {
      const sandbox = await this.getSandbox(sandboxId).catch(() => null);
      diskImageId = sandbox?.sourcesRef?.diskImage?.id;
    }

    await this.requestData('DELETE', `${this.sandboxPath(sandboxId)}`, {
      okStatuses: [200, 202, 204, 404],
    });
    await this.pollDeleted(() => this.getSandbox(sandboxId), `sandbox ${sandboxId}`);

    if (diskImageId) {
      await this.deleteDiskImage(diskImageId).catch((err) => {
        this.logger.warn({ err, sandboxId, diskImageId }, 'Failed to delete sandbox disk image');
      });
      this.diskImagesBySandbox.delete(sandboxId);
    }
  }

  async exec(
    sandboxId: string,
    command: string[],
    options?: SandboxExecOptions,
  ): Promise<SandboxExecResult> {
    const commandText = commandToShell(command, options?.env);
    const body: { command: string; workingDirectory?: string } = { command: commandText };
    if (options?.cwd) body.workingDirectory = options.cwd;
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
    return this.requestData<SandboxDirListing>('GET', `${this.sandboxPath(sandboxId)}/files/list`, {
      params: { path },
    });
  }

  async statFile(sandboxId: string, path: string): Promise<SandboxFileInfo> {
    return this.requestData<SandboxFileInfo>('GET', `${this.sandboxPath(sandboxId)}/files/stat`, {
      params: { path },
    });
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

  private async createDiskImage(baseImage: string): Promise<DiskImageResponse> {
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
          labels: { name: `autopod-${Date.now()}` },
        },
      },
    );
    const id = requiredId(initial, 'disk image');
    return this.pollState(
      () => this.getDiskImage(id),
      (image) => readyStates.has(image.status?.state ?? ''),
      `disk image ${id}`,
      (image) => image.status?.state === 'Failed',
    );
  }

  private async resolveAcrRegistryCredentials(
    baseImage: string,
  ): Promise<SandboxRegistryCredentials | undefined> {
    const registry = registryHostFromImage(baseImage);
    if (!registry?.endsWith('.azurecr.io')) {
      return undefined;
    }

    const token = await this.credential.getToken(ACR_TOKEN_SCOPE);
    if (!token) {
      throw new AutopodError(
        'Azure credential did not return an ACR access token',
        'AZURE_AUTH',
        401,
      );
    }

    const response = await this.fetchFn(`https://${registry}/oauth2/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'access_token',
        service: registry,
        access_token: token.token,
      }),
    });
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
      },
    );
    const id = requiredId(initial, 'sandbox');
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
    const token = await this.credential.getToken(plane === 'arm' ? ARM_SCOPE : DATA_SCOPE);
    if (!token) {
      throw new AutopodError('Azure credential did not return an access token', 'AZURE_AUTH', 401);
    }

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
