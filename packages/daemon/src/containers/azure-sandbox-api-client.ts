import { AutopodError } from '@autopod/shared';
import type { Logger } from 'pino';
import type {
  CreateSandboxOptions,
  SandboxApiClient,
  SandboxEgressPolicy,
  SandboxExecOptions,
  SandboxExecResult,
  SandboxStatus,
} from './sandbox-api-client.js';

export interface AzureSandboxApiClientConfig {
  /** Azure subscription ID. */
  subscriptionId: string;
  /** Resource group hosting the SandboxGroup (Microsoft.App/SandboxGroups). */
  resourceGroup: string;
  /** Azure region for sandbox placement (e.g. "westeurope"). */
  location: string;
}

/**
 * Concrete {@link SandboxApiClient} backed by the Azure Container Apps
 * **Sandboxes** preview data-plane.
 *
 * ⚠️  STUB — every call throws `NOT_IMPLEMENTED`. The preview SDK
 * (`azure-containerapps-sandbox`) is early-access, gated to enrolled Entra
 * tenants, and its method surface is unconfirmed (docs 403 without login).
 *
 * To finish this adapter:
 *   1. Run `spikes/aca-sandbox/probe.py` against an enrolled tenant to confirm
 *      exec streaming, file I/O, directory extraction, and runtime-mutable egress.
 *   2. Reconcile the `# VERIFY:` calls in `spikes/aca-sandbox/sandbox_client.py`.
 *   3. Implement these methods against the confirmed data-plane API.
 *
 * Everything that *consumes* this client — tier selection, egress-policy
 * mapping, exec/file/extract semantics, the streaming fallback, suspend/resume —
 * already lives, and is unit-tested, in `SandboxContainerManager`. This adapter
 * is the only remaining unwired surface.
 */
export class AzureSandboxApiClient implements SandboxApiClient {
  private readonly config: AzureSandboxApiClientConfig;
  private readonly logger: Logger;

  constructor(config: AzureSandboxApiClientConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
    this.logger.debug(
      {
        subscriptionId: config.subscriptionId,
        resourceGroup: config.resourceGroup,
        location: config.location,
      },
      'AzureSandboxApiClient constructed (stub — preview SDK not yet wired)',
    );
  }

  async createSandbox(_options: CreateSandboxOptions): Promise<string> {
    return this.notWired('createSandbox');
  }

  async destroy(_sandboxId: string): Promise<void> {
    return this.notWired('destroy');
  }

  async exec(
    _sandboxId: string,
    _command: string[],
    _options?: SandboxExecOptions,
  ): Promise<SandboxExecResult> {
    return this.notWired('exec');
  }

  async writeFile(_sandboxId: string, _path: string, _content: Buffer): Promise<void> {
    return this.notWired('writeFile');
  }

  async readFile(_sandboxId: string, _path: string): Promise<Buffer> {
    return this.notWired('readFile');
  }

  async updateEgress(_sandboxId: string, _policy: SandboxEgressPolicy): Promise<void> {
    return this.notWired('updateEgress');
  }

  async suspend(_sandboxId: string, _mode?: 'memory' | 'disk'): Promise<void> {
    return this.notWired('suspend');
  }

  async resume(_sandboxId: string): Promise<void> {
    return this.notWired('resume');
  }

  async getStatus(_sandboxId: string): Promise<SandboxStatus> {
    return this.notWired('getStatus');
  }

  private notWired(method: string): never {
    throw new AutopodError(
      `Azure Container Apps Sandboxes data-plane is not yet wired (AzureSandboxApiClient.${method}). Run spikes/aca-sandbox/probe.py against an enrolled Entra tenant to confirm the preview SDK, reconcile the # VERIFY calls in spikes/aca-sandbox/sandbox_client.py, then implement this adapter. Use executionTarget: "local" (Docker) meanwhile.`,
      'NOT_IMPLEMENTED',
      501,
    );
  }
}
