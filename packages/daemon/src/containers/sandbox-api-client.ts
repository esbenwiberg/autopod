/**
 * Seam over the Azure Container Apps **Sandboxes** preview data-plane.
 *
 * Every preview-SDK touchpoint lives behind this interface so that
 * `SandboxContainerManager` — which holds all the mapping logic (tier selection,
 * egress-policy translation, exec/file/extract semantics, streaming fallback,
 * suspend/resume) — is fully unit-testable without Azure. The only thing the
 * feasibility spike needs to finalize is a single adapter class
 * (`AzureSandboxApiClient`) that implements this interface.
 *
 * This is the TypeScript mirror of `spikes/aca-sandbox/sandbox_client.py`. It is
 * intentionally **id-based** (not handle-based) so a daemon restart can operate
 * on a sandbox purely by its id, with no in-memory handle to rehydrate (see
 * `pods/reconciler.ts`).
 */

/** Resource tier, mapping to the preview product's published tiers. */
export type SandboxResourceTier = 'XS' | 'S' | 'M' | 'L';

export interface SandboxEgressRule {
  pattern: string;
  action: 'Allow' | 'Deny';
}

/**
 * Per-sandbox egress policy. `defaultAction` is the fallthrough; `hostRules` are
 * evaluated in order. The native equivalent of the Docker backend's
 * iptables/HAProxy machinery — no proxy needed.
 */
export interface SandboxEgressPolicy {
  defaultAction: 'Allow' | 'Deny';
  hostRules: SandboxEgressRule[];
}

export interface SandboxRegistryCredentials {
  username: string;
  token: string;
}

export interface CreateSandboxOptions {
  image: string;
  tier: SandboxResourceTier;
  egressPolicy: SandboxEgressPolicy;
  /** Environment for the sandbox's main process. */
  env?: Record<string, string>;
}

export interface SandboxExecOptions {
  cwd?: string;
  timeoutMs?: number;
  /** Run the command as this user inside the sandbox (e.g. 'root'). */
  user?: string;
  /** Extra env vars for this exec, in addition to the sandbox's main-process env. */
  env?: Record<string, string>;
}

export interface SandboxExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SandboxExecChunk {
  stdout?: string;
  stderr?: string;
  /** Present on the final chunk only. */
  exitCode?: number;
}

export interface SandboxFileInfo {
  name: string;
  path: string;
  size?: number;
  isDirectory: boolean;
  modifiedAt?: string;
  mode?: string;
}

export interface SandboxDirListing {
  path: string;
  entries: SandboxFileInfo[];
}

export interface SandboxTerminalOptions {
  cols: number;
  rows: number;
  /**
   * Shell one-liner to run as the interactive session (e.g. the tmux-reattach
   * command). Staged as an executable wrapper script because the exec-stream
   * `command` field is `execve`d literally, not shell-interpreted. Defaults to
   * a bare `/bin/bash` login shell.
   */
  shellCommand?: string;
  env?: Record<string, string>;
}

/**
 * Bidirectional interactive TTY session over the exec-stream WebSocket. Output
 * is the merged TTY stream (stdout+stderr).
 */
export interface SandboxTerminalSession {
  onData(listener: (chunk: Buffer) => void): void;
  onExit(listener: (exitCode: number) => void): void;
  onError(listener: (err: Error) => void): void;
  write(data: Buffer): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

/**
 * Auth mode for an exposed sandbox port. `anonymous` opens the public URL to the
 * internet (opt-in, ideally IP-fenced); `entra` requires Entra ID sign-in from
 * one of `emails`.
 */
export type SandboxPortAuth = { mode: 'anonymous' } | { mode: 'entra'; emails: string[] };

/** A port exposed on a sandbox, with the platform-assigned public URL. */
export interface SandboxExposedPort {
  /** The in-sandbox application port. */
  port: number;
  /** Host-side port, when the platform reports one. */
  hostPort?: number;
  /** `Http` | `Http2`. */
  protocol?: string;
  /** Public URL the platform assigned for this port. */
  url?: string;
}

export type SandboxStatus = 'running' | 'stopped' | 'unknown';

export interface SandboxApiClient {
  /** Provision a sandbox from an OCI image with an initial egress policy. Returns its id. */
  createSandbox(options: CreateSandboxOptions): Promise<string>;
  /** Delete a sandbox. Should be idempotent — a missing sandbox is treated as already destroyed. */
  destroy(sandboxId: string): Promise<void>;
  /** Run a command to completion and return buffered output. */
  exec(
    sandboxId: string,
    command: string[],
    options?: SandboxExecOptions,
  ): Promise<SandboxExecResult>;
  /**
   * Native streaming exec. Optional: when omitted, the manager reports
   * `supportsStreamingExec=false` and rejects long-lived runtime streams.
   */
  execStream?(
    sandboxId: string,
    command: string[],
    options?: SandboxExecOptions,
  ): AsyncIterable<SandboxExecChunk>;
  /**
   * Open an interactive TTY session over the exec-stream WebSocket. Optional:
   * omitted by clients without streaming support (the terminal route then
   * rejects sandbox connections).
   */
  attachTerminal?(
    sandboxId: string,
    options: SandboxTerminalOptions,
  ): Promise<SandboxTerminalSession>;
  writeFile(sandboxId: string, path: string, content: Buffer): Promise<void>;
  readFile(sandboxId: string, path: string): Promise<Buffer>;
  listFiles(sandboxId: string, path: string): Promise<SandboxDirListing>;
  statFile?(sandboxId: string, path: string): Promise<SandboxFileInfo>;
  mkdir?(sandboxId: string, path: string): Promise<void>;
  /** Replace the sandbox's egress policy at runtime. */
  updateEgress(sandboxId: string, policy: SandboxEgressPolicy): Promise<void>;
  /**
   * Expose an in-sandbox port and return its public URL. Optional — omitted by
   * clients without native inbound-port support. `auth` defaults to Entra when
   * omitted (never silently anonymous).
   */
  addPort?(sandboxId: string, port: number, auth?: SandboxPortAuth): Promise<SandboxExposedPort>;
  /** Remove a previously exposed port. Idempotent — a missing port is a no-op. */
  removePort?(sandboxId: string, port: number): Promise<void>;
  /** Snapshot-suspend the sandbox (maps to ContainerManager.stop). */
  suspend(sandboxId: string, mode?: 'memory' | 'disk'): Promise<void>;
  /** Resume a suspended sandbox (maps to ContainerManager.start). */
  resume(sandboxId: string): Promise<void>;
  getStatus(sandboxId: string): Promise<SandboxStatus>;
}

// ---------------------------------------------------------------------------
// Pure mapping helpers — no Azure, no SDK. Unit-tested in sandbox-api-client.test.ts.
// ---------------------------------------------------------------------------

/** Published memory ceiling per tier, in bytes. */
const TIER_MEMORY_BYTES: Record<SandboxResourceTier, number> = {
  XS: 512 * 1024 * 1024, // 0.5 GB
  S: 1024 * 1024 * 1024, // 1 GB
  M: 2 * 1024 * 1024 * 1024, // 2 GB
  L: 4 * 1024 * 1024 * 1024, // 4 GB
};

const TIER_ORDER: readonly SandboxResourceTier[] = ['XS', 'S', 'M', 'L'];

/**
 * Pick the smallest tier whose memory ceiling satisfies `memoryBytes`. Falls back
 * to `defaultTier` when no memory hint is given, and to the largest tier (`L`)
 * when the request exceeds every published tier.
 */
export function pickSandboxTier(
  memoryBytes: number | undefined,
  defaultTier: SandboxResourceTier,
): SandboxResourceTier {
  if (!memoryBytes || memoryBytes <= 0) return defaultTier;
  for (const tier of TIER_ORDER) {
    if (TIER_MEMORY_BYTES[tier] >= memoryBytes) return tier;
  }
  return 'L';
}

/**
 * Translate a network-policy mode + host allowlist into a sandbox egress policy:
 *   - `allow-all`  → default Allow, no rules
 *   - `deny-all`   → default Deny, no rules
 *   - `restricted` → default Deny + one Allow rule per allowed host
 */
export function egressPolicyForMode(
  mode: 'allow-all' | 'deny-all' | 'restricted' | undefined,
  allowedHosts: string[] = [],
): SandboxEgressPolicy {
  switch (mode) {
    case 'deny-all':
      return { defaultAction: 'Deny', hostRules: [] };
    case 'restricted':
      return {
        defaultAction: 'Deny',
        hostRules: allowedHosts.map((host) => ({ pattern: host, action: 'Allow' as const })),
      };
    default:
      return { defaultAction: 'Allow', hostRules: [] };
  }
}
