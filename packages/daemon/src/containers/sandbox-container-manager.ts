import { AutopodError } from '@autopod/shared';
import type { Logger } from 'pino';
import type {
  ContainerManager,
  ContainerSpawnConfig,
  ExecOptions,
  ExecResult,
  StreamingExecResult,
} from '../interfaces/container-manager.js';

/**
 * Resource tier for a sandbox, mapping to the preview product's published tiers:
 *   XS = 0.25 cores / 0.5 GB   S = 0.5 cores / 1 GB
 *   M  = 1 core   / 2 GB       L = 2 cores  / 4 GB / 40 GB disk (default)
 */
export type SandboxResourceTier = 'XS' | 'S' | 'M' | 'L';

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
 * Azure Container Apps **Sandboxes** container manager — SCAFFOLD ONLY.
 *
 * This is the replacement for the removed ACI backend (`executionTarget: 'sandbox'`).
 * Sandboxes is a strictly better fit than ACI on every axis: BYO OCI image,
 * microVM isolation, snapshot suspend/resume (→ stop()/start()), native file
 * management (→ extractDirectoryFromContainer, which ACI could not do), and a
 * per-sandbox egress policy that is mutable at runtime (→ refreshFirewall, and
 * full allow-all / deny-all / restricted support — no iptables/HAProxy needed).
 *
 * ⚠️  NOT YET WIRED. The preview SDK (`azure-containerapps-sandbox`) is
 * early-access and gated to enrolled Entra tenants; its method surface is
 * unconfirmed and it is not yet on public PyPI/npm. Every method here throws
 * until the feasibility spike confirms the API.
 *
 *   1. Run `spikes/aca-sandbox/probe.py` against an enrolled tenant to confirm
 *      exec streaming, file I/O, directory extraction, and runtime-mutable egress.
 *   2. Reconcile the `# VERIFY:` calls in `spikes/aca-sandbox/sandbox_client.py`.
 *   3. Implement these methods against the confirmed data-plane API.
 *
 * Until then this manager only activates when AZURE_SUBSCRIPTION_ID +
 * AZURE_RESOURCE_GROUP are set AND a profile opts into `executionTarget: 'sandbox'`;
 * spawning such a pod surfaces the not-wired error clearly rather than silently
 * falling back to Docker.
 */
export class SandboxContainerManager implements ContainerManager {
  private readonly config: Required<SandboxContainerManagerConfig>;
  private readonly logger: Logger;

  constructor(config: SandboxContainerManagerConfig, logger: Logger) {
    this.config = { tier: 'L', ...config };
    this.logger = logger;
  }

  /**
   * Note: unlike ACI, there is intentionally NO guard rejecting `deny-all` /
   * `restricted` here. The Sandboxes per-sandbox egress policy supports all three
   * modes natively — `allow-all` → default Allow, `deny-all` → default Deny,
   * `restricted` → default Deny + host allow-rules. Wiring that mapping is part
   * of the spawn() / refreshFirewall() implementation below.
   */
  async spawn(_config: ContainerSpawnConfig): Promise<string> {
    return this.notWired('spawn');
  }

  async kill(_containerId: string): Promise<void> {
    return this.notWired('kill');
  }

  /** Maps to a runtime egress-policy update on the sandbox. */
  async refreshFirewall(_containerId: string, _script: string): Promise<void> {
    return this.notWired('refreshFirewall');
  }

  /** Maps to sandbox snapshot suspend (memory mode). */
  async stop(_containerId: string): Promise<void> {
    return this.notWired('stop');
  }

  /** Maps to sandbox resume from snapshot. */
  async start(_containerId: string): Promise<void> {
    return this.notWired('start');
  }

  async writeFile(_containerId: string, _path: string, _content: string | Buffer): Promise<void> {
    return this.notWired('writeFile');
  }

  async readFile(_containerId: string, _path: string): Promise<string> {
    return this.notWired('readFile');
  }

  async readFileBinary(_containerId: string, _path: string): Promise<Buffer> {
    return this.notWired('readFileBinary');
  }

  async extractDirectoryFromContainer(
    _containerId: string,
    _containerPath: string,
    _hostPath: string,
    _excludes?: string[],
  ): Promise<void> {
    return this.notWired('extractDirectoryFromContainer');
  }

  async getStatus(_containerId: string): Promise<'running' | 'stopped' | 'unknown'> {
    return this.notWired('getStatus');
  }

  async execInContainer(
    _containerId: string,
    _command: string[],
    _options?: ExecOptions,
  ): Promise<ExecResult> {
    return this.notWired('execInContainer');
  }

  async execStreaming(
    _containerId: string,
    _command: string[],
    _options?: ExecOptions,
  ): Promise<StreamingExecResult> {
    return this.notWired('execStreaming');
  }

  private notWired(method: string): never {
    throw new AutopodError(
      `Sandbox execution target is not yet implemented (SandboxContainerManager.${method}). The Azure Container Apps Sandboxes backend is scaffolded but unwired — run spikes/aca-sandbox/probe.py against an enrolled tenant to confirm the preview SDK, then implement this manager. Use executionTarget: "local" (Docker) meanwhile.`,
      'NOT_IMPLEMENTED',
      501,
    );
  }
}
