import { execFile } from 'node:child_process';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { PendingRequests } from '@autopod/escalation-mcp';
import type {
  AcValidationResult,
  AgentEvent,
  BuildResult,
  CreatePodRequest,
  DaemonConfig,
  EscalationRequest,
  ExecutionTarget,
  HealthResult,
  HistoryQuery,
  InjectedMcpServer,
  LintResult,
  McpServerConfig,
  NetworkPolicy,
  PageResult,
  Pod,
  PodOptions,
  PodStatus,
  PrivateRegistry,
  Profile,
  RequestCredentialPayload,
  SastResult,
  StdioInjectedMcpServer,
  TaskReviewResult,
  ValidationFinding,
  ValidationOverride,
  ValidationOverridePayload,
} from '@autopod/shared';
import {
  AUTOPOD_INSTRUCTIONS_PATH,
  AutopodError,
  CONTAINER_HOME_DIR,
  DEFAULT_CONTAINER_MEMORY_GB,
  DEFAULT_MAX_PR_FIX_ATTEMPTS,
  generateId,
  generatePodId,
  outputModeFromPodOptions,
  podOptionsFromOutputMode,
  processContent,
  resolvePodOptions,
} from '@autopod/shared';
import type { Logger } from 'pino';
import type { ActionAuditRepository } from '../actions/audit-repository.js';
import { resolveEffectiveActionPolicy } from '../actions/policy-resolver.js';
import { isExpectedDockerError } from '../containers/docker-helpers.js';
import { networkNameForPod } from '../containers/docker-network-manager.js';
import type { SidecarManager } from '../containers/sidecar-manager.js';
import { resolveSidecarSpec, sidecarPodEnv } from '../containers/sidecar-resolver.js';
import type { PodTokenIssuer } from '../crypto/pod-tokens.js';
import { createHistoryExporter } from '../history/history-exporter.js';
import { generateHistoryInstructions } from '../history/instructions-generator.js';
import { getBaseImage } from '../images/dockerfile-generator.js';
import type {
  ContainerManager,
  PrManager,
  PrMergeStatus,
  RuntimeRegistry,
  ValidationEngine,
  WorktreeManager,
} from '../interfaces/index.js';
import { selectGitPat } from '../profiles/index.js';
import type { ProfileStore } from '../profiles/index.js';
import {
  buildClaudeConfigFiles,
  buildProviderEnv,
  persistRefreshedCredentials,
} from '../providers/index.js';
import type { ClaudeRuntime } from '../runtimes/claude-runtime.js';
import { detectRecurringFindings, extractFindings } from '../validation/finding-fingerprint.js';
import { applyOverrides } from '../validation/override-applicator.js';
import { buildGitHubImageUrl, collectScreenshots } from '../validation/screenshot-collector.js';
import { DeletionGuardError } from '../worktrees/local-worktree-manager.js';
import { readAcFile } from './ac-file-parser.js';
import { buildCorrectionMessage } from './correction-context.js';
import type { EscalationRepository } from './escalation-repository.js';
import type { EventBus } from './event-bus.js';
import type { EventRepository } from './event-repository.js';
import { formatFeedback } from './feedback-formatter.js';
import { mergeClaudeMdSections, mergeMcpServers, mergeSkills } from './injection-merger.js';
import type { NudgeRepository } from './nudge-repository.js';
import type { PodRepository, PodStats, PodUpdates } from './pod-repository.js';
import type { ProgressEventRepository } from './progress-event-repository.js';
import { buildContinuationPrompt, buildRecoveryTask, buildReworkTask } from './recovery-context.js';
import { deriveReferenceRepos, resolveRefRepoPat } from './reference-repos.js';
import {
  CREDENTIAL_GUARD_HOOK,
  buildNuGetCredentialEnv,
  buildNuGetSecretFile,
  buildRegistryFiles,
  buildValidationExecEnv,
  ensureNuGetCredentialProvider,
  validateRegistryFiles,
} from './registry-injector.js';
import { resolveSections } from './section-resolver.js';
import { resolveSkills } from './skill-resolver.js';
import {
  canFail,
  canKill,
  canNudge,
  canPause,
  canPromote,
  canReceiveMessage,
  isTerminalState,
  validateTransition,
} from './state-machine.js';
import { generateSystemInstructions } from './system-instructions-generator.js';
import type { ValidationRepository } from './validation-repository.js';
import {
  buildBashrcHintBlock,
  buildWorkspaceToolsDoc,
  mergeBashrcHint,
} from './workspace-tools-doc.js';

/** Inject a PAT into an https URL: https://host/... → https://x-access-token:PAT@host/...
 * Strips any existing userinfo first to avoid double-injection. */
function injectPatIntoUrl(url: string, pat: string): string {
  return url.replace(/^https:\/\/([^@]*@)?/, `https://x-access-token:${pat}@`);
}

/** Allocate a random host port in range 10000–48999 for container port mapping.
 * Capped at 48999 to avoid the Windows/Hyper-V dynamic port reservation range (49152+). */
function allocateHostPort(): number {
  return 10_000 + Math.floor(Math.random() * 39_000);
}

/** Default container port for app servers (matches Dockerfile HEALTHCHECK). */
const CONTAINER_APP_PORT = 3000;

/** Path to the agent shim script inside every pod container. */
export const AGENT_SHIM_PATH = '/run/autopod/agent-shim.sh';

/**
 * Shim script written to every pod container before the agent exec.
 * Reads *_FILE env vars and exports the real credential values so that SDKs
 * without native _FILE support still get the secret — but the raw value is
 * never present in the exec's initial environment visible to `docker inspect`
 * or a process-level env dump of the container's main entrypoint.
 */
// NOTE: this is a JS template literal. Bare `${...}` gets interpolated by JS at
// compile time, so every occurrence the shell needs to see literally must be
// escaped (`\${...}`). Likewise, when the shell needs to see a literal
// backslash before a `$`, the source needs `\\` (one for JS, one survives).
export const AGENT_SHIM_SCRIPT = `#!/bin/sh
# Autopod agent shim — expand *_FILE env vars before exec-ing the agent
_read_file_var() {
  local var_name="$1" file_var="\${1}_FILE"
  local path
  eval "path=\\\${$file_var:-}"
  [ -n "$path" ] && [ -f "$path" ] && export "$var_name=$(cat "$path")" && unset "$file_var"
}
_read_file_var ANTHROPIC_API_KEY
_read_file_var OPENAI_API_KEY
_read_file_var COPILOT_GITHUB_TOKEN
_read_file_var VSS_NUGET_EXTERNAL_FEED_ENDPOINTS
exec "$@"
`;

/**
 * Build the task string for a PR fix pod, injecting CI failure details and
 * review comments so the agent knows exactly what to fix.
 *
 * Review comments and CI annotations are attacker-controlled (any GitHub user
 * can post a review). Run them through the PI + PII pipeline before embedding
 * so a malicious reviewer cannot inject instructions into the fix pod.
 *
 * Exported for unit testing only.
 */
export function buildPrFixTask(
  pod: Pod,
  status: PrMergeStatus,
  podRepo: PodRepository,
  profile: Profile,
  userMessage?: string,
): string {
  const attempt = (pod.prFixAttempts ?? 0) + 1;

  // Walk linkedPodId back to the originating pod (fix→fix→…→original).
  // Prevents nested [PR FIX] boilerplate + duplicate review-comment blocks when a
  // fix pod somehow ends up spawning a sub-fixer. Series pods don't use
  // linkedPodId (they use dependsOnPodIds), so this loop is a no-op for them.
  let ancestor: Pod = pod;
  while (ancestor.linkedPodId) {
    try {
      ancestor = podRepo.getOrThrow(ancestor.linkedPodId);
    } catch {
      break;
    }
  }

  // Single-PR series pods share one branch and one PR, so the per-pod `task`
  // only describes one brief — the cross-brief framing the fixer needs lives
  // in seriesDescription (sourced from briefs/context.md). Stacked-PR series
  // keep their per-pod task because each pod owns its own scoped PR.
  const rootTask =
    ancestor.prMode === 'single' && ancestor.seriesDescription
      ? ancestor.seriesDescription
      : ancestor.task;

  // Sanitize a reviewer-supplied string: quarantine PI, strip PII.
  // Uses the profile's content-processing config when set; falls back to a
  // safe default that enables both PI detection and standard PII removal.
  const sanitizeExternal = (text: string): string =>
    processContent(text, {
      quarantine: profile.contentProcessing?.quarantine ?? { enabled: true },
      sanitization: profile.contentProcessing?.sanitization ?? { preset: 'standard' },
    }).text;

  const sections: string[] = [
    `[PR FIX] The pull request at ${pod.prUrl} needs fixes (attempt ${attempt}).`,
    '',
    `Original task: ${rootTask}`,
    '',
    'Your job is to fix the failures listed below by pushing commits to the existing branch.',
    'Do NOT create a new PR — one already exists.',
    '',
  ];

  if (status.ciFailures.length > 0) {
    sections.push('## CI Check Failures\n');
    for (const ci of status.ciFailures) {
      sections.push(`### ${ci.name} (${ci.conclusion})`);
      if (ci.detailsUrl) sections.push(`Details: ${ci.detailsUrl}`);
      if (ci.annotations.length > 0) {
        sections.push('Annotations:');
        for (const ann of ci.annotations) {
          sections.push(
            `  - ${sanitizeExternal(ann.path)}: ${sanitizeExternal(ann.message)} [${ann.annotationLevel}]`,
          );
        }
      }
      sections.push('');
    }
  }

  if (status.reviewComments.length > 0) {
    sections.push('## Review Comments\n');
    for (const rc of status.reviewComments) {
      const prefix = rc.path ? `\`${sanitizeExternal(rc.path)}\`: ` : '';
      sections.push(`${prefix}${sanitizeExternal(rc.body)}`);
      sections.push('');
    }
  }

  if (userMessage) {
    sections.push('## Instructions from Reviewer\n');
    sections.push(userMessage.trim());
    sections.push('');
  }

  sections.push('After pushing your fixes, the PR will be re-evaluated automatically.');
  return sections.join('\n');
}

/** Auto-stop preview containers after this duration (default 10 minutes). */
const PREVIEW_AUTO_STOP_MS = 10 * 60 * 1000;

const execFileAsync = promisify(execFile);

// Compact Python script that performs a real MCP JSON-RPC initialize handshake
// against a stdio MCP server. Called at pod startup to verify each code-intel
// server actually starts and responds — not just that the binary exists.
// Usage: python3 <script> <command> [arg...]
// Exit 0 = server responded with a valid result; Exit 1 = timeout or error.
const MCP_INIT_PROBE_SCRIPT = `import subprocess,json,sys,select as sel
if len(sys.argv)<2:sys.exit(1)
cmd=sys.argv[1]
msg=json.dumps({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1.0"}}})
frame=b"Content-Length: "+str(len(msg.encode())).encode()+b"\\r\\n\\r\\n"+msg.encode()
p=subprocess.Popen(sys.argv[1:],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
try:
  p.stdin.write(frame);p.stdin.flush()
  h=b""
  while b"\\r\\n\\r\\n" not in h:
    if not sel.select([p.stdout],[],[],50)[0]:print(f"timeout: {cmd} did not respond to initialize",file=sys.stderr);sys.exit(1)
    c=p.stdout.read(1)
    if not c:print(f"eof: {cmd} closed stdout",file=sys.stderr);sys.exit(1)
    h+=c
  n=int(h.split(b"Content-Length: ")[1].split(b"\\r\\n")[0])
  b=b""
  while len(b)<n:
    if not sel.select([p.stdout],[],[],50)[0]:print(f"timeout: {cmd} did not send body",file=sys.stderr);sys.exit(1)
    chunk=p.stdout.read(n-len(b))
    if not chunk:print(f"eof: {cmd} closed during body",file=sys.stderr);sys.exit(1)
    b+=chunk
  r=json.loads(b)
  sys.exit(0 if "result" in r else 1)
finally:
  p.terminate();p.wait()
`;

/** Load a repo-specific code-review skill from standard locations in the worktree. */
async function loadCodeReviewSkill(
  worktreePath: string,
  log?: Logger,
): Promise<string | undefined> {
  const candidates = ['skills/code-review.md', '.claude/skills/code-review.md'];
  for (const relative of candidates) {
    const fullPath = path.join(worktreePath, relative);
    try {
      const content = await readFile(fullPath, 'utf-8');
      log?.info({ path: fullPath }, 'loaded repo-specific code-review skill');
      return content;
    } catch {
      // not found — try next
    }
  }
  return undefined;
}

/** Derive the bare repo path from an existing worktree via `git rev-parse --git-common-dir`. */
async function deriveBareRepoPath(worktreePath: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', '--git-common-dir'], {
    cwd: worktreePath,
  });
  return path.resolve(worktreePath, stdout.trim());
}

/**
 * Parses a human's response to a validation_override escalation.
 * Supports:
 *   - "dismiss" / "dismiss all" → dismiss all findings
 *   - "dismiss 1,3" → dismiss specific findings by 1-based index
 *   - Any other text → treat as guidance for all findings
 */
function parseValidationOverrideResponse(
  message: string,
  findings: ValidationFinding[],
): ValidationOverride[] {
  const trimmed = message.trim().toLowerCase();
  const now = new Date().toISOString();

  // "dismiss" or "dismiss all" → dismiss everything
  if (trimmed === 'dismiss' || trimmed === 'dismiss all') {
    return findings.map((f) => ({
      findingId: f.id,
      description: f.description,
      action: 'dismiss' as const,
      reason: message.trim(),
      createdAt: now,
    }));
  }

  // "dismiss 1,2,3" → dismiss specific indices
  const dismissMatch = trimmed.match(/^dismiss\s+([\d,\s]+)$/);
  if (dismissMatch) {
    // biome-ignore lint/style/noNonNullAssertion: dismissMatch[1] is guaranteed by regex capture group
    const indices = dismissMatch[1]!
      .split(/[,\s]+/)
      .map((s) => Number.parseInt(s, 10) - 1) // 1-based → 0-based
      .filter((i) => i >= 0 && i < findings.length);

    const indexSet = new Set(indices);
    return findings
      .filter((_, i) => indexSet.has(i))
      .map((f) => ({
        findingId: f.id,
        description: f.description,
        action: 'dismiss' as const,
        reason: message.trim(),
        createdAt: now,
      }));
  }

  // Anything else → guidance for all findings
  return findings.map((f) => ({
    findingId: f.id,
    description: f.description,
    action: 'guidance' as const,
    guidance: message.trim(),
    createdAt: now,
  }));
}

/**
 * Warn when a single-PR series pod is about to create a PR without the
 * series-level metadata it needs. With either `seriesName` or
 * `seriesDescription` missing, `buildPrTitle` falls back to using the brief's
 * task as the title and "Why" body — usually a sign that the client (CLI or
 * desktop) didn't forward `purpose.md` from the spec folder.
 */
function warnIfSinglePrSeriesMissingSeriesMeta(pod: Pod, logger: Logger): void {
  if (pod.prMode !== 'single' || !pod.seriesId) return;
  if (pod.seriesDescription && pod.seriesName) return;
  logger.warn(
    {
      podId: pod.id,
      seriesId: pod.seriesId,
      hasSeriesDescription: Boolean(pod.seriesDescription),
      hasSeriesName: Boolean(pod.seriesName),
    },
    'Single-PR series pod is missing seriesName or seriesDescription — PR title and "Why" will fall back to the brief task. Verify the client forwarded purpose.md when creating the series.',
  );
}

/** Merge new overrides into existing ones, deduplicating by findingId (latest wins). */
function mergeOverrides(
  existing: ValidationOverride[],
  incoming: ValidationOverride[],
): ValidationOverride[] {
  const map = new Map<string, ValidationOverride>();
  for (const o of existing) map.set(o.findingId, o);
  for (const o of incoming) map.set(o.findingId, o);
  return [...map.values()];
}

export interface ContainerManagerFactory {
  get(target: ExecutionTarget): ContainerManager;
}

export interface NetworkManager {
  buildNetworkConfig(
    policy: NetworkPolicy | null,
    mcpServers: InjectedMcpServer[],
    daemonGatewayIp: string,
    registries?: PrivateRegistry[],
    podId?: string,
    extraAllowedIps?: string[],
    extraAllowedDnsNames?: string[],
  ): Promise<{ networkName: string; firewallScript: string } | null>;
  getGatewayIp(podId?: string): Promise<string>;
  /** Remove the per-pod bridge — called from pod cleanup. Idempotent. */
  destroyNetworkForPod?(podId: string): Promise<void>;
}

export interface PodManagerDependencies {
  podRepo: PodRepository;
  escalationRepo: EscalationRepository;
  nudgeRepo: NudgeRepository;
  validationRepo?: ValidationRepository;
  progressEventRepo?: ProgressEventRepository;
  profileStore: ProfileStore;
  eventBus: EventBus;
  containerManagerFactory: ContainerManagerFactory;
  worktreeManager: WorktreeManager;
  runtimeRegistry: RuntimeRegistry;
  validationEngine: ValidationEngine;
  networkManager?: NetworkManager;
  /** Optional sidecar orchestrator. Pods that set `requireSidecars` need this;
   *  pods that don't aren't affected by its absence. */
  sidecarManager?: SidecarManager;
  /** Factory returning the appropriate PrManager for a given profile. Return null to skip PR creation. */
  prManagerFactory?: (profile: Profile) => PrManager | null;
  actionEngine?: {
    getAvailableActions: (
      policy: import('@autopod/shared').ActionPolicy,
    ) => import('@autopod/shared').ActionDefinition[];
  };
  actionAuditRepo?: ActionAuditRepository;
  eventRepo?: EventRepository;
  memoryRepo?: import('./memory-repository.js').MemoryRepository;
  pendingOverrideRepo?: import('./pending-override-repository.js').PendingOverrideRepository;
  enqueueSession: (podId: string) => void;
  mcpBaseUrl: string;
  daemonConfig: Pick<DaemonConfig, 'mcpServers' | 'claudeMdSections' | 'skills'>;
  /** Pending MCP ask_human requests keyed by podId — used to resolve escalations */
  pendingRequestsByPod?: Map<string, PendingRequests>;
  /** Used to generate a pod-scoped Bearer token injected into the container so it can
   * authenticate calls to the /mcp/:podId endpoint. Optional for backwards compat. */
  sessionTokenIssuer?: PodTokenIssuer;
  /** Resolve environment variable or secret by name (e.g. AZURE_GRAPH_TOKEN). */
  getSecret: (ref: string) => string | undefined;
  /** Optional repo content scanner — runs at provisioning to flag secrets/PII/injection. */
  repoScanner?: import('../security/index.js').RepoScanner;
  /** Optional scan repository — used to query the latest push scan when building PR bodies. */
  scanRepo?: import('../security/index.js').ScanRepository;
  logger: Logger;
}

export interface PodManager {
  createSession(request: CreatePodRequest, userId: string): Pod;
  processPod(podId: string): Promise<void>;
  consumeAgentEvents(podId: string, events: AsyncIterable<AgentEvent>): Promise<void>;
  handleCompletion(podId: string): Promise<void>;
  sendMessage(podId: string, message: string): Promise<void>;
  notifyEscalation(podId: string, escalation: EscalationRequest): void;
  touchHeartbeat(podId: string): void;
  approveSession(podId: string, options?: { squash?: boolean }): Promise<void>;
  rejectSession(podId: string, reason?: string): Promise<void>;
  approveAllValidated(): Promise<{ approved: string[] }>;
  killAllFailed(): Promise<{ killed: string[] }>;
  extendAttempts(podId: string, additionalAttempts: number): Promise<void>;
  /** Apply queued overrides to the last validation result without re-running validation.
   *  If overrides make the result pass, transitions review_required → validated. */
  applyOverridesInstant(podId: string): Promise<{ advanced: boolean }>;
  /** Bypass validation and transition the pod directly to validated.
   *  Valid from failed or review_required. The pod then awaits normal approval. */
  forceApprove(podId: string, reason?: string): Promise<void>;
  extendPrAttempts(podId: string, additionalAttempts: number): Promise<void>;
  pauseSession(podId: string): Promise<void>;
  nudgeSession(podId: string, message: string): void;
  killSession(podId: string): Promise<void>;
  completeSession(
    podId: string,
    options?: {
      promoteTo?: 'pr' | 'branch' | 'artifact' | 'none';
      instructions?: string;
    },
  ): Promise<{ pushError?: string; promotedTo?: 'pr' | 'branch' | 'artifact' | 'none' }>;
  /** Promote an interactive pod to auto on the same pod ID.
   *  `options.instructions` is the raw human-typed handoff text from the desktop sheet
   *  (or `--instructions` on the CLI); persisted as `handoffInstructions` and consumed
   *  by the recovery restart to compose the agent-facing `## Handoff` section. */
  promoteToAuto(
    podId: string,
    targetOutput: 'pr' | 'branch' | 'artifact' | 'none',
    options?: { instructions?: string },
  ): Promise<void>;
  triggerValidation(podId: string, options?: { force?: boolean }): Promise<void>;
  /** Pull latest from remote branch and re-run validation without agent rework on failure.
   *  Used after human fixes via a linked workspace pod. */
  revalidateSession(podId: string): Promise<{ newCommits: boolean; result: 'pass' | 'fail' }>;
  /** Create a linked workspace pod on the same branch as a failed worker pod for human fixes. */
  fixManually(podId: string, userId: string): Pod;
  createHistoryWorkspace(profileName: string, userId: string, historyQuery: HistoryQuery): Pod;
  createMemoryWorkspace(profileName: string, userId: string): Pod;
  deleteSession(podId: string): Promise<void>;
  startPreview(podId: string): Promise<{ previewUrl: string }>;
  stopPreview(podId: string): Promise<void>;
  getSession(podId: string): Pod;
  listSessions(filters?: {
    profileName?: string;
    status?: PodStatus;
    userId?: string;
  }): Pod[];
  getSessionStats(filters?: { profileName?: string }): PodStats;
  getValidationHistory(podId: string): import('./validation-repository.js').StoredValidation[];
  /**
   * Resolve the *real* injected MCP server configs for a pod — daemon-wide
   * defaults merged with the pod profile's servers, with original URLs and
   * auth headers preserved. Consumed by the MCP proxy handler to forward
   * requests on the agent's behalf.
   */
  getInjectedMcpServers(podId: string): InjectedMcpServer[];
  /**
   * Re-apply network policy to all running local containers using the given profile.
   * Called after a profile's networkPolicy is updated via the API.
   * Fire-and-forget safe — errors are logged but do not propagate.
   */
  refreshNetworkPolicy(profileName: string): Promise<void>;
  /** Abort a currently running validation for the given pod. No-op if not validating. */
  interruptValidation(podId: string): void;
  /** Toggle skip-validation at runtime. When true, the next validation result is bypassed → validated. */
  setSkipValidation(podId: string, skip: boolean): void;
  /**
   * Inject provider credentials directly into a running container without exposing the token.
   * Reads the PAT from the profile, runs the auth command inside the container, and deletes
   * the temp credential file. Safe to call from user-initiated flows (workspace pods, CLI).
   */
  injectCredential(podId: string, service: 'github' | 'ado'): Promise<void>;
  /** Install gh or az CLI into a running pod container without touching credentials. */
  installCliTool(podId: string, tool: 'gh' | 'az'): Promise<void>;
  /**
   * Manually spawn a fix pod for a merge_pending or complete pod, bypassing the
   * automatic detection guards. Clears any stale fixPodId first so the fix
   * is created immediately rather than waiting for the next poll cycle.
   * Bumps maxPrFixAttempts if the current cap would otherwise block spawn.
   * Optional userMessage is prepended to the fix task as reviewer instructions.
   */
  spawnFixSession(podId: string, userMessage?: string): Promise<void>;
  /**
   * Retry PR creation for a complete pod whose PR was never successfully created.
   * Updates prUrl on success. Throws if the pod is not complete or already has a PR.
   */
  retryCreatePr(podId: string): Promise<void>;
  /** Return all pods belonging to a series, ordered by creation time. */
  getSeriesPods(seriesId: string): Pod[];
  /**
   * Re-trigger any `queued` dependent pods whose all parents have already
   * reached a terminal-success state (validated/approved/complete/etc.).
   * Call on daemon startup to recover series that got stuck across restarts
   * or due to a missing `maybeTriggerDependents` call.
   */
  rehydrateDependentSessions(): void;
  /**
   * Attempt to recover a pod whose worktree was marked compromised by the deletion guard.
   * Pulls files from the container (which must still be running), repopulates the worktree,
   * and retries the auto-commit. Clears `worktreeCompromised` on success.
   */
  recoverWorktree(podId: string): Promise<{ recovered: boolean; message: string }>;
}

export function createPodManager(deps: PodManagerDependencies): PodManager {
  const {
    podRepo,
    escalationRepo,
    nudgeRepo,
    profileStore,
    eventBus,
    containerManagerFactory,
    worktreeManager,
    runtimeRegistry,
    validationEngine,
    networkManager,
    sidecarManager,
    prManagerFactory,
    enqueueSession,
    mcpBaseUrl,
    daemonConfig,
    logger,
    validationRepo,
    progressEventRepo,
    repoScanner,
    scanRepo,
  } = deps;

  /** Destroy the per-pod Docker bridge. Must be called AFTER the pod + all
   *  sidecars are killed, otherwise Docker refuses with "has active endpoints".
   *  No-ops when the network manager doesn't support teardown (tests / older
   *  implementations) or isn't wired. Never throws. */
  async function destroyPodNetwork(podId: string): Promise<void> {
    if (!networkManager?.destroyNetworkForPod) return;
    try {
      await networkManager.destroyNetworkForPod(podId);
    } catch (err) {
      logger.warn({ err, podId }, 'Failed to destroy pod network');
    }
  }

  /** Pre-push security scan helper. Runs the repo scanner at the `push`
   *  checkpoint and acts on the decision:
   *   - `block` (non-workspace) → throws AutopodError; the pod's outer handler
   *     fails the pod and the operator sees the findings in the audit table.
   *   - `block` for workspace pods → engine rewrites to `escalate`; we log
   *     loudly but do not fail the push.
   *   - `warn`/`escalate` → emit a status event; PR-body integration picks up
   *     the persisted findings via scanRepo at createPr time.
   *  No-ops when the scanner is not wired or the pod has no worktree. */
  async function runPushCheckpointScan(pod: Pod, profile: Profile): Promise<void> {
    if (!repoScanner || !pod.worktreePath) return;
    try {
      const baseRef = `origin/${pod.baseBranch ?? profile.defaultBranch ?? 'main'}`;
      const isWorkspacePod = pod.options.agentMode === 'interactive';
      emitActivityStatus(pod.id, 'Running pre-push security scan…');
      const scan = await repoScanner.scan('push', {
        podId: pod.id,
        workdir: pod.worktreePath,
        baseRef,
        profile,
        isWorkspacePod,
      });
      logger.info(
        {
          podId: pod.id,
          decision: scan.decision,
          findings: scan.findings.length,
          filesScanned: scan.filesScanned,
          filesSkipped: scan.filesSkipped,
        },
        'Pre-push security scan completed',
      );
      if (scan.decision === 'block') {
        throw new AutopodError(
          `Pre-push security scan blocked (${scan.findings.length} finding(s))`,
          'SECURITY_SCAN_BLOCKED',
          400,
        );
      }
      if (scan.decision === 'escalate') {
        logger.warn(
          { podId: pod.id, findings: scan.findings.length },
          'Pre-push security scan flagged content; review the PR body and security_scans table',
        );
      }
    } catch (err) {
      if (err instanceof AutopodError) throw err;
      // Fail open — scanner errors must not gate validation entry.
      logger.warn({ err, podId: pod.id }, 'Pre-push security scan errored — proceeding');
    }
  }

  /** Look up persisted security findings from the most recent push-checkpoint
   *  scan for a pod, for inclusion in the PR body. Returns [] when the scanRepo
   *  is not wired or no scan ran. */
  function getLatestPushFindings(podId: string): import('@autopod/shared').ScanFinding[] {
    if (!scanRepo) return [];
    try {
      const scans = scanRepo.getForPod(podId);
      const pushScans = scans.filter((s) => s.checkpoint === 'push');
      const latest = pushScans[pushScans.length - 1];
      return latest?.findings ?? [];
    } catch (err) {
      logger.warn({ err, podId }, 'Failed to load security findings for PR body');
      return [];
    }
  }

  /** Tear down all sidecars attached to a pod. Re-reads the pod so it sees
   *  the most recent `sidecarContainerIds` even if the caller's snapshot is
   *  stale. No-ops if the pod never spawned any, or if no SidecarManager is
   *  configured (older deployments). Never throws — failures are logged. */
  async function killSidecarsForPod(podId: string): Promise<void> {
    if (!sidecarManager) return;
    let current: Pod;
    try {
      current = podRepo.getOrThrow(podId);
    } catch {
      return;
    }
    const ids = current.sidecarContainerIds;
    if (!ids) return;
    await Promise.allSettled(
      Object.entries(ids).map(async ([name, containerId]) => {
        try {
          await sidecarManager.kill(containerId);
        } catch (err) {
          logger.warn({ err, podId, sidecarName: name, containerId }, 'Failed to kill sidecar');
        }
      }),
    );
    podRepo.update(podId, { sidecarContainerIds: null });
  }

  /** Delete any branches this pod pushed to the test repo via
   *  `ado.run_test_pipeline`. Best-effort — network failures or already-deleted
   *  branches are logged, not thrown. Cleared from the DB afterwards so a
   *  cron-level sweep can see "this pod has no pending test branches".
   */
  async function cleanupTestRunBranches(podId: string): Promise<void> {
    let current: Pod;
    try {
      current = podRepo.getOrThrow(podId);
    } catch {
      return;
    }
    const branches = current.testRunBranches;
    if (!branches || branches.length === 0) return;
    const profile = profileStore.get(current.profileName);
    const cfg = profile.testPipeline;
    if (!cfg || !cfg.enabled || !profile.adoPat) {
      podRepo.update(podId, { testRunBranches: null });
      return;
    }
    const authedUrl = new URL(cfg.testRepo);
    authedUrl.username = 'x-access-token';
    authedUrl.password = profile.adoPat;
    const authedUrlStr = authedUrl.toString();
    if (!current.worktreePath) {
      // No worktree to run git from. Can't delete; leave a daily sweep to reap.
      logger.warn({ podId, branches }, 'Cannot cleanup test-run branches — pod has no worktree');
      podRepo.update(podId, { testRunBranches: null });
      return;
    }
    await Promise.allSettled(
      branches.map(async (branch) => {
        try {
          await execFileAsync(
            'git',
            ['-C', current.worktreePath as string, 'push', authedUrlStr, '--delete', branch],
            { timeout: 30_000 },
          );
        } catch (err) {
          logger.warn({ err, podId, branch }, 'Failed to delete test-run branch');
        }
      }),
    );
    podRepo.update(podId, { testRunBranches: null });
  }

  /** Active auto-stop timers for preview containers, keyed by podId. */
  const previewTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Active commit polling intervals, keyed by podId. */
  const commitPollers = new Map<string, ReturnType<typeof setInterval>>();

  const COMMIT_POLL_INTERVAL_MS = 60_000;

  /** Active merge polling intervals, keyed by podId. */
  const mergePollers = new Map<string, ReturnType<typeof setInterval>>();

  const MERGE_POLL_INTERVAL_MS = 60_000;

  /** Active AbortControllers for in-progress validation runs, keyed by podId. */
  const validationAbortControllers = new Map<string, AbortController>();

  /**
   * Returns the pod whose branch/baseBranch/prUrl a fix pod should inherit.
   *
   * In single-PR series, the triggering pod (`parent`) may not be the PR
   * owner — the PR was opened by one specific pod in the series, and the
   * fix pod must operate on that pod's branch or its commits land
   * on a branch that isn't attached to the PR. Throws if the series has
   * no PR-owning pod yet (fix-spawn is meaningless in that case).
   *
   * For non-`single` modes, returns `parent` unchanged: stacked pods own
   * their own PR per pod, and standalone pods are their own PR owner.
   */
  const resolveBranchSource = (parent: Pod): Pod => {
    if (parent.prMode !== 'single') return parent;
    if (!parent.seriesId) {
      throw new AutopodError(
        `Pod ${parent.id} has prMode='single' but no seriesId — cannot resolve PR owner`,
        'INVALID_STATE',
        500,
      );
    }
    const seriesPods = podRepo.getPodsBySeries(parent.seriesId);
    const prOwners = seriesPods.filter((p) => p.prUrl);
    if (prOwners.length === 0) {
      throw new AutopodError(
        `Cannot spawn fix pod for pod ${parent.id}: no pod in series ${parent.seriesId} owns a PR yet`,
        'INVALID_STATE',
        409,
      );
    }
    let prOwner = prOwners[0] as Pod;
    if (prOwners.length > 1) {
      const matching = parent.prUrl ? prOwners.find((p) => p.prUrl === parent.prUrl) : undefined;
      prOwner = matching ?? prOwner;
      logger.warn(
        {
          podId: parent.id,
          seriesId: parent.seriesId,
          prOwnerCount: prOwners.length,
          chosenPodId: prOwner.id,
        },
        'Single-mode series has multiple PR-owning pods — picked one deterministically',
      );
    }
    if (prOwner.id !== parent.id) {
      logger.info(
        {
          podId: parent.id,
          prOwnerId: prOwner.id,
          prOwnerBranch: prOwner.branch,
          triggeringBranch: parent.branch,
        },
        'Fix pod redirected to PR-owning pod in single-mode series',
      );
    }
    return prOwner;
  };

  /**
   * Spawns a new child fix pod on the same branch when the PR has actionable
   * failures (CI check failures or CHANGES_REQUESTED review comments).
   * Guards against double-spawning and enforces maxPrFixAttempts.
   * Lifted to outer scope so both the merge poller and spawnFixSession can call it.
   */
  const maybeSpawnFixSession = async (
    parentSessionId: string,
    status: PrMergeStatus,
    userMessage?: string,
    bypassCooldown = false,
  ): Promise<void> => {
    // Re-read from DB to avoid stale closure state across 60s intervals
    const parent = podRepo.getOrThrow(parentSessionId);

    // Guard: fix pods must never spawn sub-fixers.
    // The root parent's merge poller owns all fix-spawn decisions.
    if (parent.linkedPodId) {
      logger.debug({ podId: parentSessionId }, 'Fix pod — skipping sub-fixer spawn');
      return;
    }

    // Guard: a fix pod is already alive
    if (parent.fixPodId) {
      try {
        const fix = podRepo.getOrThrow(parent.fixPodId);
        const fixIsLive =
          fix.status !== 'complete' && fix.status !== 'killed' && fix.status !== 'failed';
        if (fixIsLive) {
          logger.debug(
            { podId: parentSessionId, fixPodId: parent.fixPodId },
            'Fix pod already active — skipping spawn',
          );
          return;
        }
      } catch {
        // Fix pod not found — treat as terminal, fall through
      }
      // Clear stale fixPodId and return — let the *next* poll cycle decide whether
      // to spawn. This gives CI time to restart and re-run on the fix's new commits
      // before we evaluate failures again (e.g. SonarCloud takes a full rebuild).
      podRepo.update(parentSessionId, { fixPodId: null });
      return;
    }

    // Guard: max retries exhausted
    const maxAttempts = parent.maxPrFixAttempts ?? DEFAULT_MAX_PR_FIX_ATTEMPTS;
    if ((parent.prFixAttempts ?? 0) >= maxAttempts) {
      emitActivityStatus(
        parentSessionId,
        `Max PR fix attempts (${maxAttempts}) exhausted — pod failed`,
      );
      transition(parent, 'failed', {
        mergeBlockReason: `Max PR fix attempts (${maxAttempts}) exhausted`,
      });
      stopMergePolling(parentSessionId);
      logger.warn(
        { podId: parentSessionId, attempts: parent.prFixAttempts },
        'Merge polling: max fix attempts exhausted — pod failed',
      );
      return;
    }

    // Guard: per-parent cooldown (10 minutes between fix-pod spawns)
    // Prevents a fast-failing CI from burning all fix attempts in a single burst.
    // Manual user-triggered spawns bypass — the user is the explicit override,
    // and skipping silently here would also drop their userMessage on the floor.
    const FIX_POD_COOLDOWN_MS = 10 * 60 * 1_000;
    if (!bypassCooldown && parent.lastFixPodSpawnedAt) {
      const elapsed = Date.now() - new Date(parent.lastFixPodSpawnedAt).getTime();
      if (elapsed < FIX_POD_COOLDOWN_MS) {
        const remainingSec = Math.ceil((FIX_POD_COOLDOWN_MS - elapsed) / 1_000);
        logger.debug(
          { podId: parentSessionId, remainingSec },
          'Merge polling: fix-pod cooldown active — skipping spawn',
        );
        return;
      }
    }

    // Build fix task and create child pod directly using closure deps
    const newAttempt = (parent.prFixAttempts ?? 0) + 1;
    const profile = profileStore.get(parent.profileName);
    const fixTask = buildPrFixTask(parent, status, podRepo, profile, userMessage);

    // In a single-PR series, all pods share the root's branch but only the
    // PR-owning pod has prUrl set. The triggering pod's `branch` field can
    // diverge from the PR's actual source branch (e.g. last pod was created
    // with its own branch instead of inheriting), so resolve the PR owner
    // and take branch/baseBranch/prUrl from it. Other prModes own their own
    // PR per pod, so the parent's fields are correct.
    const branchSource = resolveBranchSource(parent);

    let fixId = '';
    for (let attempt = 0; attempt < 10; attempt++) {
      fixId = generatePodId();
      try {
        podRepo.insert({
          id: fixId,
          profileName: parent.profileName,
          task: fixTask,
          status: 'queued',
          model: parent.model,
          runtime: parent.runtime,
          executionTarget: parent.executionTarget,
          branch: branchSource.branch,
          userId: parent.userId,
          maxValidationAttempts: profile.maxValidationAttempts ?? 3,
          skipValidation: false,
          options: parent.options,
          outputMode: parent.outputMode,
          baseBranch: branchSource.baseBranch ?? null,
          linkedPodId: parent.id,
          pimGroups: parent.pimGroups ?? null,
          prUrl: branchSource.prUrl ?? null,
        });
        break;
      } catch (err: unknown) {
        if (
          err instanceof Error &&
          err.message.includes('UNIQUE constraint failed') &&
          attempt < 9
        ) {
          continue;
        }
        throw err;
      }
    }

    enqueueSession(fixId);
    eventBus.emit({
      type: 'pod.created',
      timestamp: new Date().toISOString(),
      pod: {
        id: fixId,
        profileName: parent.profileName,
        task: fixTask,
        status: 'queued',
        model: parent.model,
        runtime: parent.runtime,
        duration: null,
        filesChanged: 0,
        createdAt: new Date().toISOString(),
      },
    });

    // Record fix pod on parent (including cooldown timestamp)
    podRepo.update(parentSessionId, {
      prFixAttempts: newAttempt,
      fixPodId: fixId,
      lastFixPodSpawnedAt: new Date().toISOString(),
      mergeBlockReason: `Fix attempt ${newAttempt}/${maxAttempts} in progress (pod ${fixId})`,
    });

    emitActivityStatus(
      parentSessionId,
      `Spawned fix pod ${fixId} (attempt ${newAttempt}/${maxAttempts})`,
    );
    logger.info(
      { podId: parentSessionId, fixPodId: fixId, attempt: newAttempt },
      'Merge polling: spawned fix pod for actionable failures',
    );
  };

  /** Start polling PR merge status for a pod in merge_pending state. */
  function startMergePolling(podId: string): void {
    stopMergePolling(podId);

    const poll = async () => {
      try {
        const pod = podRepo.getOrThrow(podId);
        if (pod.status !== 'merge_pending') {
          stopMergePolling(podId);
          return;
        }

        if (!pod.prUrl) {
          stopMergePolling(podId);
          return;
        }

        const profile = profileStore.get(pod.profileName);
        const prManager = prManagerFactory ? prManagerFactory(profile) : null;
        if (!prManager) {
          stopMergePolling(podId);
          return;
        }

        const status = await prManager.getPrStatus({
          prUrl: pod.prUrl,
          worktreePath: pod.worktreePath ?? undefined,
        });

        if (status.merged) {
          emitActivityStatus(podId, 'PR merged successfully');
          const mergedPod = transition(pod, 'complete', {
            completedAt: new Date().toISOString(),
            mergeBlockReason: null,
          });

          eventBus.emit({
            type: 'pod.completed',
            timestamp: new Date().toISOString(),
            podId,
            finalStatus: 'complete',
            summary: {
              id: podId,
              profileName: pod.profileName,
              task: pod.task,
              status: 'complete',
              model: pod.model,
              runtime: pod.runtime,
              duration: pod.startedAt ? Date.now() - new Date(pod.startedAt).getTime() : null,
              filesChanged: pod.filesChanged,
              createdAt: pod.createdAt,
            },
          });

          logger.info({ podId, prUrl: pod.prUrl }, 'Merge polling: PR merged — pod complete');
          stopMergePolling(podId);
          maybeTriggerDependents(mergedPod);
          return;
        }

        if (!status.open) {
          emitActivityStatus(
            podId,
            `PR closed without merging: ${status.blockReason ?? 'unknown reason'}`,
          );
          transition(pod, 'failed', { mergeBlockReason: status.blockReason });
          logger.warn(
            { podId, prUrl: pod.prUrl, reason: status.blockReason },
            'Merge polling: PR closed — pod failed',
          );
          stopMergePolling(podId);
          return;
        }

        // Still pending — update block reason if it changed
        if (status.blockReason !== pod.mergeBlockReason) {
          podRepo.update(podId, { mergeBlockReason: status.blockReason });
          emitActivityStatus(podId, `Merge pending: ${status.blockReason}`);
        }

        // Detect actionable failures and potentially spawn a fix pod
        const hasActionableFailures =
          status.ciFailures.length > 0 || status.reviewComments.length > 0;
        if (hasActionableFailures) {
          await maybeSpawnFixSession(podId, status);
        }
      } catch (err) {
        logger.debug({ err, podId }, 'Merge polling failed, skipping cycle');
      }
    };

    // Run first poll immediately
    poll();
    const interval = setInterval(poll, MERGE_POLL_INTERVAL_MS);
    interval.unref();
    mergePollers.set(podId, interval);
  }

  /** Stop merge polling for a pod. */
  function stopMergePolling(podId: string): void {
    const interval = mergePollers.get(podId);
    if (interval) {
      clearInterval(interval);
      mergePollers.delete(podId);
    }
  }

  /** Resume merge polling for any pods left in merge_pending state (e.g. after daemon restart). */
  function resumeMergePolling(): void {
    const pendingSessions = podRepo.list({ status: 'merge_pending' as PodStatus });
    for (const pod of pendingSessions) {
      logger.info({ podId: pod.id, prUrl: pod.prUrl }, 'Resuming merge polling after restart');
      startMergePolling(pod.id);
    }
  }

  // Resume merge polling on startup
  resumeMergePolling();

  /** Start polling git commit count inside a running container. */
  function startCommitPolling(podId: string): void {
    stopCommitPolling(podId);

    /** Capture the starting HEAD SHA so we only count commits the agent makes. */
    const captureStartSha = async () => {
      try {
        const pod = podRepo.getOrThrow(podId);
        if (pod.startCommitSha || !pod.containerId) return;
        const cm = containerManagerFactory.get(pod.executionTarget);
        const shaResult = await cm.execInContainer(pod.containerId, ['git', 'rev-parse', 'HEAD'], {
          cwd: '/workspace',
          timeout: 5_000,
        });
        if (shaResult.exitCode === 0 && shaResult.stdout.trim()) {
          podRepo.update(podId, { startCommitSha: shaResult.stdout.trim() });
        }
      } catch {
        logger.debug({ podId }, 'Failed to capture start commit SHA');
      }
    };

    const poll = async () => {
      try {
        const pod = podRepo.getOrThrow(podId);
        if (!pod.containerId || pod.status !== 'running') {
          stopCommitPolling(podId);
          return;
        }
        // Use startCommitSha if available; fall back to baseBranch for old pods
        const exclusionRef = pod.startCommitSha ?? pod.baseBranch ?? 'main';
        const cm = containerManagerFactory.get(pod.executionTarget);
        const [countResult, timeResult] = await Promise.all([
          cm.execInContainer(
            pod.containerId,
            ['git', 'rev-list', '--count', 'HEAD', `^${exclusionRef}`],
            { cwd: '/workspace', timeout: 5_000 },
          ),
          cm.execInContainer(pod.containerId, ['git', 'log', '-1', '--format=%cI'], {
            cwd: '/workspace',
            timeout: 5_000,
          }),
        ]);
        const commitCount = Number.parseInt(countResult.stdout.trim(), 10) || 0;
        const lastCommitAt = timeResult.exitCode === 0 ? timeResult.stdout.trim() : null;
        podRepo.update(podId, { commitCount, lastCommitAt });
      } catch {
        // Silently skip — container may be busy or gone
        logger.debug({ podId }, 'Commit polling failed, skipping cycle');
      }
    };
    // Capture starting SHA first, then run first poll immediately
    captureStartSha().then(() => poll());
    const interval = setInterval(poll, COMMIT_POLL_INTERVAL_MS);
    interval.unref();
    commitPollers.set(podId, interval);
  }

  /** Stop commit polling for a pod. */
  function stopCommitPolling(podId: string): void {
    const interval = commitPollers.get(podId);
    if (interval) {
      clearInterval(interval);
      commitPollers.delete(podId);
    }
  }

  /** Cancel and remove an auto-stop timer for a pod if one exists. */
  function clearPreviewTimer(podId: string): void {
    const timer = previewTimers.get(podId);
    if (timer) {
      clearTimeout(timer);
      previewTimers.delete(podId);
    }
  }

  /** Schedule an auto-stop timer that will stop the container after PREVIEW_AUTO_STOP_MS. */
  function schedulePreviewAutoStop(
    podId: string,
    containerId: string,
    target: import('@autopod/shared').ExecutionTarget,
  ): void {
    clearPreviewTimer(podId);
    const timer = setTimeout(async () => {
      previewTimers.delete(podId);
      try {
        const cm = containerManagerFactory.get(target);
        await cm.stop(containerId);
        logger.info({ podId, containerId }, 'Preview auto-stopped after timeout');
      } catch (err) {
        logger.warn({ err, podId }, 'Failed to auto-stop preview container');
      }
    }, PREVIEW_AUTO_STOP_MS);
    // Unref so the timer doesn't prevent process exit
    timer.unref();
    previewTimers.set(podId, timer);
  }

  /**
   * Build provider env for resume calls.
   *
   * Two providers need fresh env on resume:
   *  - `max` — Claude Code rotates OAuth tokens during use; persist the
   *    container's latest creds back to the store, then re-issue.
   *  - `foundry` (token-auth) — Entra access tokens last ~60-90 minutes,
   *    so for long-running pods the secret file goes stale. Re-acquire via
   *    `getAzureToken` (cached if still valid) and rewrite the secret file.
   *    Only kicks in when the profile has no static apiKey configured.
   */
  async function getResumeEnv(pod: Pod): Promise<Record<string, string> | undefined> {
    const profile = profileStore.get(pod.profileName);
    const provider = profile.modelProvider;
    if (provider !== 'max' && provider !== 'foundry') return undefined;

    // Foundry only needs refresh when using bearer-token auth (no static apiKey).
    if (provider === 'foundry') {
      const creds = profile.providerCredentials;
      if (!creds || creds.provider !== 'foundry' || creds.apiKey) {
        return undefined;
      }
    }

    // MAX-specific: recover rotated tokens from the container before refresh.
    // The container is the source of truth — Claude Code rotates tokens during use
    // and writes them to ~/.claude/.credentials.json. If our earlier persistence
    // missed the update, the profile store has a stale (already-invalidated) refresh
    // token and the OAuth refresh will fail with invalid_grant.
    if (provider === 'max' && pod.containerId) {
      try {
        await persistRefreshedCredentials(
          pod.containerId,
          containerManagerFactory.get(pod.executionTarget),
          profileStore,
          pod.profileName,
          logger,
        );
      } catch (err) {
        logger.warn(
          { err, podId: pod.id },
          'Could not recover credentials from container before resume — will try profile store',
        );
      }
    }

    const result = await buildProviderEnv(profile, pod.id, logger);
    // Re-write credential files to container in case tokens were rotated.
    // For Foundry token-auth this also rewrites the bearer-token secret file
    // with whatever getAzureToken returned (cached if still valid, else fresh).
    if (pod.containerId) {
      const cm = containerManagerFactory.get(pod.executionTarget);
      for (const file of result.containerFiles) {
        await cm.writeFile(pod.containerId, file.path, file.content);
      }
      for (const sf of result.secretFiles) {
        await cm.writeFile(pod.containerId, sf.path, sf.content);
        await cm.execInContainer(pod.containerId, ['chmod', '0400', sf.path], { timeout: 5_000 });
      }
    }
    return { POD_ID: pod.id, ...result.env };
  }

  function touchHeartbeat(podId: string): void {
    try {
      podRepo.update(podId, { lastHeartbeatAt: new Date().toISOString() });
    } catch {
      // Best-effort — don't crash on heartbeat failures
    }
  }

  /**
   * Copy workspace changes from container back to the host worktree (bind mount).
   * The worktree is bind-mounted at /mnt/worktree while the agent works on the
   * container's native /workspace (overlayfs) — this avoids VirtioFS getcwd() bugs
   * on Docker Desktop for Mac. We sync back before any host-side git operations.
   *
   * Strategy:
   *  1. Read the bare repo path from /workspace/.git/objects/info/alternates (written by the
   *     gitlink→real-dir conversion at container start).
   *  2. Push new commits from /workspace to the bare so host git sees them after sync.
   *  3. Sync files back excluding .git — the host worktree's gitlink is preserved.
   *
   * If the container is already stopped, falls back to Docker's archive API. In that case
   * we extract /workspace (minus .git) then extract /workspace/.git separately and push
   * from the host side.
   */
  async function syncWorkspaceBack(
    containerId: string,
    worktreePath: string,
    cm: ContainerManager,
  ): Promise<{ pushed: boolean }> {
    let pushed = false;
    try {
      // Read the bare repo path from the alternates file written during gitlink conversion.
      // Alternates contains "<bareRepoPath>/objects" — strip the trailing "/objects".
      const alternatesResult = await cm.execInContainer(
        containerId,
        [
          'sh',
          '-c',
          "sed 's|/objects$||' /workspace/.git/objects/info/alternates 2>/dev/null | head -1 || true",
        ],
        { timeout: 5_000 },
      );
      const bareRepoPath =
        alternatesResult.exitCode === 0 && alternatesResult.stdout.trim()
          ? alternatesResult.stdout.trim()
          : null;

      // Push new commits to the bare before clearing the bind mount, so any commits made
      // inside the container are visible to host-side git operations after sync.
      if (bareRepoPath) {
        // Validate the container-supplied path against the daemon-derived path to
        // prevent an adversarial agent from injecting a different remote via the alternates file.
        let expectedBareRepoPath: string | null = null;
        try {
          expectedBareRepoPath = await deriveBareRepoPath(worktreePath);
        } catch {
          // If we can't derive the expected path, skip the push (fail safe).
        }
        if (!expectedBareRepoPath || bareRepoPath !== expectedBareRepoPath) {
          logger.warn(
            { worktreePath, bareRepoPath, expectedBareRepoPath },
            'Bare repo path from container does not match daemon-derived path — skipping in-container push',
          );
        } else {
          const push = await cm.execInContainer(
            containerId,
            ['git', '-C', '/workspace', 'push', bareRepoPath, 'HEAD'],
            { timeout: 30_000 },
          );
          if (push.exitCode === 0) {
            pushed = true;
          } else {
            // Surface as pushed=false rather than throwing. A non-fast-forward rejection
            // (e.g. from a stale /workspace/.git seam) won't be helped by the archive-API
            // fallback below — it'd push the same git history. The caller uses pushed=false
            // to clamp auto-commit's deletion guard so a partially-synced worktree can't
            // get swept into a single bogus chore commit via `git add -A`.
            logger.warn(
              { worktreePath, stderr: push.stderr.trim() },
              'Git push to bare during sync-back failed — agent commits not on host branch',
            );
          }
        }
      }

      // Sync files back, excluding .git so the host gitlink is never overwritten.
      await cm.execInContainer(
        containerId,
        [
          'sh',
          '-c',
          "find /mnt/worktree -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf {} + ; find /workspace -mindepth 1 -maxdepth 1 ! -name '.git' -exec cp -a {} /mnt/worktree/ \\;",
        ],
        { timeout: 120_000 },
      );
    } catch (err) {
      // Fall back to the Docker archive API on any exec failure — getArchive() works on both
      // running and stopped (but not yet removed) containers. Previously only 409
      // (stopped-container) errors triggered this path; timeouts from VirtioFS stalls on
      // Docker Desktop for Mac or large workspace copies silently re-threw, which left the
      // host worktree partially populated and caused the deletion guard to fire.
      logger.warn(
        { err, worktreePath },
        'In-container sync command failed — falling back to archive API extraction',
      );

      // Extract workspace files excluding .git so the host gitlink is preserved.
      await cm.extractDirectoryFromContainer(containerId, '/workspace', worktreePath, ['.git']);

      // Try to recover commits: extract the container's .git to a temp dir and push to bare.
      let bareRepoPath: string | null = null;
      try {
        // Host worktree gitlink is intact (we excluded .git above), so we can derive the path.
        bareRepoPath = await deriveBareRepoPath(worktreePath);
      } catch {
        // Best-effort — if we can't get the bare path, commit recovery is skipped.
      }
      if (bareRepoPath) {
        const tmpGitDir = path.join(os.tmpdir(), `autopod-git-${Date.now()}`);
        try {
          await mkdir(tmpGitDir, { recursive: true });
          // Extract /workspace/.git into tmpGitDir — the alternates inside point at the bare,
          // so git can resolve baseline objects and push only the new ones.
          await cm.extractDirectoryFromContainer(containerId, '/workspace/.git', tmpGitDir);
          await execFileAsync('git', ['--git-dir', tmpGitDir, 'push', bareRepoPath, 'HEAD']);
          pushed = true;
        } catch (gitRecoveryErr) {
          logger.warn(
            { err: gitRecoveryErr, worktreePath },
            'Could not push commits from container during sync fallback — new commits may be lost',
          );
        } finally {
          await rm(tmpGitDir, { recursive: true, force: true }).catch(() => {});
        }
      }
    }
    return { pushed };
  }

  /**
   * Attempt to recover a partially-synced host worktree by pulling files directly from a
   * still-running container. Returns true on success, false if the container is gone or the
   * extraction fails (caller should fall through to the compromised path).
   */
  async function recoverWorktreeFromContainer(
    containerId: string,
    worktreePath: string,
    cm: ContainerManager,
  ): Promise<boolean> {
    try {
      const status = await cm.getStatus(containerId);
      if (status !== 'running') {
        logger.warn(
          { containerId, worktreePath },
          'Cannot recover worktree — container not running',
        );
        return false;
      }

      // Push any commits the agent made inside the container to the bare repo first.
      const alternatesResult = await cm.execInContainer(
        containerId,
        [
          'sh',
          '-c',
          "sed 's|/objects$||' /workspace/.git/objects/info/alternates 2>/dev/null | head -1 || true",
        ],
        { timeout: 5_000 },
      );
      const containerBareRepoPath =
        alternatesResult.exitCode === 0 && alternatesResult.stdout.trim()
          ? alternatesResult.stdout.trim()
          : null;

      if (containerBareRepoPath) {
        let expectedBareRepoPath: string | null = null;
        try {
          expectedBareRepoPath = await deriveBareRepoPath(worktreePath);
        } catch {}
        if (expectedBareRepoPath && containerBareRepoPath === expectedBareRepoPath) {
          const push = await cm.execInContainer(
            containerId,
            ['git', '-C', '/workspace', 'push', containerBareRepoPath, 'HEAD'],
            { timeout: 30_000 },
          );
          if (push.exitCode !== 0) {
            logger.warn(
              { worktreePath, stderr: push.stderr },
              'Git push during worktree recovery failed — commits may not be fully visible on host',
            );
          }
        }
      }

      await cm.extractDirectoryFromContainer(containerId, '/workspace', worktreePath, ['.git']);
      logger.info({ containerId, worktreePath }, 'Worktree repopulated from live container');
      return true;
    } catch (err) {
      logger.warn({ err, containerId, worktreePath }, 'Live container worktree recovery failed');
      return false;
    }
  }

  // Injects provider credentials into a running container without exposing the token.
  //
  // Strategy:
  //   1. Always wire up git credential.helper — covers `git push/pull/fetch/clone` (90% of use cases).
  //      This is the must-have and almost always succeeds.
  //   2. Best-effort install + authenticate the CLI tool (gh / az). If it fails, we log a warning
  //      and still return success, because git operations work without it. Users who need the CLI
  //      can install it manually inside the container.
  //
  // Returns a human-readable status describing what worked.
  async function performCredentialInjection(
    podId: string,
    service: 'github' | 'ado',
  ): Promise<string> {
    const pod = podRepo.getOrThrow(podId);
    const profile = profileStore.get(pod.profileName);

    const pat = service === 'github' ? profile.githubPat : profile.adoPat;
    if (!pat) {
      throw new AutopodError(
        `No ${service} PAT configured in profile '${pod.profileName}'. Add one via ap profile update.`,
        'MISSING_CREDENTIAL',
        400,
      );
    }

    if (!pod.containerId) {
      throw new AutopodError(`Pod ${podId} has no running container`, 'INVALID_STATE', 409);
    }

    const cm = containerManagerFactory.get(pod.executionTarget);
    const containerId = pod.containerId;
    const tmpFile = `/tmp/.autopod_cred_${generateId(8)}`;

    await cm.writeFile(containerId, tmpFile, `${pat}\n`);

    try {
      // ── STEP 1: Always set up git credentials (the must-have) ────────────────
      const gitHost = service === 'github' ? 'github.com' : 'dev.azure.com';
      const gitUser = service === 'github' ? 'x-access-token' : 'oauth2';
      const gitSetup = await cm.execInContainer(
        containerId,
        [
          'sh',
          '-c',
          `git config --global credential.helper store && printf 'https://${gitUser}:%s@${gitHost}\\n' "$(cat ${tmpFile})" >> ~/.git-credentials && chmod 600 ~/.git-credentials`,
        ],
        { timeout: 15_000 },
      );
      if (gitSetup.exitCode !== 0) {
        throw new AutopodError(
          `Failed to write git credentials (exit ${gitSetup.exitCode}): ${gitSetup.stderr.slice(0, 300)}`,
          'AUTH_FAILED',
          500,
        );
      }

      // ── STEP 2: Best-effort CLI install + auth ───────────────────────────────
      const cliStatus = await tryInstallAndAuthCli(cm, containerId, service, tmpFile, podId);

      return service === 'github'
        ? `Authenticated to github.com. git is configured.${cliStatus}`
        : `Authenticated to dev.azure.com. git is configured.${cliStatus}`;
    } finally {
      // Always remove the temp credential file, even on success
      await cm.execInContainer(containerId, ['rm', '-f', tmpFile]).catch(() => {});
    }
  }

  // Best-effort: install the CLI if missing, authenticate it. Returns a status suffix
  // describing what happened. NEVER throws — failures here are logged and reported in the
  // returned string, not propagated, because git credentials (which already succeeded) are
  // sufficient for most workflows.
  async function tryInstallAndAuthCli(
    cm: ContainerManager,
    containerId: string,
    service: 'github' | 'ado',
    tmpFile: string,
    podId: string,
  ): Promise<string> {
    const tool = service === 'github' ? 'gh' : 'az';

    try {
      // Check if the tool is already present
      const check = await cm.execInContainer(containerId, ['sh', '-c', `command -v ${tool}`]);
      if (check.exitCode !== 0) {
        // Install it
        if (service === 'github') {
          await installGhBinary(cm, containerId, podId);
        } else {
          await installAzViaPip(cm, containerId, podId);
        }
      }

      // Authenticate
      if (service === 'github') {
        const ghAuth = await cm.execInContainer(
          containerId,
          ['sh', '-c', `gh auth login --with-token < ${tmpFile}`],
          { timeout: 30_000 },
        );
        if (ghAuth.exitCode !== 0) {
          throw new Error(
            `gh auth login failed (exit ${ghAuth.exitCode}): ${ghAuth.stderr.slice(0, 200)}`,
          );
        }
        return ' gh CLI is authenticated.';
      }
      const azAuth = await cm.execInContainer(
        containerId,
        ['sh', '-c', `az devops login --token "$(cat ${tmpFile})"`],
        { timeout: 60_000 },
      );
      if (azAuth.exitCode !== 0) {
        throw new Error(
          `az devops login failed (exit ${azAuth.exitCode}): ${azAuth.stderr.slice(0, 200)}`,
        );
      }
      return ' az CLI is authenticated.';
    } catch (err) {
      logger.warn(
        { err, podId, tool },
        'CLI install/auth failed — git credentials are still configured and most workflows will work',
      );
      return ` (${tool} CLI install/auth failed — only git access configured; install ${tool} manually inside the container if needed)`;
    }
  }

  // Download the gh CLI binary from GitHub releases. No apt, no GPG keys —
  // it's a single Go binary. Throws on failure.
  async function installGhBinary(
    cm: ContainerManager,
    containerId: string,
    podId: string,
  ): Promise<void> {
    logger.info({ podId, containerId }, 'Installing gh CLI from github.com/cli/cli/releases');
    const result = await cm.execInContainer(
      containerId,
      [
        'sh',
        '-c',
        [
          'ARCH=$(uname -m | sed "s/x86_64/amd64/;s/aarch64/arm64/")',
          'VERSION=$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest' +
            " | node -e \"let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).tag_name.slice(1)))\")",
          'curl -fsSL "https://github.com/cli/cli/releases/download/v${VERSION}/gh_${VERSION}_linux_${ARCH}.tar.gz" | tar xz -C /tmp',
          'mv /tmp/gh_${VERSION}_linux_${ARCH}/bin/gh /usr/local/bin/gh',
          'chmod +x /usr/local/bin/gh',
        ].join(' && '),
      ],
      { timeout: 120_000, user: 'root' },
    );
    if (result.exitCode !== 0) {
      const detail = (result.stdout + result.stderr).slice(-300).trimStart();
      throw new Error(`gh binary install failed (exit ${result.exitCode}): ${detail}`);
    }
  }

  // Install az CLI via pip. Uses get-pip.py because Debian/Ubuntu strip ensurepip from python3
  // (you'd normally need apt-get install python3-pip, but apt is broken on ARM Noble).
  // Throws on failure.
  async function installAzViaPip(
    cm: ContainerManager,
    containerId: string,
    podId: string,
  ): Promise<void> {
    logger.info({ podId, containerId }, 'Installing az CLI via pip (bootstrap.pypa.io get-pip.py)');
    const result = await cm.execInContainer(
      containerId,
      [
        'sh',
        '-c',
        [
          // Bootstrap pip using get-pip.py — the canonical workaround when ensurepip is stripped
          'curl -fsSL https://bootstrap.pypa.io/get-pip.py -o /tmp/get-pip.py',
          'python3 /tmp/get-pip.py --quiet --break-system-packages 2>&1',
          // Now install azure-cli
          'python3 -m pip install --quiet --break-system-packages azure-cli 2>&1',
        ].join(' && '),
      ],
      { timeout: 300_000, user: 'root' },
    );
    if (result.exitCode !== 0) {
      const detail = (result.stdout + result.stderr).slice(-300).trimStart();
      throw new Error(`pip install azure-cli failed (exit ${result.exitCode}): ${detail}`);
    }
  }

  function emitActivityStatus(podId: string, message: string): void {
    eventBus.emit({
      type: 'pod.agent_activity',
      timestamp: new Date().toISOString(),
      podId,
      event: { type: 'status', timestamp: new Date().toISOString(), message },
    });
  }

  /**
   * If `err` is a DeletionGuardError, mark the pod as worktree-compromised so the desktop
   * disables Create PR / merge actions until a human reconciles the state. Emits an event
   * plus an activity-status line. Returns true if the error was a guard trip so callers can
   * skip redundant warnings about the same condition.
   */
  function handleDeletionGuardError(podId: string, err: unknown): boolean {
    if (!(err instanceof DeletionGuardError)) return false;
    try {
      podRepo.update(podId, { worktreeCompromised: true });
    } catch (updateErr) {
      logger.warn({ err: updateErr, podId }, 'Failed to persist worktreeCompromised flag');
    }
    eventBus.emit({
      type: 'pod.worktree_compromised',
      timestamp: new Date().toISOString(),
      podId,
      deletionCount: err.deletionCount,
      threshold: err.threshold,
    });
    emitActivityStatus(
      podId,
      `Worktree out of sync with container — ${err.deletionCount} phantom deletions blocked. Do not retry PR; work may still live in the container.`,
    );
    return true;
  }

  function transition(pod: Pod, to: PodStatus, extraUpdates?: Partial<PodUpdates>): Pod {
    validateTransition(pod.id, pod.status, to);
    const previousStatus = pod.status;
    const updates: PodUpdates = { status: to, ...extraUpdates };
    podRepo.update(pod.id, updates);
    eventBus.emit({
      type: 'pod.status_changed',
      timestamp: new Date().toISOString(),
      podId: pod.id,
      previousStatus,
      newStatus: to,
    });
    return podRepo.getOrThrow(pod.id);
  }

  /**
   * After a pod reaches `validated`, enqueue any dependents whose *all*
   * parents have now reached a completed-success state. Single-parent pods
   * fire immediately; multi-parent (fan-in) pods wait for the last holdout.
   *
   * The dependent pod stacks on its first parent's branch — this matches the
   * linear-chain mental model. Commits from other parents reach the child via
   * handover files or the eventual PR merge, not the worktree.
   */
  function maybeTriggerDependents(completedPod: Pod): void {
    const dependents = podRepo.getPodsDependingOn(completedPod.id);
    for (const dep of dependents) {
      // Also heal pods that were cascade-failed when this parent was previously killed.
      // The mergeBlockReason marker identifies exactly those pods so we don't disturb
      // genuinely-failed dependents that have their own failure reason.
      const cascadeFailed =
        dep.status === 'failed' &&
        dep.mergeBlockReason === `dependency pod ${completedPod.id} failed`;
      if (dep.status !== 'queued' && !cascadeFailed) continue;

      const parentIds =
        dep.dependsOnPodIds.length > 0
          ? dep.dependsOnPodIds
          : dep.dependsOnPodId
            ? [dep.dependsOnPodId]
            : [];
      if (parentIds.length === 0) continue;

      const parentsReady = parentIds.every((pid) => {
        let parent: Pod;
        try {
          parent = pid === completedPod.id ? completedPod : podRepo.getOrThrow(pid);
        } catch {
          // Missing parent — treat as not ready rather than crashing.
          return false;
        }
        // Shared branch (single-mode siblings): the parent holds the Git worktree
        // lock on the branch until it reaches 'complete' — worktree is cleaned up
        // on completion, not on validation. Starting the child early races into
        // an empty worktree and the repoint step fails. Wait for 'complete'.
        if (parent.branch === dep.branch) {
          return parent.status === 'complete';
        }
        if (dep.waitForMerge) {
          // Stacked series: wait until the parent PR is fully merged.
          return parent.status === 'complete';
        }
        // Accept any terminal-success status — a manually approved parent reaches
        // 'complete' without passing through 'validated' in the dependent's view.
        return (
          parent.status === 'validated' ||
          parent.status === 'approved' ||
          parent.status === 'merging' ||
          parent.status === 'merge_pending' ||
          parent.status === 'complete'
        );
      });
      if (!parentsReady) {
        logger.debug(
          {
            podId: dep.id,
            parentIds,
            waitingOn: parentIds.filter((pid) => pid !== completedPod.id),
          },
          'Series: dependent pod still waiting on other parents',
        );
        continue;
      }

      // Determine base branch for the dependent pod:
      // - Single-branch (shared branch): keep pointing at real base (e.g. main) so diff
      //   stats and the final PR target are correct.
      // - Stacked with waitForMerge: parent branch is deleted post-merge; use parent's
      //   baseBranch (main) so the dependent starts from the freshly-merged main.
      // - Stacked without waitForMerge: stack directly on parent's branch (classic stacking).
      const firstParentId = parentIds[0];
      const isSharedBranch = dep.branch === completedPod.branch;
      let baseBranch: string;
      if (isSharedBranch || dep.waitForMerge) {
        baseBranch = completedPod.baseBranch ?? 'main';
      } else {
        baseBranch = firstParentId
          ? firstParentId === completedPod.id
            ? completedPod.branch
            : podRepo.getOrThrow(firstParentId).branch
          : completedPod.branch;
      }

      if (cascadeFailed) {
        podRepo.update(dep.id, { status: 'queued', completedAt: null, mergeBlockReason: null });
        eventBus.emit({
          type: 'pod.status_changed',
          timestamp: new Date().toISOString(),
          podId: dep.id,
          previousStatus: 'failed',
          newStatus: 'queued',
        });
        logger.info(
          { podId: dep.id, parentId: completedPod.id },
          'Series: healed cascade-failed dependent — parent completed',
        );
      }
      podRepo.update(dep.id, {
        baseBranch,
        dependencyStartedAt: new Date().toISOString(),
      });
      enqueueSession(dep.id);
      logger.info({ podId: dep.id, parentIds, baseBranch }, 'Series: dependent pod enqueued');
    }
  }

  return {
    createSession(request: CreatePodRequest, userId: string): Pod {
      const profile = profileStore.get(request.profileName);
      const model = request.model ?? profile.defaultModel ?? 'opus';
      const runtime = request.runtime ?? profile.defaultRuntime ?? 'claude';
      const executionTarget = request.executionTarget ?? profile.executionTarget ?? 'local';
      const skipValidation = request.skipValidation ?? false;

      // Resolve the effective PodOptions once, so both branch derivation and
      // DB insertion use the exact same values.
      const resolvedPod = resolvePodOptions(
        profile.pod ?? (profile.outputMode ? podOptionsFromOutputMode(profile.outputMode) : null),
        request.options ??
          (request.outputMode ? podOptionsFromOutputMode(request.outputMode) : undefined),
      );

      // deny-all network policy blocks all outbound — incompatible with cloud-backed runtimes.
      // Interactive pods run without an AI agent, so they're unaffected.
      if (
        resolvedPod.agentMode !== 'interactive' &&
        profile.networkPolicy?.enabled &&
        profile.networkPolicy?.mode === 'deny-all'
      ) {
        throw new AutopodError(
          `Network policy 'deny-all' blocks all outbound traffic, but runtime '${runtime}' requires API access. Use 'restricted' mode instead — the default allowlist includes the model API.`,
          'INVALID_CONFIGURATION',
          400,
        );
      }

      // Validate requireSidecars against the pod's profile at create time so
      // typos and missing configs fail fast instead of silently no-oping at
      // spawn. Privileged sidecars additionally require `trustedSource:true`.
      const requireSidecars = request.requireSidecars ?? [];
      for (const name of requireSidecars) {
        const spec = resolveSidecarSpec(profile, name);
        if (!spec) {
          throw new AutopodError(
            `Pod requested sidecar '${name}' but profile '${profile.name}' has no matching enabled config`,
            'INVALID_SIDECAR',
            400,
          );
        }
        if (spec.privileged === true && profile.trustedSource !== true) {
          throw new AutopodError(
            `Sidecar '${name}' runs privileged; profile '${profile.name}' must have trustedSource:true to enable it`,
            'UNTRUSTED_PROFILE',
            403,
          );
        }
      }

      const derivedReferenceRepos = deriveReferenceRepos(request.referenceRepos);

      let id: string;
      for (let attempt = 0; attempt < 10; attempt++) {
        id = generatePodId();
        const effectiveOutputMode = outputModeFromPodOptions(resolvedPod);
        let branch: string;
        if (request.branch) {
          branch = request.branch;
        } else if (resolvedPod.output === 'artifact') {
          branch = `research/${id}`;
        } else {
          const prefix = request.branchPrefix ?? profile.branchPrefix ?? 'autopod/';
          branch = `${prefix}${id}`;
        }
        // Workspace pods must not land on the default branch — `ap complete` would push
        // directly to origin/main. Auto-generate a safe branch unless this pod was spawned
        // by fixManually() (linkedPodId set), which intentionally inherits the worker's branch.
        if (resolvedPod.agentMode === 'interactive' && !request.linkedPodId) {
          const effectiveBaseBranch = request.baseBranch ?? profile.defaultBranch ?? 'main';
          if (branch === effectiveBaseBranch) {
            const prefix = request.branchPrefix ?? profile.branchPrefix ?? 'autopod/';
            branch = `${prefix}${id}`;
          }
        }
        try {
          podRepo.insert({
            id,
            profileName: request.profileName,
            task: request.task,
            status: 'queued',
            model,
            runtime,
            executionTarget,
            branch,
            userId,
            maxValidationAttempts: profile.maxValidationAttempts ?? 3,
            skipValidation,
            acceptanceCriteria: request.acceptanceCriteria ?? null,
            options: resolvedPod,
            outputMode: effectiveOutputMode,
            baseBranch: request.baseBranch ?? null,
            acFrom: request.acFrom ?? null,
            linkedPodId: request.linkedPodId ?? null,
            pimGroups: (() => {
              if (request.pimGroups != null) return request.pimGroups;
              // Fall back to profile-level pimActivations (group type only — stored as PimGroupConfig)
              const groupActivations = (profile.pimActivations ?? [])
                .filter((a): a is Extract<typeof a, { type: 'group' }> => a.type === 'group')
                .map(({ groupId, displayName, duration, justification }) => ({
                  groupId,
                  displayName,
                  duration,
                  justification,
                }));
              return groupActivations.length > 0 ? groupActivations : null;
            })(),
            prUrl: request.prUrl ?? null,
            tokenBudget:
              request.tokenBudget !== undefined
                ? request.tokenBudget
                : (profile.tokenBudget ?? null),
            referenceRepos: derivedReferenceRepos.length > 0 ? derivedReferenceRepos : null,
            scheduledJobId: request.scheduledJobId ?? null,
            dependsOnPodIds:
              request.dependsOnPodIds && request.dependsOnPodIds.length > 0
                ? request.dependsOnPodIds
                : request.dependsOnPodId
                  ? [request.dependsOnPodId]
                  : null,
            dependsOnPodId: request.dependsOnPodId ?? null,
            seriesId: request.seriesId ?? null,
            seriesName: request.seriesName ?? null,
            seriesDescription: request.seriesDescription ?? null,
            seriesDesign: request.seriesDesign ?? null,
            briefTitle: request.briefTitle ?? null,
            touches: request.touches && request.touches.length > 0 ? request.touches : null,
            doesNotTouch:
              request.doesNotTouch && request.doesNotTouch.length > 0 ? request.doesNotTouch : null,
            prMode: request.prMode ?? null,
            waitForMerge: request.waitForMerge ?? false,
            requireSidecars: requireSidecars.length > 0 ? requireSidecars : null,
            autoApprove: request.autoApprove ?? false,
            disableAskHuman: request.disableAskHuman ?? false,
          });
          break;
        } catch (err: unknown) {
          if (
            err instanceof Error &&
            err.message.includes('UNIQUE constraint failed') &&
            attempt < 9
          ) {
            continue;
          }
          throw err;
        }
      }
      // biome-ignore lint/style/noNonNullAssertion: id is guaranteed non-null after the retry loop above
      id = id!;

      const pod = podRepo.getOrThrow(id);

      eventBus.emit({
        type: 'pod.created',
        timestamp: new Date().toISOString(),
        pod: {
          id: pod.id,
          profileName: pod.profileName,
          task: pod.task,
          status: pod.status,
          model: pod.model,
          runtime: pod.runtime,
          duration: null,
          filesChanged: pod.filesChanged,
          createdAt: pod.createdAt,
        },
      });

      // Dependent pods must not start until their predecessors reach `validated`;
      // maybeTriggerDependents() will enqueue them at that point. A pod counts
      // as dependent if either the new multi-parent array or the legacy single
      // field is populated.
      const hasDeps = (request.dependsOnPodIds?.length ?? 0) > 0 || !!request.dependsOnPodId;
      if (!hasDeps) {
        enqueueSession(id);
      }
      logger.info({ podId: id, profile: request.profileName }, 'Pod created');
      return pod;
    },

    createHistoryWorkspace(profileName: string, userId: string, historyQuery: HistoryQuery): Pod {
      // Encode query params into the task field with a [history] prefix
      const queryJson = JSON.stringify(historyQuery);
      const task = `[history] History analysis workspace | ${queryJson}`;
      return this.createSession(
        {
          profileName,
          task,
          outputMode: 'workspace',
          skipValidation: true,
        },
        userId,
      );
    },

    createMemoryWorkspace(profileName: string, userId: string): Pod {
      const globalMems = deps.memoryRepo?.listByScope('global', true) ?? [];
      const profileMems = deps.memoryRepo?.list('profile', profileName, true) ?? [];
      const all = [...globalMems, ...profileMems];

      const formatted = all
        .map((m) => `### ${m.path}\n${m.rationale ? `Why: ${m.rationale}\n\n` : ''}${m.content}`)
        .join('\n\n---\n\n');

      const task = [
        `[memory-analysis] Review ${all.length} memories and draft a fix plan`,
        '',
        'You have been given a snapshot of memories from this project.',
        'Your job:',
        '1. Identify gotchas, bugs, and missing config that can be fixed in the repo',
        '2. For each fixable item, draft the specific change or PR needed',
        '3. Prioritize and optionally implement the most critical fixes',
        '',
        '## Memories',
        '',
        formatted,
      ].join('\n');

      return this.createSession(
        {
          profileName,
          task,
          outputMode: 'workspace',
          skipValidation: true,
        },
        userId,
      );
    },

    async processPod(podId: string): Promise<void> {
      let pod = podRepo.getOrThrow(podId);

      // Defense-in-depth: processPod must only run for pods in queued/handoff state.
      // The queue's activeIds dedup prevents most races, but this guard ensures
      // a stale processPod call can never kill a pod that's already running.
      if (pod.status !== 'queued' && pod.status !== 'handoff') {
        logger.warn(
          { podId, status: pod.status },
          'processPod skipped — pod not in queued/handoff state',
        );
        return;
      }

      const profile = profileStore.get(pod.profileName);

      function emitStatus(message: string): void {
        emitActivityStatus(podId, message);
      }

      try {
        // For handoff pods the interactive container is still running — sync the
        // human's work back to the host worktree and stop the container here so
        // the promote HTTP endpoint can return immediately without timing out.
        if (pod.status === 'handoff' && pod.containerId && pod.worktreePath) {
          const cm = containerManagerFactory.get(pod.executionTarget);
          try {
            await syncWorkspaceBack(pod.containerId, pod.worktreePath, cm);
          } catch (err) {
            logger.warn(
              { err, podId },
              'Failed to sync workspace back during handoff — agent may miss in-flight changes',
            );
          }
          try {
            await cm.stop(pod.containerId);
          } catch (err) {
            logger.warn({ err, podId }, 'Failed to stop interactive container during handoff');
          }
          podRepo.update(podId, { containerId: null });
          pod = podRepo.getOrThrow(podId);

          // Compose the agent-facing handoff context now that the worktree
          // reflects the human's in-flight work. Reads the human's typed
          // instructions (captured by promoteToAuto) plus the live commit log
          // and diff stats; the system-instructions-generator renders this as
          // the `## Handoff` section in the agent's CLAUDE.md.
          try {
            const baseBranch = pod.baseBranch ?? profile.defaultBranch ?? 'main';
            const [stats, commitLog] = await Promise.all([
              worktreeManager.getDiffStats(
                pod.worktreePath,
                baseBranch,
                pod.startCommitSha ?? undefined,
              ),
              worktreeManager.getCommitLog(
                pod.worktreePath,
                baseBranch,
                30,
                pod.startCommitSha ?? undefined,
              ),
            ]);

            const hasInstructions =
              !!pod.handoffInstructions && pod.handoffInstructions.trim().length > 0;
            const hasWork =
              stats.filesChanged > 0 || stats.linesAdded > 0 || stats.linesRemoved > 0;

            if (hasInstructions || hasWork) {
              const sections: string[] = [
                "You're picking up after a human-driven interactive session on this branch. " +
                  'Treat the human as a collaborator, not noise — their commits encode intent, ' +
                  'and their instructions (if any) take precedence over inferences from the diff alone.',
                '',
                '### Human instructions',
                hasInstructions
                  ? (pod.handoffInstructions as string)
                  : '(none provided — infer the remaining work from the session summary and original brief)',
                '',
                '### Session summary',
                hasWork
                  ? `${stats.filesChanged} file(s) changed, +${stats.linesAdded}/-${stats.linesRemoved} lines.`
                  : 'No diff against base — the human may have explored without committing changes yet.',
              ];

              if (commitLog && commitLog.length > 0) {
                sections.push('', '### Commit log', '```', commitLog, '```');
              }

              const handoffContext = sections.join('\n');
              podRepo.update(podId, { handoffContext });
              pod = podRepo.getOrThrow(podId);
              logger.info(
                {
                  podId,
                  hasInstructions,
                  filesChanged: stats.filesChanged,
                  contextLength: handoffContext.length,
                },
                'Composed handoff context for promoted pod',
              );
            }
          } catch (err) {
            logger.warn(
              { err, podId },
              'Failed to compose handoff context — agent will run without it',
            );
          }
        }

        // Detect recovery mode before any provisioning work
        const isRecovery = !!pod.recoveryWorktreePath;
        const isRework = isRecovery && !!pod.reworkReason;

        // Transition to provisioning
        pod = transition(pod, 'provisioning', { startedAt: new Date().toISOString() });

        // Snapshot the resolved profile at pod start time for auditability
        podRepo.update(podId, { profileSnapshot: profile });

        // Worktree is optional — artifact-mode profiles may have no repoUrl.
        let worktreePath: string | null = null;
        let bareRepoPath: string | null = null;

        if (profile.repoUrl) {
          // Validate recovery worktree is still a usable git directory.
          // It may have been cleaned up by another pod's kill (e.g. shared worktree path).
          let recoveryViable = false;
          if (isRecovery && pod.recoveryWorktreePath) {
            try {
              const gitlinkPath = path.join(pod.recoveryWorktreePath, '.git');
              await access(gitlinkPath);
              // Also verify the bare-repo worktree metadata directory still exists.
              // `git worktree prune` can remove it while the on-disk directory survives,
              // leaving the worktree in a broken state where the container gitdir repointing
              // script would fail trying to write to a non-existent path.
              const gitlinkContent = await readFile(gitlinkPath, 'utf8');
              const bareWorktreeDir = path.resolve(
                pod.recoveryWorktreePath,
                gitlinkContent.trim().replace(/^gitdir:\s*/, ''),
              );
              await access(bareWorktreeDir);
              recoveryViable = true;
            } catch {
              logger.warn(
                { podId, worktreePath: pod.recoveryWorktreePath },
                'Recovery worktree missing or bare-repo metadata gone — falling back to fresh worktree',
              );
              podRepo.update(podId, { recoveryWorktreePath: null });
            }
          }

          if (recoveryViable && pod.recoveryWorktreePath) {
            worktreePath = pod.recoveryWorktreePath;
            bareRepoPath = await deriveBareRepoPath(worktreePath);
            // Clear recovery flag now that we've captured the path
            podRepo.update(podId, { recoveryWorktreePath: null });
            emitStatus('Recovering pod — reusing existing worktree…');
            logger.info({ podId, worktreePath }, 'Recovery mode: reusing worktree');
          } else {
            // Normal path: create worktree
            emitStatus('Creating worktree…');
            if (!profile.repoUrl) {
              throw new AutopodError(
                `Profile '${profile.name}' has no repoUrl (inherited chain did not supply one)`,
                'INVALID_PROFILE',
                400,
              );
            }
            const result = await worktreeManager.create({
              repoUrl: profile.repoUrl,
              branch: pod.branch,
              baseBranch: pod.baseBranch ?? profile.defaultBranch ?? 'main',
              pat: selectGitPat(profile),
              sessionId: pod.id,
            });
            worktreePath = result.worktreePath;
            bareRepoPath = result.bareRepoPath;
            // Persist startCommitSha now — before the container starts and before
            // any /diff request can land. Without this, the diff route falls back
            // to merge-base(HEAD, baseBranch), which for fix pods on a PR branch
            // surfaces the entire PR's prior sibling commits as the fix pod's
            // "work". captureStartSha (run later from agent-event consumption)
            // early-returns when this is already set, and re-tries when this is empty.
            if (!pod.startCommitSha && result.startCommitSha) {
              podRepo.update(podId, { startCommitSha: result.startCommitSha });
              pod = podRepo.getOrThrow(podId);
            }
          }
        }

        // If acFrom is set, read acceptance criteria from the worktree
        if (pod.acFrom && worktreePath) {
          const criteria = await readAcFile(worktreePath, pod.acFrom);
          // File-sourced criteria are plain lines — wrap each as a minimal
          // AcDefinition so the validation engine can treat them uniformly.
          const wrapped = criteria.map((test) => ({
            type: 'none' as const,
            test,
            pass: 'criterion satisfied',
            fail: 'criterion not satisfied',
          }));
          podRepo.update(podId, { acceptanceCriteria: wrapped });
          pod = podRepo.getOrThrow(podId);
          logger.info(
            { podId, acFrom: pod.acFrom, count: criteria.length },
            'Loaded acceptance criteria from file',
          );
        }

        // Security scan: inspect cloned worktree for secrets / PII / prompt
        // injection before the container starts. The scanner is best-effort —
        // when not wired (older deployments / tests), we proceed silently.
        if (repoScanner && worktreePath) {
          try {
            const baseRef = `origin/${pod.baseBranch ?? profile.defaultBranch ?? 'main'}`;
            const isWorkspacePod = pod.options.agentMode === 'interactive';
            emitStatus('Running security scan…');
            const scan = await repoScanner.scan('provisioning', {
              podId,
              workdir: worktreePath,
              baseRef,
              profile,
              isWorkspacePod,
            });
            logger.info(
              {
                podId,
                decision: scan.decision,
                findings: scan.findings.length,
                filesScanned: scan.filesScanned,
                filesSkipped: scan.filesSkipped,
                scanIncomplete: scan.scanIncomplete,
              },
              'Security scan completed',
            );
            if (scan.decision === 'block') {
              throw new AutopodError(
                `Security scan blocked pod creation (${scan.findings.length} finding(s))`,
                'SECURITY_SCAN_BLOCKED',
                400,
              );
            }
            // For warn / escalate, inject the warning section so the agent sees
            // the flagged regions in its CLAUDE.md. Escalation as a true pause
            // ships in a later phase — for now the agent gets the warning
            // and an instruction to ask_human if a flagged region is relevant.
            if (scan.warningSection) {
              profile.claudeMdSections = [...profile.claudeMdSections, scan.warningSection];
            }
          } catch (err) {
            if (err instanceof AutopodError) throw err;
            // Fail open: scanner errors must not block pod creation.
            logger.warn({ err, podId }, 'Security scan errored — proceeding without scan');
          }
        }

        // Select container manager based on execution target
        const containerManager = containerManagerFactory.get(pod.executionTarget);

        // Compute initial network config — this creates the per-pod bridge
        // so sidecars can join it. The firewall script built here does NOT
        // yet include sidecar IPs; we rebuild it below once sidecars are up
        // and their bridge IPs are known.
        let networkName: string | undefined;
        let firewallScript: string | undefined;
        let initialMergedMcpServers: import('@autopod/shared').InjectedMcpServer[] | undefined;
        let daemonGatewayIp: string | undefined;
        if (networkManager && pod.executionTarget === 'local' && profile.networkPolicy?.enabled) {
          initialMergedMcpServers = mergeMcpServers(daemonConfig.mcpServers, profile.mcpServers);
          daemonGatewayIp = await networkManager.getGatewayIp(podId);
          const netConfig = await networkManager.buildNetworkConfig(
            profile.networkPolicy,
            initialMergedMcpServers,
            daemonGatewayIp,
            profile.privateRegistries,
            podId,
            [],
          );
          if (netConfig) {
            networkName = netConfig.networkName;
            firewallScript = netConfig.firewallScript;
          }
        }

        // Allocate a host port for the container's app server
        const hostPort = allocateHostPort();

        // For .NET templates, cap MSBuild node count to half the available CPUs
        // (min 2, max 4) to prevent dozens of MSBuild workers from exhausting memory.
        const template = profile.template ?? 'node22';
        const isDotnet = template.startsWith('dotnet');

        // Resolve registry PAT early — needed for both container env vars and config files.
        // Fall back to adoPat when registryPat isn't set — they're usually the same
        // PAT for ADO-hosted feeds, and requiring both is a footgun.
        const effectiveRegistryPat = profile.registryPat ?? profile.adoPat ?? null;

        // Resolve sidecar specs up front so their env vars (e.g. Dagger's
        // _EXPERIMENTAL_DAGGER_RUNNER_HOST) can be baked into the pod container
        // env before spawn. Sidecar validation already ran at createSession, so
        // a null spec here is a config change between create and spawn; treat
        // as a hard error rather than silently skipping.
        const sidecarSpecs: { name: string; spec: import('@autopod/shared').SidecarSpec }[] = [];
        for (const name of pod.requireSidecars) {
          const spec = resolveSidecarSpec(profile, name);
          if (!spec) {
            throw new AutopodError(
              `Sidecar '${name}' is no longer available on profile '${profile.name}'`,
              'INVALID_SIDECAR',
              409,
            );
          }
          sidecarSpecs.push({ name, spec });
        }
        const sidecarEnv: Record<string, string> = {};
        for (const { spec } of sidecarSpecs) {
          Object.assign(sidecarEnv, sidecarPodEnv(spec));
        }
        if (sidecarSpecs.length > 0 && !sidecarManager) {
          throw new AutopodError(
            `Pod ${podId} requires sidecars but no SidecarManager is configured on the daemon`,
            'MISCONFIGURED_DAEMON',
            500,
          );
        }
        if (sidecarSpecs.length > 0 && !networkName) {
          throw new AutopodError(
            `Pod ${podId} requires sidecars; profile must have a networkPolicy enabled so sidecars and the pod share an isolated network`,
            'INVALID_CONFIGURATION',
            400,
          );
        }

        // Spawn sidecars FIRST on the per-pod bridge so the pod container's
        // firewall can be built with the sidecar IPs pre-allowlisted. If we
        // spawned the pod first, its iptables OUTPUT chain would REJECT every
        // packet to the sidecar before the sidecar even had an IP — the bug
        // that produced the "Connection refused" we chased.
        const startedSidecars: Record<string, string> = {};
        const sidecarIps: string[] = [];
        if (sidecarSpecs.length > 0 && sidecarManager && networkName) {
          try {
            for (const { name, spec } of sidecarSpecs) {
              emitStatus(`Spawning sidecar '${name}'…`);
              const handle = await sidecarManager.spawn({ spec, podId, networkName });
              startedSidecars[name] = handle.containerId;
              await sidecarManager.waitHealthy(handle, spec);
              const ip = await sidecarManager.getBridgeIp(handle, networkName);
              if (ip) {
                sidecarIps.push(ip);
              } else {
                logger.warn(
                  { podId, sidecarName: name, containerId: handle.containerId },
                  'Sidecar has no IP on the pod network — pod firewall may block traffic to it',
                );
              }
            }
            podRepo.update(podId, { sidecarContainerIds: startedSidecars });
          } catch (err) {
            logger.error(
              { err, podId, started: startedSidecars },
              'Sidecar spawn failed — cleaning up',
            );
            for (const id of Object.values(startedSidecars)) {
              await sidecarManager.kill(id).catch((killErr) => {
                logger.warn({ killErr, containerId: id }, 'Failed to kill partial sidecar');
              });
            }
            throw err;
          }
        }

        // Rebuild the firewall script with sidecar IPs AND DNS names allowed
        // through the pod's firewall. The IP list unblocks iptables; the DNS
        // name list unblocks dnsmasq — both are required. Without the DNS
        // piece the pod's CLI resolves the sidecar to NXDOMAIN and never
        // gets as far as iptables to notice the IP is allowed.
        if (
          sidecarSpecs.length > 0 &&
          networkManager &&
          initialMergedMcpServers &&
          daemonGatewayIp &&
          profile.networkPolicy?.enabled
        ) {
          const sidecarDnsNames = sidecarSpecs.map(({ spec }) => spec.name);
          const finalConfig = await networkManager.buildNetworkConfig(
            profile.networkPolicy,
            initialMergedMcpServers,
            daemonGatewayIp,
            profile.privateRegistries,
            podId,
            sidecarIps,
            sidecarDnsNames,
          );
          if (finalConfig) {
            firewallScript = finalConfig.firewallScript;
          }
        }

        // Spawn container with port mapping so daemon + user can reach the app
        // Prefer the per-profile warm image when one has been built — that's
        // where customisations like Serena / roslyn-codelens-mcp live. Fall
        // back to the bare base image only when no warm image exists.
        const spawnImage = profile.warmImageTag ?? getBaseImage(template);
        emitStatus(`Spawning container (${profile.template})…`);
        logger.info(
          { podId, image: spawnImage, warm: Boolean(profile.warmImageTag) },
          'Spawning pod container',
        );

        const containerEnv: Record<string, string> = {
          POD_ID: podId,
          PORT: String(CONTAINER_APP_PORT),
          HOST: '0.0.0.0', // bind to all interfaces inside container for Docker port forwarding
          ...(isDotnet
            ? {
                MSBUILDNODECOUNT: '4',
                // Disable MSBuild's TerminalLogger — it crashes with ArgumentOutOfRangeException
                // when terminal dimensions are unavailable (non-TTY exec contexts).
                MSBUILDTERMINALLOGGER: 'false',
              }
            : {}),
          ...sidecarEnv,
        };

        let containerId: string;
        try {
          containerId = await containerManager.spawn({
            image: spawnImage,
            podId,
            env: containerEnv,
            ports: [{ container: CONTAINER_APP_PORT, host: hostPort }],
            volumes: [
              ...(worktreePath ? [{ host: worktreePath, container: '/mnt/worktree' }] : []),
              ...(bareRepoPath ? [{ host: bareRepoPath, container: bareRepoPath }] : []),
            ],
            networkName,
            firewallScript,
            networkPolicyMode: profile.networkPolicy?.mode,
            memoryBytes:
              (profile.containerMemoryGb ?? DEFAULT_CONTAINER_MEMORY_GB) * 1024 * 1024 * 1024,
          });
        } catch (err) {
          // Pod container failed to spawn — tear down sidecars we already
          // brought up so they don't leak on the per-pod bridge.
          if (sidecarManager) {
            for (const id of Object.values(startedSidecars)) {
              await sidecarManager.kill(id).catch(() => {});
            }
          }
          throw err;
        }

        // Copy worktree content from bind mount to container's native filesystem.
        // VirtioFS bind mounts break getcwd() on Docker Desktop for Mac — overlayfs does not.
        // Skipped for artifact pods with no worktree.
        if (worktreePath) {
          emitStatus('Populating workspace…');
          // Strip the image's baked-in `/workspace/.git` first. The warm image is built
          // with `RUN git clone --depth 1` (dockerfile-generator.ts), which leaves a real
          // `.git` directory pinned to whatever main was at image-build time. The host
          // worktree carries a `.git` *gitlink file*, and `cp -a` cannot overwrite a
          // directory with a non-directory — it errors on that single entry, copies
          // everything else, and exits non-zero. If we don't pre-clear, the seam leaks
          // image-era HEAD into /workspace/.git/HEAD and the agent works against a stale
          // base. Pre-clearing makes cp's job collision-free.
          const preclear = await containerManager.execInContainer(
            containerId,
            ['rm', '-rf', '/workspace/.git'],
            { timeout: 30_000 },
          );
          if (preclear.exitCode !== 0) {
            throw new Error(
              `Workspace pre-clear failed (exit ${preclear.exitCode}): ${preclear.stderr}`,
            );
          }
          const populate = await containerManager.execInContainer(
            containerId,
            ['cp', '-a', '/mnt/worktree/.', '/workspace/'],
            { timeout: 120_000 },
          );
          if (populate.exitCode !== 0) {
            throw new Error(
              `Workspace populate failed (exit ${populate.exitCode}): ${populate.stderr}`,
            );
          }
          // Restore execute bit on node_modules binaries — VirtioFS bind mounts on Docker Desktop
          // for Mac can strip +x from native platform binaries (e.g. @esbuild/linux-arm64/bin/esbuild).
          await containerManager
            .execInContainer(
              containerId,
              [
                'sh',
                '-c',
                'find /workspace \\( -path "*/node_modules/.bin/*" -o -path "*/node_modules/*/bin/*" \\) -type f -not -empty -exec chmod +x {} + 2>/dev/null || true',
              ],
              { timeout: 15_000 },
            )
            .catch(() => null);
          // Convert /workspace/.git from a gitlink file into a self-contained real .git
          // directory. The gitlink references a Mac host path that sub-processes
          // (e.g. Dagger CLI, go-git) can't follow when they don't inherit autopod's
          // bind mounts. A real .git directory works everywhere inside the container.
          // Objects are shared via alternates so no object copying is needed.
          const repoint = await containerManager.execInContainer(
            containerId,
            [
              'sh',
              '-c',
              [
                'set -e',
                // Resolve bare worktree metadata dir and bare root from the gitlink
                "BARE_WT=$(sed 's/^gitdir: //' /workspace/.git | tr -d '\\n')",
                'BARE_COMMON=$(cat "${BARE_WT}/commondir" 2>/dev/null || echo "../..")',
                'BARE_ROOT=$(cd "${BARE_WT}/${BARE_COMMON}" && pwd)',
                // Replace the gitlink file with a real git directory
                'rm /workspace/.git',
                'mkdir -p /workspace/.git',
                // Seed it with the worktree-specific metadata (HEAD, index, logs, etc.)
                'cp -a "${BARE_WT}/." /workspace/.git/',
                // Strip the commondir/gitdir files — this is now a standalone git dir
                'rm -f /workspace/.git/commondir /workspace/.git/gitdir',
                // Wire alternates so git can read objects from the bare without copying them
                'mkdir -p /workspace/.git/objects/info',
                'echo "${BARE_ROOT}/objects" > /workspace/.git/objects/info/alternates',
                // Materialise refs from the bare (worktree metadata only has per-branch refs)
                'cp -a "${BARE_ROOT}/refs/." /workspace/.git/refs/ 2>/dev/null || true',
                'cp "${BARE_ROOT}/packed-refs" /workspace/.git/ 2>/dev/null || true',
              ].join(' && '),
            ],
            { timeout: 15_000 },
          );
          if (repoint.exitCode !== 0) {
            throw new Error(
              `Git workspace setup failed (exit ${repoint.exitCode}): ${repoint.stderr}`,
            );
          }
          // Restore any tracked files missing from the working tree (M/D status).
          // syncWorkspaceBack() clears + re-copies the host bind-mount; if it dies mid-flight
          // (OOM, Docker crash, Azure SMB error) the host worktree loses files while the git
          // index still references them. Recovery mode then copies that partial tree into the
          // container. Skipped when the index is empty (new branch / unborn HEAD) — `git restore .`
          // errors with "pathspec '.' did not match any file(s) known to git" in that case.
          const hasTrackedFiles = await containerManager.execInContainer(
            containerId,
            ['sh', '-c', 'git -C /workspace ls-files | head -1 | grep -q .'],
            { timeout: 5_000 },
          );
          if (hasTrackedFiles.exitCode === 0) {
            const restore = await containerManager.execInContainer(
              containerId,
              ['git', '-C', '/workspace', 'restore', '.'],
              { timeout: 30_000 },
            );
            if (restore.exitCode !== 0) {
              throw new Error(
                `Git workspace restore failed (exit ${restore.exitCode}): ${restore.stderr}`,
              );
            }
          }
        }

        // Clone reference repos into /repos/<mountPath> inside the container (read-only)
        const referenceRepos = pod.referenceRepos ?? [];
        if (referenceRepos.length > 0) {
          emitStatus('Cloning reference repos…');
          await containerManager.execInContainer(containerId, ['mkdir', '-p', '/repos'], {
            timeout: 5_000,
          });
          for (const repo of referenceRepos) {
            const destPath = `/repos/${repo.mountPath}`;
            const refPat = resolveRefRepoPat(repo, profileStore, logger);
            try {
              if (refPat) {
                // Use a git credential helper script to avoid embedding the PAT in the
                // clone URL (which would expose it in /proc/<pid>/cmdline). The script
                // is written to a tmpfs path, used for the single clone, then deleted.
                const credHelper = `/tmp/.autopod-refcred-${generateId(8)}`;
                // Write a store-format credentials line for git credential-store
                const { hostname } = new URL(repo.url);
                const credLine = `https://x-access-token:${refPat}@${hostname}`;
                await containerManager.writeFile(containerId, credHelper, `${credLine}\n`);
                try {
                  await containerManager.execInContainer(
                    containerId,
                    [
                      'git',
                      '-c',
                      `credential.helper=store --file ${credHelper}`,
                      'clone',
                      '--depth',
                      '1',
                      repo.url,
                      destPath,
                    ],
                    { timeout: 60_000 },
                  );
                } finally {
                  await containerManager.execInContainer(containerId, ['rm', '-f', credHelper], {
                    timeout: 5_000,
                  });
                }
              } else {
                await containerManager.execInContainer(
                  containerId,
                  ['git', 'clone', '--depth', '1', repo.url, destPath],
                  { timeout: 60_000 },
                );
              }
            } catch (err) {
              logger.warn(
                { err, podId, url: repo.url },
                'Failed to clone reference repo — skipping',
              );
            }
          }
        }

        const previewUrl = `http://127.0.0.1:${hostPort}`;
        pod = transition(pod, 'running', {
          containerId,
          worktreePath,
          previewUrl,
        });

        // Resolve and write skills for all pod types (including workspace)
        const mergedSkills = mergeSkills(daemonConfig.skills ?? [], profile.skills ?? []);
        let resolvedSkillNames: string[] = [];
        if (mergedSkills.length > 0) {
          emitStatus('Resolving skills…');
          const resolvedSkills = await resolveSkills(mergedSkills, logger);
          const skillsDir = `${CONTAINER_HOME_DIR}/.claude/skills`;
          for (const skill of resolvedSkills) {
            await containerManager.writeFile(
              containerId,
              `${skillsDir}/${skill.name}/SKILL.md`,
              skill.content,
            );
          }
          resolvedSkillNames = resolvedSkills.map((s) => s.name);
          if (resolvedSkills.length > 0) {
            logger.info(
              { podId, count: resolvedSkills.length, names: resolvedSkillNames },
              'Skills written to container',
            );
          }
        }

        // Write private registry config files (.npmrc / NuGet.config) to user-level
        // paths inside the container. Runs for ALL pod types including workspace pods.
        // NuGet configs are sources-only — auth is via credential provider env var above.
        const registryFiles = buildRegistryFiles(profile.privateRegistries, effectiveRegistryPat);
        for (const file of registryFiles) {
          await containerManager.writeFile(containerId, file.path, file.content);
          logger.info(
            { podId, path: file.path, bytes: file.content.length },
            'Wrote registry config file to container',
          );
        }

        // Install a git pre-commit hook that blocks commits containing hardcoded
        // credentials (ClearTextPassword, _authToken, etc.). Defense-in-depth:
        // even if system instructions are ignored, the commit will be rejected.
        //
        // IMPORTANT: In a git worktree, .git is a gitlink FILE (not a directory)
        // pointing to the bare repo's worktree metadata. Using writeFile() would
        // create a .git DIRECTORY via tar extraction, destroying the gitlink and
        // breaking all git operations inside the container. We stage the hook in
        // /tmp, then use `git rev-parse --git-dir` to install it at the real path.
        await containerManager.writeFile(containerId, '/tmp/pre-commit', CREDENTIAL_GUARD_HOOK);
        await containerManager.execInContainer(
          containerId,
          [
            'sh',
            '-c',
            'GIT_DIR=$(git -C /workspace rev-parse --git-dir) && mkdir -p "$GIT_DIR/hooks" && mv /tmp/pre-commit "$GIT_DIR/hooks/pre-commit" && chmod +x "$GIT_DIR/hooks/pre-commit"',
          ],
          { timeout: 5_000 },
        );

        // Interactive pods: container stays alive, no agent/validation/PR
        if (pod.options.agentMode === 'interactive') {
          // Write Claude UX config (disclaimer ack, folder trust, theme, auto-updater off) so
          // `claude` inside the container doesn't show first-run theme/trust/disclaimer prompts.
          // Workspace pods intentionally do NOT pre-seed provider credentials — the user runs
          // `/login` manually inside the container. Rationale: pre-seeded OAuth tokens can be
          // silently rejected by Anthropic (policy changes, Enterprise org restrictions, etc.),
          // producing a confusing "logged in as enterprise → 401" state. Manual /login keeps
          // the surprise surface zero.
          for (const file of buildClaudeConfigFiles()) {
            await containerManager.writeFile(containerId, file.path, file.content);
          }
          // Capture starting HEAD so the diff endpoint only shows workspace changes,
          // not the entire branch history since it diverged from main.
          try {
            const shaResult = await containerManager.execInContainer(
              containerId,
              ['git', 'rev-parse', 'HEAD'],
              { cwd: '/workspace', timeout: 5_000 },
            );
            if (shaResult.exitCode === 0 && shaResult.stdout.trim()) {
              podRepo.update(podId, { startCommitSha: shaResult.stdout.trim() });
            }
          } catch {
            logger.debug({ podId }, 'Failed to capture workspace start commit SHA');
          }
          // History workspace: export pod data into the container
          if (pod.task.startsWith('[history]')) {
            try {
              emitStatus('Exporting history data…');
              const queryMatch = pod.task.match(/\| (.+)$/);
              const historyQuery: HistoryQuery = queryMatch?.[1]
                ? (JSON.parse(queryMatch[1]) as HistoryQuery)
                : {};

              const exporter = createHistoryExporter({
                podRepo,
                // biome-ignore lint/style/noNonNullAssertion: validationRepo is required for history export
                validationRepo: validationRepo!,
                escalationRepo,
                // biome-ignore lint/style/noNonNullAssertion: eventRepo is required for history export
                eventRepo: deps.eventRepo!,
                // biome-ignore lint/style/noNonNullAssertion: progressEventRepo is required for history export
                progressEventRepo: progressEventRepo!,
                actionAuditRepo: deps.actionAuditRepo,
              });

              const { dbBuffer, summary, analysisGuide, stats } = exporter.export(historyQuery);

              // Create /history directory
              await containerManager.execInContainer(containerId, ['mkdir', '-p', '/history'], {
                timeout: 5_000,
              });

              await containerManager.writeFile(containerId, '/history/history.db', dbBuffer);
              await containerManager.writeFile(containerId, '/history/summary.md', summary);
              await containerManager.writeFile(
                containerId,
                '/history/analysis-guide.md',
                analysisGuide,
              );

              const instructions = generateHistoryInstructions(stats);
              await containerManager.writeFile(containerId, '/workspace/CLAUDE.md', instructions);

              logger.info(
                { podId, exportedSessions: stats.totalSessions },
                'History data exported to workspace container',
              );
            } catch (err) {
              logger.error({ err, podId }, 'Failed to export history data');
            }
          }

          // Activate PIM groups for this workspace pod
          if (pod.pimGroups?.length && pod.userId) {
            const { createPimClient } = await import('../actions/handlers/azure-pim-handler.js');
            const pimClient = createPimClient(deps.getSecret, logger);
            for (const group of pod.pimGroups) {
              try {
                await pimClient.activate(
                  group.groupId,
                  pod.userId,
                  group.duration ?? 'PT8H',
                  group.justification ?? `Workspace pod ${podId}`,
                );
                logger.info({ podId, groupId: group.groupId }, 'PIM group activated');
              } catch (err) {
                logger.warn(
                  { err, podId, groupId: group.groupId },
                  'PIM activation failed — continuing',
                );
              }
            }
          }

          // Inject escalation + profile MCP servers into /workspace/.mcp.json so
          // interactive `claude` sessions in this workspace pod pick them up automatically.
          // Claude Code reads .mcp.json as project-level MCP config — this is the reliable
          // path; settings.json mcpServers is not loaded by the Claude Code version in containers.
          try {
            const wsMcpServers = mergeMcpServers(daemonConfig.mcpServers, profile.mcpServers);
            const wsHttpServers = wsMcpServers.filter((s) => s.type !== 'stdio');
            const wsProxiedServers = wsHttpServers.map((s) => ({
              name: s.name,
              url: `${mcpBaseUrl}/mcp-proxy/${encodeURIComponent(s.name)}/${podId}`,
            }));
            const wsToken = deps.sessionTokenIssuer?.generate(podId);
            const wsAuthHeader = wsToken ? { Authorization: `Bearer ${wsToken}` } : undefined;

            const wsStdioServers = buildCodeIntelligenceServers(profile);
            const injectedServers: Record<string, unknown> = {
              escalation: {
                type: 'http',
                url: `${mcpBaseUrl}/mcp/${podId}`,
                ...(wsAuthHeader && { headers: wsAuthHeader }),
              },
              ...Object.fromEntries(
                wsProxiedServers.map((s) => [
                  s.name,
                  { type: 'http', url: s.url, ...(wsAuthHeader && { headers: wsAuthHeader }) },
                ]),
              ),
              ...Object.fromEntries(
                wsStdioServers.map((s) => [
                  s.name,
                  {
                    type: 'stdio',
                    command: s.command,
                    ...(s.args && { args: s.args }),
                    ...(s.env && { env: s.env }),
                  },
                ]),
              ),
            };

            // Merge with any existing /workspace/.mcp.json so project-configured servers survive.
            let existingMcp: Record<string, unknown> = {};
            try {
              const raw = await containerManager.readFile(containerId, '/workspace/.mcp.json');
              existingMcp = JSON.parse(raw) as Record<string, unknown>;
            } catch {
              // File absent or unreadable — start fresh
            }
            const existingServers =
              existingMcp.mcpServers && typeof existingMcp.mcpServers === 'object'
                ? (existingMcp.mcpServers as Record<string, unknown>)
                : {};
            const mergedMcp = {
              ...existingMcp,
              mcpServers: { ...existingServers, ...injectedServers },
            };

            await containerManager.writeFile(
              containerId,
              '/workspace/.mcp.json',
              JSON.stringify(mergedMcp, null, 2),
            );
            logger.info(
              { podId, servers: Object.keys(injectedServers) },
              'MCP servers injected into workspace .mcp.json',
            );
          } catch (err) {
            logger.warn(
              { err, podId },
              'Failed to inject MCP servers into workspace .mcp.json — MCP tools unavailable',
            );
          }

          // Surface the injected MCP tools to the human user. Without a doc and
          // a shell hint, validate_in_browser and friends are invisible — workspace
          // pods deliberately don't write a CLAUDE.md to /workspace/ to avoid
          // clobbering the repo, so we drop docs under the user's home instead.
          try {
            const httpServerNames = ['escalation', ...wsProxiedServers.map((s) => s.name)];
            const stdioServerNames = wsStdioServers.map((s) => s.name);
            const toolsDocPath = `${CONTAINER_HOME_DIR}/.config/autopod/tools.md`;
            const bashrcPath = `${CONTAINER_HOME_DIR}/.bashrc`;

            const toolsDoc = buildWorkspaceToolsDoc({ httpServerNames, stdioServerNames });
            await containerManager.writeFile(containerId, toolsDocPath, toolsDoc);

            let existingBashrc = '';
            try {
              existingBashrc = await containerManager.readFile(containerId, bashrcPath);
            } catch {
              // No .bashrc yet — that's fine, we'll create one.
            }
            const merged = mergeBashrcHint(existingBashrc, buildBashrcHintBlock(toolsDocPath));
            await containerManager.writeFile(containerId, bashrcPath, merged);

            logger.info({ podId, toolsDocPath }, 'Workspace tools doc + bashrc hint written');
          } catch (err) {
            logger.warn(
              { err, podId },
              'Failed to write workspace tools doc — MCP tools still work, just no discovery hint',
            );
          }

          logger.info({ podId }, 'Workspace pod running — awaiting manual attach');
          return;
        }

        // Merge daemon + profile injections
        const mergedMcpServers = mergeMcpServers(daemonConfig.mcpServers, profile.mcpServers);
        const mergedSections = mergeClaudeMdSections(
          daemonConfig.claudeMdSections,
          profile.claudeMdSections,
        );

        // Build stdio MCP servers from codeIntelligence profile flags.
        // These run as local subprocesses inside the container, started by the
        // agent CLI itself. They flow into SpawnConfig.mcpServers (alongside
        // HTTP entries) so the runtime writes them into its out-of-tree config
        // file (e.g. /home/autopod/.autopod/mcp-config.json for Claude). We
        // intentionally do NOT touch /workspace/.mcp.json here — that file
        // belongs to the user's repo, and any daemon-injected entry would
        // get swept up by `git add` and committed.
        const stdioMcpServers = buildCodeIntelligenceServers(profile);

        // Preflight: confirm each code-intel binary exists before injecting it.
        // Without this filter, a missing binary causes Claude CLI to silently
        // fail the stdio MCP spawn, the tools are never registered, and the
        // agent falls back to grep with no indication anything is wrong.
        // Servers that fail the check are dropped here so they never appear in
        // mcp-config.json or the CLAUDE.md — clean absence is less confusing
        // than a registered-but-broken tool.
        // Write the MCP init probe script once; each server test runs it with its
        // own command + args. Cleaned up after the loop.
        const MCP_PROBE_PATH = '/tmp/.autopod-mcp-probe.py';
        await containerManager.writeFile(containerId, MCP_PROBE_PATH, MCP_INIT_PROBE_SCRIPT);

        // Binary-check all servers first (fast) then probe survivors in parallel.
        // Language servers (Roslyn, C# LS) can take 60-90s to initialize on a
        // real project — sequential probing would add minutes to startup.
        const binaryOkServers: StdioInjectedMcpServer[] = [];
        await Promise.all(
          stdioMcpServers.map(async (server) => {
            const binaryCheck = await containerManager.execInContainer(
              containerId,
              ['sh', '-c', `command -v ${server.command} >/dev/null 2>&1`],
              { timeout: 5_000 },
            );
            if (binaryCheck.exitCode !== 0) {
              const msg = `Code-intel MCP "${server.name}" requested by profile but binary "${server.command}" not found in container — agent will fall back to grep/find. Rebuild the warm image: \`ap profile warm ${profile.name} --rebuild\`.`;
              logger.error({ podId, server: server.name, command: server.command }, msg);
              emitStatus(`⚠️ ${msg}`);
            } else {
              binaryOkServers.push(server);
            }
          }),
        );

        // MCP init probe — actually start each server and complete the JSON-RPC
        // initialize handshake. Catches language-server issues (missing NuGet/npm
        // cache, permission errors) that the binary check alone cannot detect.
        // Timeout = slow start (Roslyn on a large solution can take 90s+) — server
        // is still included in config and will initialize lazily inside the container.
        // Only a clean non-zero exit (server crashed or returned an error response)
        // triggers a rebuild suggestion.
        const workingStdioServers: StdioInjectedMcpServer[] = [...binaryOkServers];
        await Promise.all(
          binaryOkServers.map(async (server) => {
            const probeCmd = ['python3', MCP_PROBE_PATH, server.command, ...(server.args ?? [])];
            const mcpProbe = await containerManager.execInContainer(containerId, probeCmd, {
              timeout: 100_000,
              cwd: '/workspace',
            });

            if (mcpProbe.exitCode === 0) {
              logger.info(
                { podId, server: server.name },
                `Code-intel MCP "${server.name}" probe OK`,
              );
              emitStatus(`✅ Code-intel MCP "${server.name}" initialized and ready`);
            } else {
              const stderr = (mcpProbe.stderr || '').trim();
              const isTimeout = stderr.startsWith('timeout:');
              if (isTimeout) {
                logger.info(
                  { podId, server: server.name },
                  `Code-intel MCP "${server.name}" slow to start — will initialize inside container`,
                );
                emitStatus(
                  `🔄 Code-intel MCP "${server.name}" is starting (language server initializing in background)`,
                );
              } else {
                const detail = (mcpProbe.stdout || stderr || 'no output').slice(0, 200);
                logger.warn(
                  { podId, server: server.name, detail },
                  `Code-intel MCP "${server.name}" probe failed`,
                );
                emitStatus(
                  `⚠️ Code-intel MCP "${server.name}" binary found but failed to respond (${detail}). If this persists, rebuild: \`ap profile warm ${profile.name} --rebuild\``,
                );
              }
            }
          }),
        );

        await containerManager.execInContainer(containerId, ['rm', '-f', MCP_PROBE_PATH], {
          timeout: 3_000,
        });

        // Detect and auto-heal 0-byte .bin/ stubs before the agent starts. These are a
        // symptom of `npm install --ignore-scripts` overwriting valid stubs without running
        // postinstall hooks, leaving empty files that can't be executed.
        const stubScan = await containerManager
          .execInContainer(
            containerId,
            [
              'sh',
              '-c',
              'find /workspace -path "*/node_modules/.bin/*" -empty -print 2>/dev/null | head -10',
            ],
            { timeout: 5_000 },
          )
          .catch(() => null);
        const brokenStubs = stubScan?.stdout?.trim();
        if (brokenStubs) {
          const first5 = brokenStubs.split('\n').slice(0, 5).join(', ');
          logger.warn({ podId }, `0-byte .bin stubs detected before agent start: ${first5}`);
          emitStatus(`⚠️ 0-byte .bin stubs detected — running npm rebuild to restore them…`);
          const rebuildResult = await containerManager
            .execInContainer(
              containerId,
              [
                'sh',
                '-c',
                "find /workspace -path '*/node_modules/.bin/*' -empty -print 2>/dev/null | awk -F'/node_modules/' '{print $1}' | sort -u | while read -r dir; do [ -f \"$dir/package.json\" ] && (cd \"$dir\" && npm rebuild 2>&1); done",
              ],
              { timeout: 120_000 },
            )
            .catch((err: unknown) => ({
              stdout: '',
              stderr: err instanceof Error ? err.message : String(err),
              exitCode: 1,
            }));
          if (rebuildResult.exitCode === 0) {
            logger.info({ podId }, 'npm rebuild completed — bin stubs restored');
            emitStatus('✅ npm rebuild completed — bin stubs restored');
          } else {
            logger.warn({ podId }, `npm rebuild failed: ${rebuildResult.stdout?.slice(0, 300)}`);
            emitStatus(
              `⚠️ npm rebuild failed. Agent may encounter "Permission denied" errors for node_modules/.bin tools.`,
            );
          }
        }

        // Rewrite injected MCP server URLs to route through daemon proxy.
        // Only HTTP servers go through the proxy — stdio servers run as local
        // subprocesses in the container and are appended to mcpServers below.
        // Agent sees proxy URLs, daemon handles auth injection + PII stripping.
        const httpMcpServers = mergedMcpServers.filter((s) => s.type !== 'stdio');
        const proxiedMcpServers = httpMcpServers.map((s) => ({
          ...s,
          url: `${mcpBaseUrl}/mcp-proxy/${encodeURIComponent(s.name)}/${podId}`,
          // Don't expose auth headers to agent — proxy injects them
          headers: undefined,
        }));

        // Resolve available actions from profile's action policy.
        // resolveEffectiveActionPolicy auto-injects the 'deploy' group when
        // profile.deployment.enabled is true so users only have to flip one switch.
        const effectivePolicy = resolveEffectiveActionPolicy(profile);
        const availableActions = effectivePolicy
          ? (deps.actionEngine?.getAvailableActions(effectivePolicy) ?? [])
          : [];

        // Resolve dynamic sections (fetches URLs, respects token budgets)
        if (mergedSections.some((s) => s.fetch)) {
          emitStatus('Fetching dynamic CLAUDE.md sections…');
        }
        const resolvedSections = await resolveSections(mergedSections, logger);

        // Generate system instructions and deliver based on runtime
        const mcpUrl = `${mcpBaseUrl}/mcp/${podId}`;

        // Load approved memories for this pod
        const sessionMemories = deps.memoryRepo
          ? [
              ...deps.memoryRepo.list('global', null, true),
              ...deps.memoryRepo.list('profile', pod.profileName, true),
              ...deps.memoryRepo.list('pod', pod.id, true),
            ]
          : [];

        const systemInstructions = generateSystemInstructions(profile, pod, mcpUrl, {
          injectedSections: resolvedSections,
          injectedMcpServers: [...proxiedMcpServers, ...workingStdioServers],
          availableActions,
          injectedSkills: mergedSkills.filter((s) => resolvedSkillNames.includes(s.name)),
          memories: sessionMemories.length > 0 ? sessionMemories : undefined,
        });

        // Write system instructions to a path outside /workspace so the repo's own
        // CLAUDE.md / copilot-instructions.md is never overwritten.
        // Claude CLI reads this via --append-system-prompt-file; Copilot via customInstructions.
        emitStatus('Writing system instructions to container…');
        await containerManager.writeFile(
          containerId,
          AUTOPOD_INSTRUCTIONS_PATH,
          systemInstructions,
        );

        // Generate a pod-scoped token so the container can authenticate its MCP calls.
        // The token is passed as Authorization: Bearer on the escalation MCP server config
        // and verified by the /mcp/:podId route handler.
        const mcpSessionToken = deps.sessionTokenIssuer?.generate(podId);
        const escalationHeaders = mcpSessionToken
          ? { Authorization: `Bearer ${mcpSessionToken}` }
          : undefined;

        // Build MCP server list for runtime.
        // The pod token authenticates BOTH the escalation endpoint and the
        // proxied-MCP endpoints — without it a pod on another pod could
        // impersonate this pod and abuse its injected MCP credentials.
        // Stdio servers (serena, roslyn-codelens) are included here so the
        // runtime emits them into its out-of-tree config file. They never
        // touch the user's working tree.
        const mcpServers: McpServerConfig[] = [
          { type: 'http', name: 'escalation', url: mcpUrl, headers: escalationHeaders },
          ...proxiedMcpServers.map(
            (s) =>
              ({
                type: 'http',
                name: s.name,
                url: s.url,
                headers: escalationHeaders,
              }) satisfies McpServerConfig,
          ),
          ...workingStdioServers.map(
            (s) =>
              ({
                type: 'stdio',
                name: s.name,
                command: s.command,
                ...(s.args && { args: s.args }),
                ...(s.env && { env: s.env }),
              }) satisfies McpServerConfig,
          ),
        ];

        // Build provider-aware env (API keys, OAuth creds, Foundry config)
        emitStatus('Building provider credentials…');
        const providerResult = await buildProviderEnv(profile, podId, logger);
        const secretEnv: Record<string, string> = {
          POD_ID: podId,
          ...providerResult.env,
        };

        // Codex runtime: write OPENAI_API_KEY to a secret file, pass file path in env.
        if (pod.runtime === 'codex' && process.env.OPENAI_API_KEY) {
          const oaiFilePath = '/run/autopod/openai-api-key';
          providerResult.secretFiles.push({
            path: oaiFilePath,
            content: process.env.OPENAI_API_KEY,
          });
          secretEnv.OPENAI_API_KEY_FILE = oaiFilePath;
        }

        // NuGet PAT: write to a 0400 secret file instead of passing in exec env.
        const nugetSecret = buildNuGetSecretFile(profile.privateRegistries, effectiveRegistryPat);
        if (nugetSecret) {
          providerResult.secretFiles.push({ path: nugetSecret.path, content: nugetSecret.content });
          secretEnv[nugetSecret.envFileKey] = nugetSecret.path;
        }

        // Write provider credential files to container (e.g., OAuth .credentials.json for MAX)
        for (const file of providerResult.containerFiles) {
          await containerManager.writeFile(containerId, file.path, file.content);
          logger.info(
            { podId, path: file.path, bytes: file.content.length },
            'Wrote provider credential file to container',
          );
        }

        // Write secret files (API keys, tokens) to /run/autopod/ with mode 0400.
        // These are referenced by *_FILE env vars in secretEnv — the exec shim reads
        // them and sets the real env var before starting the agent process.
        await containerManager.execInContainer(containerId, ['mkdir', '-p', '/run/autopod'], {
          timeout: 5_000,
        });
        for (const sf of providerResult.secretFiles) {
          await containerManager.writeFile(containerId, sf.path, sf.content);
          await containerManager.execInContainer(containerId, ['chmod', '0400', sf.path], {
            timeout: 5_000,
          });
          logger.info({ podId, path: sf.path }, 'Wrote secret file to container (mode 0400)');
        }
        // Write the agent shim that reads *_FILE env vars and sets the real env var
        // before exec-ing the runtime. SDKs that don't support the _FILE convention
        // get the value via this shim so the raw secret is never in the exec's initial env.
        await containerManager.writeFile(containerId, AGENT_SHIM_PATH, AGENT_SHIM_SCRIPT);
        await containerManager.execInContainer(containerId, ['chmod', '0500', AGENT_SHIM_PATH], {
          timeout: 5_000,
        });

        // Verify credential files are readable by the container user
        if (providerResult.containerFiles.length > 0) {
          const verifyResult = await containerManager.execInContainer(containerId, [
            'sh',
            '-c',
            providerResult.containerFiles.map((f) => `ls -la ${f.path}`).join(' && '),
          ]);
          logger.info(
            { podId, stdout: verifyResult.stdout.trim(), stderr: verifyResult.stderr.trim() },
            'Credential file verification',
          );
        }

        // Ensure NuGet credential provider is installed (base image install can fail silently)
        const hasNugetRegistries = registryFiles.some((f) =>
          f.path.toLowerCase().endsWith('nuget.config'),
        );
        if (hasNugetRegistries) {
          try {
            await ensureNuGetCredentialProvider(containerManager, containerId);
            logger.info({ podId }, 'NuGet credential provider verified');
          } catch (cpErr) {
            logger.error({ podId, err: cpErr }, 'Failed to ensure NuGet credential provider');
            emitActivityStatus(
              podId,
              `⚠ Credential provider install failed: ${(cpErr as Error).message}`,
            );
          }
        }

        // Early validation: verify registry configs are parseable before agent starts.
        // Pass the NuGet credential env so the auth probe (`dotnet nuget search`) can
        // actually authenticate against the private feed — execInContainer otherwise
        // inherits an empty VSS_NUGET_EXTERNAL_FEED_ENDPOINTS from the image and
        // silently 401s.
        if (registryFiles.length > 0) {
          const probeEnv = buildNuGetCredentialEnv(profile.privateRegistries, effectiveRegistryPat);
          try {
            await validateRegistryFiles(
              containerManager,
              containerId,
              registryFiles,
              Object.keys(probeEnv).length > 0 ? probeEnv : undefined,
            );
            logger.info({ podId }, 'Registry config validation passed');
          } catch (regErr) {
            logger.error(
              { podId, err: regErr },
              'Registry config validation failed — pod will likely fail at build time',
            );
            emitActivityStatus(
              podId,
              `⚠ Registry config check failed: ${(regErr as Error).message}`,
            );
          }
        }

        // Start the agent — recovery mode uses resume for Claude, fresh spawn for others
        emitStatus('Spawning agent…');
        const runtime = runtimeRegistry.get(pod.runtime);
        let events: AsyncIterable<AgentEvent>;

        // For Copilot, defensively merge the repo's own instructions (if any) with ours.
        // We can't be sure Copilot CLI reads both $COPILOT_HOME/copilot-instructions.md
        // and .github/copilot-instructions.md, so prepend the repo's file to be safe.
        let copilotInstructions: string | undefined;
        if (pod.runtime === 'copilot') {
          copilotInstructions = systemInstructions;
          try {
            const repoInstructions = await containerManager.readFile(
              containerId,
              '/workspace/.github/copilot-instructions.md',
            );
            if (repoInstructions.trim()) {
              copilotInstructions = `${repoInstructions}\n\n---\n\n${systemInstructions}`;
              logger.info(
                { podId },
                'Merged repo copilot-instructions.md with autopod system instructions',
              );
            }
          } catch {
            // No repo-level copilot instructions — use ours as-is
          }
        }

        if (isRework) {
          // Rework: always a fresh spawn with rework-specific framing.
          // claudeSessionId was already cleared by triggerValidation so we never
          // resume a stale/broken pod context.
          emitStatus('Reworking pod…');
          // biome-ignore lint/style/noNonNullAssertion: reworkReason is always set when isRework=true; worktreePath is non-null when isRework=true (rework requires a prior run with a worktree)
          const reworkTask = await buildReworkTask(pod, worktreePath!, pod.reworkReason!);
          events = runtime.spawn({
            podId,
            task: reworkTask,
            model: pod.model,
            workDir: '/workspace',
            containerId,
            customInstructions: copilotInstructions,
            env: secretEnv,
            mcpServers,
          });

          // Clear rework reason now that it's been consumed (one-shot)
          podRepo.update(podId, { reworkReason: null });
        } else if (isRecovery && pod.runtime === 'claude' && pod.claudeSessionId) {
          // Crash recovery: attempt Claude --resume with persisted pod ID
          emitStatus('Resuming Claude pod…');

          // Rehydrate the in-memory pod ID map so resume() can find it
          if ('setClaudeSessionId' in runtime) {
            (runtime as ClaudeRuntime).setClaudeSessionId(podId, pod.claudeSessionId);
          }

          // biome-ignore lint/style/noNonNullAssertion: worktreePath is non-null for recovery pods (recovery requires a prior run with a worktree)
          const continuationPrompt = await buildContinuationPrompt(pod, worktreePath!);

          try {
            events = runtime.resume(podId, continuationPrompt, containerId, secretEnv);
          } catch (err) {
            logger.warn({ err, podId }, 'Claude --resume failed, falling back to fresh spawn');
            // biome-ignore lint/style/noNonNullAssertion: worktreePath is non-null for recovery pods
            const recoveryTask = await buildRecoveryTask(pod, worktreePath!);
            events = runtime.spawn({
              podId,
              task: recoveryTask,
              model: pod.model,
              workDir: '/workspace',
              containerId,
              customInstructions: copilotInstructions,
              env: secretEnv,
              mcpServers,
            });
          }
        } else if (isRecovery) {
          // Non-Claude runtime or no claudeSessionId — fresh spawn with recovery context
          // biome-ignore lint/style/noNonNullAssertion: worktreePath is non-null for recovery pods
          const recoveryTask = await buildRecoveryTask(pod, worktreePath!);
          events = runtime.spawn({
            podId,
            task: recoveryTask,
            model: pod.model,
            workDir: '/workspace',
            containerId,
            customInstructions: copilotInstructions,
            env: secretEnv,
            mcpServers,
          });
        } else {
          // Normal path
          events = runtime.spawn({
            podId,
            task: pod.task,
            model: pod.model,
            workDir: '/workspace',
            containerId,
            customInstructions: copilotInstructions,
            env: secretEnv,
            mcpServers,
          });
        }

        await this.consumeAgentEvents(podId, events);

        // Persist rotated OAuth credentials if provider requires it (MAX/PRO token rotation)
        if (providerResult.requiresPostExecPersistence) {
          try {
            await persistRefreshedCredentials(
              containerId,
              containerManager,
              profileStore,
              pod.profileName,
              logger,
            );
          } catch (err) {
            logger.warn(
              { err, podId },
              'Failed to persist refreshed credentials — pod still succeeded',
            );
          }
        }

        await this.handleCompletion(podId);
      } catch (err) {
        logger.error({ err, podId }, 'Pod processing error');
        // Transition to failed — keeps series dependents queued so they can run once the parent
        // is recovered/retried. 'killed' is reserved for explicit user termination only.
        try {
          pod = podRepo.getOrThrow(podId);
          if (!isTerminalState(pod.status)) {
            if (canFail(pod.status)) {
              transition(pod, 'failed', { completedAt: new Date().toISOString() });
            } else if (canKill(pod.status)) {
              // Fallback for states not yet reachable via 'failed' (validated, review_required, etc.)
              transition(pod, 'killing');
              pod = podRepo.getOrThrow(podId);
              transition(pod, 'killed', { completedAt: new Date().toISOString() });
            }
          }
        } catch {
          /* swallow — best effort */
        }
      }
    },

    async consumeAgentEvents(podId: string, events: AsyncIterable<AgentEvent>): Promise<void> {
      startCommitPolling(podId);
      try {
        for await (const event of events) {
          eventBus.emit({
            type: 'pod.agent_activity',
            timestamp: event.timestamp,
            podId,
            event,
          });

          if (event.type === 'escalation') {
            const pod = podRepo.getOrThrow(podId);
            if (pod.status === 'running') {
              const escalationPayload = event.payload.payload;
              const escalationSummary =
                'question' in escalationPayload
                  ? escalationPayload.question
                  : 'description' in escalationPayload
                    ? escalationPayload.description
                    : 'Agent requested input';
              emitActivityStatus(
                podId,
                `Waiting for human input [${event.escalationType}]: ${escalationSummary}`,
              );
              transition(pod, 'awaiting_input', {
                pendingEscalation: event.payload,
                escalationCount: pod.escalationCount + 1,
              });
            }
          } else if (event.type === 'plan') {
            podRepo.update(podId, {
              plan: { summary: event.summary, steps: event.steps },
            });
          } else if (event.type === 'progress') {
            podRepo.update(podId, {
              progress: {
                phase: event.phase,
                description: event.description,
                currentPhase: event.currentPhase,
                totalPhases: event.totalPhases,
              },
            });
            progressEventRepo?.insert(
              podId,
              event.phase,
              event.description,
              event.currentPhase,
              event.totalPhases,
            );
          } else if (event.type === 'task_summary') {
            podRepo.update(podId, {
              taskSummary: {
                actualSummary: event.actualSummary,
                how: event.how,
                deviations: event.deviations,
              },
            });
          } else if (event.type === 'status' && event.message.includes('Claude pod initialized')) {
            // Persist claude pod ID to DB for pause/resume survival across daemon restarts
            const match = event.message.match(/\(([^)]+)\)$/);
            if (match?.[1]) {
              podRepo.update(podId, { claudeSessionId: match[1] });
            }
          } else if (event.type === 'complete') {
            // Accumulate token counts and cost cumulatively across all runs in this pod
            const currentSession = podRepo.getOrThrow(podId);
            const newInputTokens = currentSession.inputTokens + (event.totalInputTokens ?? 0);
            const newOutputTokens = currentSession.outputTokens + (event.totalOutputTokens ?? 0);
            const tokenUpdates: PodUpdates = {};
            if (event.totalInputTokens !== undefined || event.totalOutputTokens !== undefined) {
              tokenUpdates.inputTokens = newInputTokens;
              tokenUpdates.outputTokens = newOutputTokens;
            }
            if (event.costUsd !== undefined) {
              tokenUpdates.costUsd = currentSession.costUsd + event.costUsd;
            }
            if (Object.keys(tokenUpdates).length > 0) {
              podRepo.update(podId, tokenUpdates);
            }

            // Token budget enforcement — only when token data is available
            const effectiveBudget = currentSession.tokenBudget;
            const totalUsed = newInputTokens + newOutputTokens;
            if (effectiveBudget !== null && effectiveBudget > 0 && totalUsed > 0) {
              const profile = profileStore.get(currentSession.profileName);
              const warnAt = profile.tokenBudgetWarnAt ?? 0.8;

              if (
                totalUsed >= Math.floor(effectiveBudget * warnAt) &&
                totalUsed < effectiveBudget
              ) {
                eventBus.emit({
                  type: 'pod.token_budget_warning',
                  timestamp: new Date().toISOString(),
                  podId,
                  tokensUsed: totalUsed,
                  tokenBudget: effectiveBudget,
                  percentUsed: totalUsed / effectiveBudget,
                });
              }

              if (totalUsed >= effectiveBudget) {
                const maxExtensions = profile.maxBudgetExtensions;
                const extensionsUsed = currentSession.budgetExtensionsUsed;
                const canExtend = maxExtensions === null || extensionsUsed < maxExtensions;
                const policy = profile.tokenBudgetPolicy ?? 'soft';

                emitActivityStatus(
                  podId,
                  `Token budget exceeded (${totalUsed}/${effectiveBudget} tokens used).${canExtend && policy === 'soft' ? ' Waiting for user approval to continue.' : ' Pod will be stopped.'}`,
                );
                eventBus.emit({
                  type: 'pod.token_budget_exceeded',
                  timestamp: new Date().toISOString(),
                  podId,
                  tokensUsed: totalUsed,
                  tokenBudget: effectiveBudget,
                  budgetExtensionsUsed: extensionsUsed,
                  maxBudgetExtensions: maxExtensions,
                });

                if (policy === 'hard' || !canExtend) {
                  emitActivityStatus(podId, 'Token budget hard limit reached — failing pod');
                  const s = podRepo.getOrThrow(podId);
                  if (s.status === 'running') {
                    transition(s, 'failed', { completedAt: new Date().toISOString() });
                  }
                } else {
                  // Soft policy: pause and await user approval
                  const s = podRepo.getOrThrow(podId);
                  if (s.status === 'running') {
                    transition(s, 'paused', { pauseReason: 'budget' });
                    logger.info(
                      { podId, totalUsed, effectiveBudget },
                      'Pod paused: token budget exceeded',
                    );
                  }
                }
                break;
              }
            } else if (effectiveBudget !== null && effectiveBudget > 0 && totalUsed === 0) {
              logger.warn(
                { podId, runtime: currentSession.runtime },
                'Token budget set but runtime emits no token data — budget not enforced',
              );
            }
          } else if (event.type === 'error' && event.fatal) {
            const pod = podRepo.getOrThrow(podId);
            if (pod.status === 'running') {
              emitActivityStatus(podId, `Agent failed: ${event.message}`);
              transition(pod, 'failed', { completedAt: new Date().toISOString() });
            }
            break;
          } else if (event.type === 'tool_use' || event.type === 'file_change') {
            touchHeartbeat(podId);
          }
        }
      } finally {
        stopCommitPolling(podId);
      }
    },

    async handleCompletion(podId: string): Promise<void> {
      const pod = podRepo.getOrThrow(podId);
      // Bail out if pod is already past the running stage (could happen when
      // processPod's spawn unblocks after sendMessage already drove completion)
      if (
        isTerminalState(pod.status) ||
        pod.status === 'killing' ||
        pod.status === 'paused' ||
        pod.status === 'validating' ||
        pod.status === 'validated' ||
        pod.status === 'failed' ||
        pod.status === 'review_required'
      ) {
        return;
      }

      // Artifact pods: extract /workspace, optionally push branch, skip validation entirely
      if (pod.options.output === 'artifact') {
        const profile = profileStore.get(pod.profileName);
        const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), '.autopod-data');
        const artifactsPath = path.join(dataDir, 'artifacts', podId);

        await mkdir(artifactsPath, { recursive: true });

        if (pod.containerId) {
          const cm = containerManagerFactory.get(pod.executionTarget);
          try {
            emitActivityStatus(podId, 'Collecting artifacts…');
            await cm.extractDirectoryFromContainer(pod.containerId, '/workspace', artifactsPath);
            logger.info({ podId, artifactsPath }, 'Artifacts extracted from container');
          } catch (err) {
            logger.warn(
              { err, podId },
              'Failed to extract artifacts — pod will complete with empty artifact store',
            );
          }
        }

        podRepo.update(podId, { artifactsPath });

        // If profile has a destination repo: lazy-clone, copy artifacts, push branch (best-effort)
        if (profile.repoUrl) {
          const repoBranch = pod.branch ?? `research/${podId}`;
          try {
            emitActivityStatus(podId, 'Pushing artifact branch…');
            const tempWorktreeParent = path.join(dataDir, 'artifact-worktrees');
            await mkdir(tempWorktreeParent, { recursive: true });
            const pat = selectGitPat(profile);
            const worktreeResult = await worktreeManager.create({
              repoUrl: profile.repoUrl,
              branch: repoBranch,
              baseBranch: pod.baseBranch ?? profile.defaultBranch ?? 'main',
              pat,
            });
            // Copy artifacts into the worktree (cp -a copies contents, trailing /. required)
            await execFileAsync('cp', [
              '-a',
              `${artifactsPath}/.`,
              `${worktreeResult.worktreePath}/`,
            ]);
            await worktreeManager.commitPendingChanges(
              worktreeResult.worktreePath,
              `research: ${pod.task.slice(0, 72)}`,
              { maxDeletions: 1000 },
            );
            await worktreeManager.pushBranch(worktreeResult.worktreePath, repoBranch);
            logger.info({ podId, branch: repoBranch }, 'Artifact branch pushed');
          } catch (err) {
            logger.warn(
              { err, podId },
              'Failed to push artifact branch — artifacts available via API',
            );
          }
        }

        // Transition to complete — skip validation entirely
        transition(pod, 'complete');
        return;
      }

      // Sync workspace back to host worktree before any host-side git reads
      let syncSucceeded = true;
      let agentCommitsPushed = true;
      if (pod.containerId && pod.worktreePath) {
        try {
          const cm = containerManagerFactory.get(pod.executionTarget);
          const result = await syncWorkspaceBack(pod.containerId, pod.worktreePath, cm);
          agentCommitsPushed = result.pushed;
          if (!agentCommitsPushed) {
            logger.warn(
              { podId },
              'Sync-back completed but push to bare did not — auto-commit will run with strict deletion guard',
            );
          }
        } catch (err) {
          syncSucceeded = false;
          agentCommitsPushed = false;
          logger.warn({ err, podId }, 'Failed to sync workspace back to host');
        }
      }

      // Auto-commit any uncommitted changes the agent left behind, then get diff stats.
      // When sync failed OR the in-container push didn't land on the bare, clamp deletions
      // to 0 so a `git add -A` over a partially-synced or stale-base worktree can't masquerade
      // as agent work. Push failure here is the canary for /workspace/.git diverging from
      // the host bare's branch tip — see syncWorkspaceBack for context.
      const safeAutoCommit = syncSucceeded && agentCommitsPushed;
      if (pod.worktreePath) {
        try {
          const committed = await worktreeManager.commitPendingChangesWithGeneratedMessage(
            pod.worktreePath,
            pod.task,
            { maxDeletions: safeAutoCommit ? 100 : 0 },
          );
          if (committed) {
            logger.info({ podId }, 'Auto-committed uncommitted agent changes');
          }
        } catch (err) {
          if (err instanceof DeletionGuardError && pod.containerId && pod.worktreePath) {
            logger.warn({ podId }, 'Deletion guard fired — attempting live container recovery');
            const cm = containerManagerFactory.get(pod.executionTarget);
            const recovered = await recoverWorktreeFromContainer(
              pod.containerId,
              pod.worktreePath,
              cm,
            );
            if (recovered) {
              try {
                await worktreeManager.commitPendingChangesWithGeneratedMessage(
                  pod.worktreePath,
                  pod.task,
                  { maxDeletions: 100 },
                );
                logger.info({ podId }, 'Auto-committed after live container recovery');
              } catch (retryErr) {
                logger.error(
                  { err: retryErr, podId },
                  'Commit after worktree recovery also failed',
                );
                handleDeletionGuardError(podId, retryErr);
              }
            } else {
              logger.error({ err, podId }, 'Auto-commit blocked by deletion safety guard');
              handleDeletionGuardError(podId, err);
            }
          } else {
            logger.error({ err, podId }, 'Auto-commit blocked by deletion safety guard');
            handleDeletionGuardError(podId, err);
          }
        }

        try {
          const profile = profileStore.get(pod.profileName);
          const defaultBranch = profile.defaultBranch ?? 'main';
          const sinceCommit = pod.startCommitSha ?? undefined;
          const baseBranchForStats = pod.baseBranch ?? defaultBranch;
          const stats = await worktreeManager.getDiffStats(
            pod.worktreePath,
            baseBranchForStats,
            sinceCommit,
          );
          podRepo.update(podId, {
            filesChanged: stats.filesChanged,
            linesAdded: stats.linesAdded,
            linesRemoved: stats.linesRemoved,
          });
        } catch (err) {
          logger.warn({ err, podId }, 'Failed to get diff stats');
        }
      }

      // Skip validation if requested or if agent made no changes.
      // Forked pods (linked or branched off a non-default branch) always validate —
      // the parent branch's changes need validation even when the forked agent adds nothing.
      const refreshed = podRepo.getOrThrow(podId);
      const profile2 = profileStore.get(refreshed.profileName);
      const noChanges = Boolean(pod.worktreePath) && refreshed.filesChanged === 0;
      const isForkSession =
        Boolean(refreshed.linkedPodId) ||
        (refreshed.baseBranch != null && refreshed.baseBranch !== profile2.defaultBranch);
      if (refreshed.skipValidation || (noChanges && !isForkSession)) {
        if (noChanges) {
          logger.info({ podId }, 'Skipping validation — no files changed');
          emitActivityStatus(podId, 'No files changed — skipping validation');
        }
        transition(refreshed, 'validating');
        const s2 = podRepo.getOrThrow(podId);
        const skippedPod = transition(s2, 'validated');
        maybeTriggerDependents(skippedPod);
        return;
      }

      // Trigger validation
      await this.triggerValidation(podId);
    },

    async sendMessage(podId: string, message: string): Promise<void> {
      const pod = podRepo.getOrThrow(podId);
      if (!canReceiveMessage(pod.status)) {
        throw new AutopodError(
          `Pod ${podId} is not awaiting input (status: ${pod.status})`,
          'INVALID_STATE',
          409,
        );
      }

      // ── Budget pause approval ──────────────────────────────────────────
      if (pod.pauseReason === 'budget') {
        const profile = profileStore.get(pod.profileName);
        const maxExtensions = profile.maxBudgetExtensions;
        const newExtensionsUsed = pod.budgetExtensionsUsed + 1;

        if (maxExtensions !== null && newExtensionsUsed > maxExtensions) {
          throw new AutopodError(
            `Pod ${podId} has reached the maximum budget extensions (${maxExtensions})`,
            'BUDGET_EXHAUSTED',
            409,
          );
        }

        emitActivityStatus(
          podId,
          `Budget extension approved (${newExtensionsUsed}). Proceeding to validation…`,
        );
        podRepo.update(podId, {
          budgetExtensionsUsed: newExtensionsUsed,
          pauseReason: null,
        });

        const refreshed = podRepo.getOrThrow(podId);
        transition(refreshed, 'running');

        try {
          await this.handleCompletion(podId);
        } catch (err) {
          logger.error({ err, podId }, 'Failed to handle completion after budget approval');
          const s = podRepo.getOrThrow(podId);
          if (!isTerminalState(s.status)) {
            transition(s, 'failed');
          }
          throw err;
        }
        return;
      }

      // ── Credential injection ──────────────────────────────────────────
      if (pod.pendingEscalation?.type === 'request_credential') {
        const payload = pod.pendingEscalation.payload as RequestCredentialPayload;
        const authMessage = await performCredentialInjection(podId, payload.service);

        escalationRepo.update(pod.pendingEscalation.id, {
          respondedAt: new Date().toISOString(),
          respondedBy: 'human',
          response: 'approved',
        });

        const escalationId = pod.pendingEscalation.id;
        transition(pod, 'running', { pendingEscalation: null });
        emitActivityStatus(podId, `Credential injected for ${payload.service} — resuming agent…`);

        deps.pendingRequestsByPod?.get(podId)?.resolve(escalationId, authMessage);
        return;
      }

      // ── Validation override responses ─────────────────────────────────
      if (pod.pendingEscalation?.type === 'validation_override') {
        const payload = pod.pendingEscalation.payload as ValidationOverridePayload;
        const overrides = parseValidationOverrideResponse(message, payload.findings);

        // Resolve the escalation in the DB
        escalationRepo.update(pod.pendingEscalation.id, {
          respondedAt: new Date().toISOString(),
          respondedBy: 'human',
          response: message,
        });

        // Merge new overrides into existing pod overrides
        const existingOverrides = pod.validationOverrides ?? [];
        const mergedOverrides = mergeOverrides(existingOverrides, overrides);
        podRepo.update(podId, {
          validationOverrides: mergedOverrides,
          pendingEscalation: null,
        });

        const hasGuidance = overrides.some((o) => o.action === 'guidance');

        if (!hasGuidance) {
          // All dismissed — re-run validation with overrides (doesn't burn an attempt)
          emitActivityStatus(podId, 'Overrides stored — re-running validation…');
          transition(pod, 'running');
          await this.triggerValidation(podId);
        } else {
          // Guidance provided — resume agent with human's instructions
          const guidanceText = overrides
            .filter((o) => o.action === 'guidance' && o.guidance)
            .map((o) => `- ${o.description}: ${o.guidance}`)
            .join('\n');

          const correctionMessage = [
            '## Human Reviewer Guidance',
            '',
            'The human reviewer provided the following instructions for recurring findings:',
            '',
            guidanceText,
            '',
            'Please address these items and try again.',
          ].join('\n');

          emitActivityStatus(podId, 'Resuming agent with human guidance…');
          transition(pod, 'running');

          try {
            const resumeEnv = await getResumeEnv(pod);
            const runtime = runtimeRegistry.get(pod.runtime);
            if (!pod.containerId) throw new Error(`Pod ${podId} has no container`);
            const events = runtime.resume(podId, correctionMessage, pod.containerId, resumeEnv);
            await this.consumeAgentEvents(podId, events);
            await this.handleCompletion(podId);
          } catch (err) {
            logger.error({ err, podId }, 'Failed to resume agent after override guidance');
            const s = podRepo.getOrThrow(podId);
            if (!isTerminalState(s.status)) {
              transition(s, 'failed');
            }
            throw err;
          }
        }

        logger.info(
          { podId, overrideCount: overrides.length, hasGuidance },
          'Validation override response processed',
        );
        return;
      }

      // ── Normal escalation responses ───────────────────────────────────
      emitActivityStatus(podId, 'Human replied — resuming agent…');
      transition(pod, 'running', { pendingEscalation: null });

      // If the pod was blocked on an ask_human MCP call, resolve the pending request.
      // The container's agent event stream is still active — no need to call runtime.resume().
      const pendingForSession = deps.pendingRequestsByPod?.get(podId);
      if (pendingForSession && pod.pendingEscalation?.id) {
        const resolved = pendingForSession.resolve(pod.pendingEscalation.id, message);
        if (resolved) {
          // The MCP ask_human call has been unblocked — processPod's consumeAgentEvents
          // loop will continue picking up events from the still-running container.
          return;
        }
      }

      emitActivityStatus(podId, 'Resuming agent with message…');
      try {
        const resumeEnv = await getResumeEnv(pod);
        const runtime = runtimeRegistry.get(pod.runtime);
        if (!pod.containerId) throw new Error(`Pod ${podId} has no container`);
        const events = runtime.resume(podId, message, pod.containerId, resumeEnv);
        await this.consumeAgentEvents(podId, events);
        await this.handleCompletion(podId);
      } catch (err) {
        logger.error({ err, podId }, 'Failed to resume agent after message');
        const s = podRepo.getOrThrow(podId);
        if (!isTerminalState(s.status)) {
          transition(s, 'failed');
          emitActivityStatus(
            podId,
            `Resume failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        throw err;
      }
    },

    async approveSession(podId: string, options?: { squash?: boolean }): Promise<void> {
      const pod = podRepo.getOrThrow(podId);

      // No-change pod: skip PR creation and branch push, complete directly.
      if (pod.filesChanged === 0 && pod.worktreePath && !pod.prUrl) {
        emitActivityStatus(podId, 'No changes to merge — completing pod');
        const s1 = transition(pod, 'approved');
        const s2 = transition(s1, 'merging');
        const noChangePod = transition(s2, 'complete', { completedAt: new Date().toISOString() });
        eventBus.emit({
          type: 'pod.completed',
          timestamp: new Date().toISOString(),
          podId,
          finalStatus: 'complete',
          summary: {
            id: podId,
            profileName: pod.profileName,
            task: pod.task,
            status: 'complete',
            model: pod.model,
            runtime: pod.runtime,
            duration: pod.startedAt ? Date.now() - new Date(pod.startedAt).getTime() : null,
            filesChanged: pod.filesChanged,
            createdAt: pod.createdAt,
          },
        });
        logger.info({ podId }, 'Pod approved with no changes — completed without PR');
        maybeTriggerDependents(noChangePod);
        return;
      }

      emitActivityStatus(podId, 'Approved — merging changes…');
      const s1 = transition(pod, 'approved');
      const s2 = transition(s1, 'merging');

      // Merge the PR if one was created, otherwise fall back to branch push
      const approveProfile = profileStore.get(pod.profileName);
      const prManager = prManagerFactory ? prManagerFactory(approveProfile) : null;
      if (pod.prUrl && prManager && pod.worktreePath) {
        // Fix pods make commits in the container but rely on the agent to push.
        // Push explicitly here before attempting to complete the PR so any local
        // commits the agent forgot (or failed) to push are flushed to the remote.
        try {
          await worktreeManager.pushBranch(pod.worktreePath, pod.branch ?? '');
          emitActivityStatus(podId, 'Branch pushed');
        } catch (pushErr) {
          logger.warn(
            { err: pushErr, podId },
            'Pre-merge push failed — proceeding with merge attempt',
          );
        }

        // Daemon-side approval gate: check the PR's review decision before attempting
        // to merge. If the platform reports that a review is still required or changes
        // were requested, enter merge_pending and let the poller wait for approval.
        // This ensures the daemon never bypasses required review gates even when
        // GitHub auto-merge is enabled.
        try {
          const prStatus = await prManager.getPrStatus({
            prUrl: pod.prUrl,
            worktreePath: pod.worktreePath,
          });
          if (prStatus.reviewDecision && prStatus.reviewDecision !== 'APPROVED') {
            const blockReason = `Waiting for PR review approval (current decision: ${prStatus.reviewDecision})`;
            emitActivityStatus(podId, `Merge pending: ${blockReason}`);
            transition(s2, 'merge_pending', { mergeBlockReason: blockReason });
            startMergePolling(podId);
            logger.info(
              { podId, prUrl: pod.prUrl, reviewDecision: prStatus.reviewDecision },
              'Merge deferred — PR requires explicit approval before daemon will merge',
            );
            return;
          }
        } catch (statusErr) {
          // Non-fatal: if we can't determine review status, proceed with the merge attempt
          logger.warn(
            { err: statusErr, podId, prUrl: pod.prUrl },
            'Failed to check PR review decision before merge — proceeding anyway',
          );
        }

        emitActivityStatus(podId, `Merging PR: ${pod.prUrl}`);
        try {
          const mergeResult = await prManager.mergePr({
            worktreePath: pod.worktreePath,
            prUrl: pod.prUrl,
            squash: options?.squash,
          });

          if (mergeResult.merged) {
            emitActivityStatus(podId, 'PR merged successfully');
          } else {
            // Merge didn't complete immediately — enter merge_pending state
            const initialStatus = await prManager.getPrStatus({
              prUrl: pod.prUrl,
              worktreePath: pod.worktreePath,
            });
            const blockReason = initialStatus.blockReason ?? 'Waiting for merge conditions';
            emitActivityStatus(podId, `Merge pending: ${blockReason}`);
            transition(s2, 'merge_pending', { mergeBlockReason: blockReason });
            startMergePolling(podId);
            logger.info(
              {
                podId,
                prUrl: pod.prUrl,
                blockReason,
                autoMerge: mergeResult.autoMergeScheduled,
              },
              'Pod approved — merge pending',
            );
            return;
          }
        } catch (err) {
          logger.error({ err, podId, prUrl: pod.prUrl }, 'Failed to merge PR');
          // Merge command failed — check if the PR is blocked by checks/reviews
          try {
            const fallbackStatus = await prManager.getPrStatus({
              prUrl: pod.prUrl,
              worktreePath: pod.worktreePath,
            });
            if (fallbackStatus.open && !fallbackStatus.merged) {
              const blockReason =
                fallbackStatus.blockReason ?? 'Merge failed — waiting for conditions';
              emitActivityStatus(podId, `Merge pending: ${blockReason}`);
              transition(s2, 'merge_pending', { mergeBlockReason: blockReason });
              startMergePolling(podId);
              logger.info(
                { podId, prUrl: pod.prUrl, blockReason },
                'Merge failed but PR is open — entering merge_pending',
              );
              return;
            }
          } catch (statusErr) {
            logger.warn({ err: statusErr, podId }, 'Failed to check PR status after merge failure');
          }
          emitActivityStatus(podId, 'PR merge failed — pod still completing');
        }
      } else if (!pod.prUrl && prManager && pod.worktreePath && pod.options?.output !== 'branch') {
        // PR creation failed during validation — retry it now
        emitActivityStatus(podId, 'No PR found — creating PR before merging…');
        try {
          const retryProfile = profileStore.get(pod.profileName);
          const retryDefaultBranch = retryProfile.defaultBranch ?? 'main';
          await worktreeManager.mergeBranch({
            worktreePath: pod.worktreePath,
            // Push the feature branch up so the PR can be opened against retryDefaultBranch.
            targetBranch: pod.branch,
            // Pass the PAT explicitly — approval retry runs post-container, so the
            // in-memory PAT cache may be cold after a daemon restart.
            pat: selectGitPat(retryProfile),
            // Post-container retry: sync-back already happened (or failed silently) upstream;
            // belt-and-suspenders autocommit here must not commit a phantom mass-deletion.
            maxDeletions: 0,
            // Provide pod task as context for any auto-generated commit message.
            podTask: pod.task,
          });
          const newPrUrl = await prManager.createPr({
            // biome-ignore lint/style/noNonNullAssertion: worktreePath is non-null in approval retry — pods reach approved only after successful validation which requires a worktree
            worktreePath: pod.worktreePath!,
            repoUrl: retryProfile.repoUrl ?? undefined,
            branch: pod.branch,
            baseBranch: retryDefaultBranch,
            podId,
            task: pod.task,
            profileName: pod.profileName,
            validationResult: null,
            filesChanged: pod.filesChanged,
            linesAdded: pod.linesAdded,
            linesRemoved: pod.linesRemoved,
            previewUrl: pod.previewUrl,
            screenshots: [],
            taskSummary: pod.taskSummary ?? undefined,
            seriesDescription: pod.seriesDescription ?? undefined,
            seriesName: pod.seriesName ?? undefined,
            securityFindings: getLatestPushFindings(podId),
          });
          podRepo.update(podId, { prUrl: newPrUrl });
          emitActivityStatus(podId, `PR created: ${newPrUrl}`);
          const retryMergeResult = await prManager.mergePr({
            worktreePath: pod.worktreePath,
            prUrl: newPrUrl,
            squash: options?.squash,
          });
          if (retryMergeResult.merged) {
            emitActivityStatus(podId, 'PR merged successfully');
          } else {
            const retryStatus = await prManager.getPrStatus({
              prUrl: newPrUrl,
              worktreePath: pod.worktreePath,
            });
            const blockReason = retryStatus.blockReason ?? 'Waiting for merge conditions';
            emitActivityStatus(podId, `Merge pending: ${blockReason}`);
            transition(s2, 'merge_pending', { mergeBlockReason: blockReason });
            startMergePolling(podId);
            return;
          }
        } catch (err) {
          logger.error({ err, podId }, 'Failed to create/merge PR during approval');
          if (!handleDeletionGuardError(podId, err)) {
            emitActivityStatus(podId, 'PR creation failed — branch is pushed but no PR was merged');
          }
        }
      } else if (pod.worktreePath) {
        // Fallback: no PR manager configured — push branch directly
        emitActivityStatus(podId, 'Pushing branch…');
        try {
          const profile = profileStore.get(pod.profileName);
          await worktreeManager.mergeBranch({
            worktreePath: pod.worktreePath,
            // Push the feature branch up to origin — no PR manager configured, so this is the
            // last step. Pushing onto profile.defaultBranch would force-push the feature work
            // straight onto main, which is never what we want.
            targetBranch: pod.branch,
            // Pass the PAT explicitly — fallback push runs post-container, so the
            // in-memory PAT cache may be cold after a daemon restart.
            pat: selectGitPat(profile),
            // Post-container fallback push: don't let a stale worktree commit a phantom mass-delete.
            maxDeletions: 0,
            podTask: pod.task,
          });
          emitActivityStatus(podId, 'Branch pushed successfully');
        } catch (err) {
          logger.error({ err, podId }, 'Failed to push branch during approval');
          if (!handleDeletionGuardError(podId, err)) {
            emitActivityStatus(podId, 'Branch push failed — pod still completing');
          }
        }
      }

      emitActivityStatus(podId, 'Pod complete');
      const completedPod = transition(s2, 'complete', { completedAt: new Date().toISOString() });

      eventBus.emit({
        type: 'pod.completed',
        timestamp: new Date().toISOString(),
        podId,
        finalStatus: 'complete',
        summary: {
          id: podId,
          profileName: pod.profileName,
          task: pod.task,
          status: 'complete',
          model: pod.model,
          runtime: pod.runtime,
          duration: pod.startedAt ? Date.now() - new Date(pod.startedAt).getTime() : null,
          filesChanged: pod.filesChanged,
          createdAt: pod.createdAt,
        },
      });

      logger.info({ podId, prUrl: pod.prUrl }, 'Pod approved and completed');
      maybeTriggerDependents(completedPod);
    },

    async rejectSession(podId: string, reason?: string): Promise<void> {
      const pod = podRepo.getOrThrow(podId);
      const previousStatus = pod.status as 'validated' | 'failed' | 'review_required';

      emitActivityStatus(
        podId,
        reason ? `Rejected by human: ${reason}` : 'Rejected by human — resuming agent…',
      );

      // Reset validation attempts — human is giving a fresh chance
      podRepo.update(podId, {
        validationAttempts: 0,
        lastValidationResult: null,
      });

      // Build rejection feedback message for the agent
      const rejectionMessage = formatFeedback({
        type: 'human_rejection',
        feedback: reason ?? 'Changes rejected. Please try again.',
        task: pod.task,
        previousStatus,
        attempt: 0,
        maxAttempts: pod.maxValidationAttempts,
      });

      // Transition to running
      transition(pod, 'running');

      try {
        if (!pod.containerId) throw new Error(`Pod ${podId} has no container`);

        // Container is stopped post-validation — restart it before resuming the agent
        const cm = containerManagerFactory.get(pod.executionTarget);
        await cm.start(pod.containerId);
        logger.info(
          { podId, containerId: pod.containerId },
          'Container restarted for rejection retry',
        );

        // Resume agent with rejection feedback
        const resumeEnv = await getResumeEnv(pod);
        const runtime = runtimeRegistry.get(pod.runtime);
        const events = runtime.resume(podId, rejectionMessage, pod.containerId, resumeEnv);
        await this.consumeAgentEvents(podId, events);
        await this.handleCompletion(podId);
      } catch (err) {
        // Roll back to failed — don't leave the pod stuck in 'running' with no agent
        logger.error({ err, podId }, 'Failed to resume agent after rejection');
        const s = podRepo.getOrThrow(podId);
        if (!isTerminalState(s.status)) {
          transition(s, 'failed');
          emitActivityStatus(
            podId,
            `Resume failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        throw err;
      }

      logger.info({ podId, reason, previousStatus }, 'Pod rejected, resuming agent with feedback');
    },

    async pauseSession(podId: string): Promise<void> {
      const pod = podRepo.getOrThrow(podId);
      if (!canPause(pod.status)) {
        throw new AutopodError(
          `Cannot pause pod ${podId} in status ${pod.status}`,
          'INVALID_STATE',
          409,
        );
      }

      emitActivityStatus(podId, 'Pausing pod…');
      // Suspend the runtime (kills stream but preserves pod ID)
      const runtime = runtimeRegistry.get(pod.runtime);
      await runtime.suspend(podId);

      transition(pod, 'paused', { pauseReason: 'manual' });
      emitActivityStatus(podId, 'Pod paused — use [t] tell or [u] nudge to resume');
      logger.info({ podId }, 'Pod paused');
    },

    nudgeSession(podId: string, message: string): void {
      const pod = podRepo.getOrThrow(podId);
      if (!canNudge(pod.status)) {
        throw new AutopodError(
          `Cannot nudge pod ${podId} in status ${pod.status}`,
          'INVALID_STATE',
          409,
        );
      }

      nudgeRepo.queue(podId, message);
      emitActivityStatus(podId, `Nudge queued: ${message}`);
      logger.info({ podId }, 'Nudge message queued');
    },

    async killSession(podId: string): Promise<void> {
      clearPreviewTimer(podId);
      stopMergePolling(podId);
      const pod = podRepo.getOrThrow(podId);
      if (!canKill(pod.status)) {
        throw new AutopodError(
          `Cannot kill pod ${podId} in status ${pod.status}`,
          'INVALID_STATE',
          409,
        );
      }

      emitActivityStatus(podId, 'Killing pod…');
      transition(pod, 'killing');

      // Run cleanup with a timeout so a hung Docker stop or git cleanup
      // can never leave the pod stuck in 'killing' forever.
      const KILL_TIMEOUT_MS = 30_000;
      const cleanup = async () => {
        // Kill sidecars before the main container so they can't outlive their pod.
        await killSidecarsForPod(podId);
        await cleanupTestRunBranches(podId);
        // Kill container
        if (pod.containerId) {
          try {
            const cm = containerManagerFactory.get(pod.executionTarget);
            await cm.kill(pod.containerId);
          } catch (err) {
            logger.warn({ err, podId }, 'Failed to kill container');
          }
        }
        // Remove the per-pod bridge network. Safe now that both the pod and
        // its sidecars are dead; Docker would otherwise refuse the remove.
        await destroyPodNetwork(podId);

        // Abort runtime
        try {
          const runtime = runtimeRegistry.get(pod.runtime);
          await runtime.abort(podId);
        } catch (err) {
          logger.warn({ err, podId }, 'Failed to abort runtime');
        }

        // Cleanup worktree — always clear the DB path even if cleanup throws,
        // so a subsequent rework doesn't attempt recovery on a stale directory.
        if (pod.worktreePath) {
          try {
            await worktreeManager.cleanup(pod.worktreePath);
          } catch (err) {
            logger.warn({ err, podId }, 'Failed to cleanup worktree');
          }
          podRepo.update(podId, { worktreePath: null });
        }
      };

      await Promise.race([
        cleanup(),
        new Promise<void>((resolve) =>
          setTimeout(() => {
            logger.warn({ podId }, 'Kill cleanup timed out — forcing killed');
            resolve();
          }, KILL_TIMEOUT_MS),
        ),
      ]);

      const killingSession = podRepo.getOrThrow(podId);
      transition(killingSession, 'killed', { completedAt: new Date().toISOString() });

      eventBus.emit({
        type: 'pod.completed',
        timestamp: new Date().toISOString(),
        podId,
        finalStatus: 'killed',
        summary: {
          id: podId,
          profileName: pod.profileName,
          task: pod.task,
          status: 'killed',
          model: pod.model,
          runtime: pod.runtime,
          duration: pod.startedAt ? Date.now() - new Date(pod.startedAt).getTime() : null,
          filesChanged: pod.filesChanged,
          createdAt: pod.createdAt,
        },
      });

      logger.info({ podId }, 'Pod killed');
    },

    /**
     * Promote an interactive pod to an agent-driven (`auto`) pod on
     * the same pod ID. Keeps branch, event log, token budget, and
     * escalation history. Used when the human hands off work to the agent
     * via `ap complete <id> --pr` (or `--artifact`).
     *
     * Flow: sync `/workspace` back to host → stop interactive container →
     * transition to `handoff` → swap the pod's `pod` config → re-enqueue
     * for `processPod()` which will pick up in the new mode.
     */
    async promoteToAuto(
      podId: string,
      targetOutput: 'pr' | 'branch' | 'artifact' | 'none',
      options?: { instructions?: string },
    ): Promise<void> {
      const pod = podRepo.getOrThrow(podId);

      if (!canPromote(pod.status, pod.options)) {
        throw new AutopodError(
          `Cannot promote pod ${podId} in status '${pod.status}' — must be an interactive, promotable, running pod`,
          'INVALID_STATE',
          409,
        );
      }

      const profile = profileStore.get(pod.profileName);
      if (targetOutput === 'pr' && !profile.repoUrl) {
        throw new AutopodError(
          `Cannot promote to 'pr' — profile '${profile.name}' has no repoUrl`,
          'INVALID_CONFIGURATION',
          400,
        );
      }

      // Capture the human's handoff instructions BEFORE the transition so they
      // survive the recovery restart. The recovery path inside processPod reads
      // them after `syncWorkspaceBack()` completes and composes `handoffContext`.
      const trimmedInstructions = options?.instructions?.trim();
      if (trimmedInstructions && trimmedInstructions.length > 0) {
        podRepo.update(podId, { handoffInstructions: trimmedInstructions });
      }

      // Swap to the worker profile if one is configured — this lets the
      // interactive profile keep a minimal setup and delegate the heavy
      // agent config (model, validation, PR provider) to a sibling profile.
      const targetProfileName = profile.workerProfile ?? pod.profileName;
      const targetProfile =
        targetProfileName === pod.profileName ? profile : profileStore.get(targetProfileName);

      const newPod: PodOptions = {
        agentMode: 'auto',
        output: targetOutput,
        validate: targetOutput === 'pr',
        promotable: false,
      };

      transition(pod, 'handoff', {
        options: newPod,
        // Reuse the existing worktree in recovery mode so the agent resumes
        // on the human's in-flight work.
        recoveryWorktreePath: pod.worktreePath,
        // containerId is intentionally kept — processPod reads it to sync the
        // workspace and stop the container before spawning the agent container.
      });

      // If we're switching profiles for the worker phase, snapshot the new
      // one so the agent runs under the right model/validation config.
      if (targetProfile.name !== pod.profileName) {
        podRepo.update(podId, {
          profileSnapshot: targetProfile,
        });
      }

      eventBus.emit({
        type: 'pod.status_changed',
        timestamp: new Date().toISOString(),
        podId,
        previousStatus: 'handoff',
        newStatus: 'handoff',
      });

      enqueueSession(podId);
      logger.info(
        { podId, targetOutput, targetProfile: targetProfile.name },
        'Pod promoted interactive → auto',
      );
    },

    async completeSession(
      podId: string,
      options?: {
        promoteTo?: 'pr' | 'branch' | 'artifact' | 'none';
        instructions?: string;
      },
    ): Promise<{ pushError?: string; promotedTo?: 'pr' | 'branch' | 'artifact' | 'none' }> {
      const pod = podRepo.getOrThrow(podId);

      if (pod.options.agentMode !== 'interactive') {
        throw new AutopodError(
          'Only interactive pods can be completed via this endpoint',
          'INVALID_OUTPUT_MODE',
          400,
        );
      }

      if (pod.status !== 'running') {
        throw new AutopodError(
          `Cannot complete pod in status '${pod.status}' — must be 'running'`,
          'INVALID_STATE',
          409,
        );
      }

      // If caller asked us to promote (e.g. `ap complete <id> --pr`), hand off
      // into the agent-driven flow instead of just pushing + completing.
      if (options?.promoteTo && options.promoteTo !== 'branch') {
        await this.promoteToAuto(podId, options.promoteTo, {
          instructions: options.instructions,
        });
        return { promotedTo: options.promoteTo };
      }

      let pushError: string | undefined;

      if (pod.options.output === 'artifact') {
        // Artifact pods: tar-stream /workspace out to the host data dir and
        // complete. Mirrors the auto-mode path in processPod (~line 2362), minus
        // the optional branch push — if the user picked `artifact` they want a
        // file drop, not a PR. To get a branch in the same motion, promote
        // via `ap complete <id> --pr`.
        const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), '.autopod-data');
        const artifactsPath = path.join(dataDir, 'artifacts', podId);
        await mkdir(artifactsPath, { recursive: true });

        if (pod.containerId) {
          const cm = containerManagerFactory.get(pod.executionTarget);
          try {
            emitActivityStatus(podId, 'Collecting artifacts…');
            await cm.extractDirectoryFromContainer(pod.containerId, '/workspace', artifactsPath);
            logger.info({ podId, artifactsPath }, 'Artifacts extracted from container');
          } catch (err) {
            logger.warn(
              { err, podId },
              'Failed to extract artifacts — completing with empty artifact store',
            );
          }
        }

        podRepo.update(podId, { artifactsPath });
      } else {
        // Sync workspace changes back to host worktree before pushing
        let workspaceSyncOk = true;
        if (pod.containerId && pod.worktreePath) {
          try {
            const cm = containerManagerFactory.get(pod.executionTarget);
            await syncWorkspaceBack(pod.containerId, pod.worktreePath, cm);
          } catch (err) {
            workspaceSyncOk = false;
            logger.warn({ err, podId }, 'Failed to sync workspace before push');
          }
        }

        // Push the branch to origin before completing, then clean up the worktree.
        // Only remove the worktree if push succeeds — don't lose uncommitted work.
        if (pod.worktreePath) {
          try {
            // Pre-push security scan for workspace-pod auto-push. The engine
            // rewrites block→escalate for workspace pods at the push checkpoint
            // so the human at the keyboard sees the warning rather than a hard
            // fail; runPushCheckpointScan only throws when block stays a block,
            // which happens for non-workspace pods (handled at validating entry).
            const pushScanProfile = profileStore.get(pod.profileName);
            await runPushCheckpointScan(pod, pushScanProfile);
            // Refuse to push a workspace pod directly to the default branch — this almost
            // always means the user passed `--branch main` by mistake. fixManually() pods
            // have linkedPodId set and are explicitly exempt.
            const completionBaseBranch = pod.baseBranch ?? pushScanProfile?.defaultBranch ?? 'main';
            if (!pod.linkedPodId && pod.branch === completionBaseBranch) {
              throw new AutopodError(
                `Refusing to push workspace pod directly to default branch '${pod.branch}'. Use ap complete <id> --pr or check out a feature branch first.`,
                'INVALID_STATE',
                409,
              );
            }
            // mergeBranch auto-commits any remaining uncommitted changes before pushing.
            // If sync-back failed, the host worktree may be missing files the index still
            // references — tighten the deletion guard so a ghost mass-delete cannot ship.
            const rawTask = pod.task?.trim() ?? '';
            const commitMessage =
              rawTask.length > 0
                ? rawTask.length > 72
                  ? `${rawTask.slice(0, 69)}...`
                  : rawTask
                : 'chore: workspace session complete';
            await worktreeManager.mergeBranch({
              worktreePath: pod.worktreePath,
              targetBranch: pod.branch ?? 'HEAD',
              // Pass the PAT explicitly — workspace pods auto-push on container exit,
              // possibly hours/days after the worktree was created. The in-memory PAT
              // cache may be cold after a daemon restart in between.
              pat: selectGitPat(pushScanProfile),
              maxDeletions: workspaceSyncOk ? 100 : 0,
              commitMessage,
            });
            logger.info({ podId, branch: pod.branch }, 'Workspace branch pushed to origin');
            // Safe to clean up — work is in origin
            try {
              await worktreeManager.cleanup(pod.worktreePath);
              logger.info({ podId }, 'Workspace worktree cleaned up');
            } catch (err) {
              logger.warn({ err, podId }, 'Failed to cleanup workspace worktree');
            }
          } catch (err) {
            pushError = err instanceof Error ? err.message : String(err);
            logger.warn(
              { err, podId },
              'Failed to push workspace branch — completing anyway, worktree preserved',
            );
            handleDeletionGuardError(podId, err);
          }
        }
      }

      emitActivityStatus(podId, 'Pod complete');
      transition(pod, 'complete', { completedAt: new Date().toISOString() });

      // Deactivate PIM groups on pod completion
      if (pod.pimGroups?.length && pod.userId) {
        try {
          const { createPimClient } = await import('../actions/handlers/azure-pim-handler.js');
          const pimClient = createPimClient(deps.getSecret, logger);
          for (const group of pod.pimGroups) {
            try {
              await pimClient.deactivate(group.groupId, pod.userId);
              logger.info({ podId, groupId: group.groupId }, 'PIM group deactivated');
            } catch (err) {
              logger.warn(
                { err, podId, groupId: group.groupId },
                'PIM deactivation failed — continuing',
              );
            }
          }
        } catch (err) {
          logger.warn({ err, podId }, 'Failed to load PIM client for deactivation');
        }
      }

      eventBus.emit({
        type: 'pod.completed',
        timestamp: new Date().toISOString(),
        podId,
        finalStatus: 'complete',
        summary: {
          id: podId,
          profileName: pod.profileName,
          task: pod.task,
          status: 'complete',
          model: pod.model,
          runtime: pod.runtime,
          duration: pod.startedAt ? Date.now() - new Date(pod.startedAt).getTime() : null,
          filesChanged: pod.filesChanged,
          createdAt: pod.createdAt,
        },
      });

      // Auto-revalidate linked worker pod if this workspace was a fix
      if (pod.linkedPodId && !pushError) {
        try {
          const linked = podRepo.getOrThrow(pod.linkedPodId);
          if (linked.status === 'failed' || linked.status === 'review_required') {
            logger.info(
              { workspaceId: podId, workerId: pod.linkedPodId },
              'Workspace completed — auto-revalidating linked worker',
            );
            emitActivityStatus(
              pod.linkedPodId,
              `Linked workspace ${podId} completed — pulling changes and revalidating…`,
            );
            // Fire and forget — don't block workspace completion on revalidation
            this.revalidateSession(pod.linkedPodId).catch((err) => {
              logger.warn(
                { err, workspaceId: podId, workerId: pod.linkedPodId },
                'Auto-revalidation of linked worker failed',
              );
            });
          }
        } catch (err) {
          logger.warn(
            { err, podId, linkedPodId: pod.linkedPodId },
            'Failed to check linked pod for auto-revalidation',
          );
        }
      }

      logger.info({ podId, pushError }, 'Workspace pod completed');
      return { pushError };
    },

    async triggerValidation(podId: string, options?: { force?: boolean }): Promise<void> {
      const pod = podRepo.getOrThrow(podId);
      const force = options?.force ?? false;

      // When force-reworking from a terminal state, re-provision the pod from scratch
      // instead of trying to restart a potentially stale container. Docker Desktop's VirtioFS
      // mounts can break after long idle periods, making the old container unreachable.
      const fromTerminal =
        pod.status === 'failed' ||
        pod.status === 'review_required' ||
        pod.status === 'killed' ||
        pod.status === 'validated';
      // Interactive pods can always be re-provisioned: no agent, no validation, no worktree required.
      const isInteractive = pod.options.agentMode === 'interactive';
      if (force && fromTerminal && (pod.worktreePath || isInteractive || !pod.containerId)) {
        emitActivityStatus(podId, 'Re-provisioning pod with fresh container…');

        // Kill the old container (best-effort — it may already be dead)
        await killSidecarsForPod(podId);
        await cleanupTestRunBranches(podId);
        if (pod.containerId) {
          try {
            const cm = containerManagerFactory.get(pod.executionTarget);
            await cm.kill(pod.containerId);
          } catch {
            // Container may already be removed — that's fine
          }
        }
        // The new container will be attached to a freshly-created per-pod
        // bridge below; blow away any stale bridge from the prior attempt.
        await destroyPodNetwork(podId);

        // Re-queue through processPod with recovery worktree.
        // Clear claudeSessionId so the agent gets a fresh spawn instead of resuming
        // a stale/broken pod context. Set reworkReason so processPod builds
        // a rework-specific prompt instead of the generic "you were interrupted" recovery prompt.
        // Interactive pods don't need a rework prompt — they get a fresh container.
        const reworkReason = isInteractive
          ? null
          : pod.status === 'failed'
            ? 'Your previous attempt failed. Review what went wrong and try again.'
            : pod.status === 'review_required'
              ? 'Your previous attempt exhausted its validation attempts. Review what went wrong and try again with extended attempts.'
              : pod.status === 'killed'
                ? 'Your previous pod was killed. Start the task fresh.'
                : 'Your previous work needs revision. Review and improve it.';
        podRepo.update(podId, {
          validationAttempts: 0,
          lastValidationResult: null,
          containerId: null,
          claudeSessionId: null,
          recoveryWorktreePath: pod.worktreePath ?? null,
          reworkReason,
          reworkCount: (pod.reworkCount ?? 0) + 1,
          recoveryCount: 0,
        });
        transition(pod, 'queued');
        enqueueSession(podId);

        logger.info(
          { podId, worktreePath: pod.worktreePath, reworkReason, isInteractive },
          'Rework: re-queued with fresh container provisioning',
        );
        return;
      }

      const profile = profileStore.get(pod.profileName);

      // Pre-push security scan: inspect the diff for secrets / PII / injection
      // before running validation. block decision throws and the pod's outer
      // error handler transitions to failed; warn / escalate findings ride
      // along into the PR body via scanRepo lookup at PR creation time.
      await runPushCheckpointScan(pod, profile);

      // Reset attempt counter when re-validating from a terminal/failed/validated state
      if (fromTerminal) {
        podRepo.update(podId, { validationAttempts: 0 });
      }

      const s1 = transition(pod, 'validating');
      const attempt = (fromTerminal ? 0 : s1.validationAttempts) + 1;
      podRepo.update(podId, { validationAttempts: attempt });

      eventBus.emit({
        type: 'pod.validation_started',
        timestamp: new Date().toISOString(),
        podId,
        attempt,
      });

      const reworkLabel = s1.reworkCount > 0 ? `rework ${s1.reworkCount}, ` : '';
      emitActivityStatus(
        podId,
        `Starting validation (${reworkLabel}attempt ${attempt}/${s1.maxValidationAttempts})…`,
      );

      try {
        if (!pod.containerId) {
          throw new Error(`Pod ${podId} has no container — cannot validate`);
        }

        // Restart the container if it was stopped (e.g. after max attempts exhausted)
        if (force) {
          const cm = containerManagerFactory.get(pod.executionTarget);
          await cm.start(pod.containerId);
        } else {
          // Guard: if the container exited before we got here (e.g. agent gave up after a
          // push rejection), fail fast with a human-readable message instead of getting a
          // cryptic Docker 409 "container stopped/paused" error from the exec call below.
          const cm = containerManagerFactory.get(pod.executionTarget);
          const containerStatus = await cm.getStatus(pod.containerId);
          if (containerStatus !== 'running') {
            throw new Error(
              `Container exited before validation could run — check agent logs for errors (container status: ${containerStatus})`,
            );
          }
        }

        // Sync workspace back before reading diff/commit log from host worktree
        emitActivityStatus(podId, 'Syncing workspace…');
        let validationSyncOk = true;
        if (pod.containerId && pod.worktreePath) {
          try {
            const cm = containerManagerFactory.get(pod.executionTarget);
            await syncWorkspaceBack(pod.containerId, pod.worktreePath, cm);
          } catch (err) {
            validationSyncOk = false;
            logger.warn({ err, podId }, 'Failed to sync workspace before validation');
          }
        }

        // Get the actual diff and commit log for AI task review.
        // Always scope to the agent's own commits via startCommitSha. The reviewer
        // should only evaluate what this agent changed — pre-existing code on a
        // parent branch is not the agent's responsibility. Stats/file counts still
        // use the full branch diff (computed earlier) for accurate PR sizing.
        emitActivityStatus(podId, 'Computing diff…');
        const diffSinceCommit = pod.startCommitSha ?? undefined;
        const validationDefaultBranch = profile.defaultBranch ?? 'main';
        const [diff, commitLog] = pod.worktreePath
          ? await Promise.all([
              worktreeManager.getDiff(
                pod.worktreePath,
                validationDefaultBranch,
                undefined,
                diffSinceCommit,
              ),
              worktreeManager.getCommitLog(
                pod.worktreePath,
                validationDefaultBranch,
                undefined,
                diffSinceCommit,
              ),
            ])
          : ['', ''];

        // Try to load a repo-specific code-review skill from the worktree
        const codeReviewSkill = pod.worktreePath
          ? await loadCodeReviewSkill(pod.worktreePath, logger)
          : undefined;

        // Flush any pending overrides enqueued via API and merge into pod overrides
        const pendingOverrides = deps.pendingOverrideRepo?.flush(podId) ?? [];
        let currentOverrides = pod.validationOverrides ?? [];
        if (pendingOverrides.length > 0) {
          currentOverrides = mergeOverrides(currentOverrides, pendingOverrides);
          podRepo.update(podId, { validationOverrides: currentOverrides });
        }

        const validationConfig = {
          podId,
          containerId: pod.containerId,
          previewUrl: pod.previewUrl ?? `http://127.0.0.1:${CONTAINER_APP_PORT}`,
          containerBaseUrl: `http://127.0.0.1:${CONTAINER_APP_PORT}`,
          buildCommand: profile.buildCommand ?? '',
          startCommand: profile.startCommand ?? '',
          buildWorkDir: profile.buildWorkDir ?? undefined,
          healthPath: profile.healthPath ?? '/',
          healthTimeout: profile.healthTimeout ?? 120,
          smokePages: profile.smokePages,
          attempt,
          task: pod.task,
          diff,
          testCommand: profile.testCommand,
          buildTimeout: (profile.buildTimeout ?? 300) * 1_000,
          testTimeout: (profile.testTimeout ?? 600) * 1_000,
          lintCommand: profile.lintCommand ?? undefined,
          lintTimeout: (profile.lintTimeout ?? 120) * 1_000,
          sastCommand: profile.sastCommand ?? undefined,
          sastTimeout: (profile.sastTimeout ?? 300) * 1_000,
          reviewerModel: profile.reviewerModel || profile.defaultModel || 'sonnet',
          acceptanceCriteria: pod.acceptanceCriteria ?? undefined,
          codeReviewSkill,
          commitLog: commitLog || undefined,
          plan: pod.plan ?? undefined,
          taskSummary: pod.taskSummary ?? undefined,
          briefTouches: pod.touches ?? undefined,
          briefDoesNotTouch: pod.doesNotTouch ?? undefined,
          worktreePath: pod.worktreePath ?? undefined,
          startCommitSha: pod.startCommitSha ?? undefined,
          overrides: currentOverrides.length > 0 ? currentOverrides : undefined,
          hasWebUi: profile.hasWebUi ?? true,
          reviewerApiKey: process.env.ANTHROPIC_API_KEY,
          extraExecEnv: buildValidationExecEnv(
            profile.privateRegistries,
            profile.registryPat ?? profile.adoPat ?? null,
            profile.buildEnv,
          ),
        };

        let result: Awaited<ReturnType<typeof validationEngine.validate>>;
        const validationController = new AbortController();
        validationAbortControllers.set(podId, validationController);
        try {
          result = await validationEngine.validate(
            validationConfig,
            (phase) => emitActivityStatus(podId, phase),
            validationController.signal,
            {
              onPhaseStarted: (phase) => {
                eventBus.emit({
                  type: 'pod.validation_phase_started',
                  timestamp: new Date().toISOString(),
                  podId,
                  phase,
                });
              },
              onPhaseCompleted: (phase, status, phaseResult) => {
                const base = {
                  type: 'pod.validation_phase_completed' as const,
                  timestamp: new Date().toISOString(),
                  podId,
                  phase,
                  phaseStatus: status,
                };
                if (phase === 'build') {
                  eventBus.emit({ ...base, buildResult: phaseResult as BuildResult });
                } else if (phase === 'test') {
                  eventBus.emit({
                    ...base,
                    testResult: phaseResult as {
                      status: 'pass' | 'fail' | 'skip';
                      duration: number;
                      stdout?: string;
                      stderr?: string;
                    },
                  });
                } else if (phase === 'lint') {
                  eventBus.emit({ ...base, lintResult: phaseResult as LintResult });
                } else if (phase === 'sast') {
                  eventBus.emit({ ...base, sastResult: phaseResult as SastResult });
                } else if (phase === 'health') {
                  eventBus.emit({ ...base, healthResult: phaseResult as HealthResult });
                } else if (phase === 'pages') {
                  eventBus.emit({ ...base, pageResults: phaseResult as PageResult[] });
                } else if (phase === 'ac') {
                  eventBus.emit({ ...base, acResult: phaseResult as AcValidationResult | null });
                } else if (phase === 'review') {
                  eventBus.emit({ ...base, reviewResult: phaseResult as TaskReviewResult | null });
                }
              },
            },
          );
        } catch (validateErr) {
          // Treat unexpected validation errors as a failed result so retry logic still applies
          logger.error(
            { err: validateErr, podId, attempt },
            'Validation engine threw unexpectedly',
          );
          const isContainerStopped =
            validateErr instanceof Error &&
            (validateErr.message.includes('container stopped/paused') ||
              (validateErr as NodeJS.ErrnoException & { statusCode?: number }).statusCode === 409);
          const buildOutput = isContainerStopped
            ? `Container exited before validation could run — check agent logs for errors`
            : String(validateErr);
          result = {
            podId,
            attempt,
            timestamp: new Date().toISOString(),
            overall: 'fail',
            smoke: {
              status: 'fail',
              build: { status: 'fail', output: buildOutput, duration: 0 },
              health: { status: 'fail', url: '', responseCode: null, duration: 0 },
              pages: [],
            },
            taskReview: null,
            duration: 0,
          };
        } finally {
          validationAbortControllers.delete(podId);
        }

        // Sync workspace after validation — screenshots and build artifacts are now in /workspace
        if (pod.containerId && pod.worktreePath) {
          try {
            const cm = containerManagerFactory.get(pod.executionTarget);
            await syncWorkspaceBack(pod.containerId, pod.worktreePath, cm);
          } catch (err) {
            validationSyncOk = false;
            logger.warn({ err, podId }, 'Failed to sync workspace after validation');
          }
        }

        // Collect screenshots from the host worktree
        if (pod.worktreePath && result.smoke.pages.length > 0) {
          try {
            const screenshots = await collectScreenshots(pod.worktreePath, result.smoke.pages);
            // Enrich page results with base64 data for Teams notifications
            for (const ss of screenshots) {
              const page = result.smoke.pages.find((p) => p.path === ss.pagePath);
              if (page) {
                page.screenshotBase64 = ss.base64;
              }
            }
            logger.info({ podId, count: screenshots.length }, 'Collected validation screenshots');
          } catch (err) {
            logger.warn({ err, podId }, 'Failed to collect screenshots');
          }
        }

        podRepo.update(podId, { lastValidationResult: result });

        // Persist every attempt to validation history
        validationRepo?.insert(podId, attempt, result);

        eventBus.emit({
          type: 'pod.validation_completed',
          timestamp: new Date().toISOString(),
          podId,
          result,
        });

        const s2 = podRepo.getOrThrow(podId);

        // Pod may have been killed while validation was running — bail out
        if (isTerminalState(s2.status) || s2.status === 'killing') {
          logger.info(
            { podId, status: s2.status },
            'Pod killed during validation, skipping post-validation',
          );
          return;
        }

        // Emit detailed validation result
        const buildStatus = result.smoke.build.status;
        const healthStatus = result.smoke.health.status;
        const acStatus = result.acValidation?.status ?? 'skip';
        const reviewStatus = result.taskReview?.status ?? 'skip';
        emitActivityStatus(
          podId,
          `Validation ${result.overall} — build: ${buildStatus}, health: ${healthStatus}, ac: ${acStatus}, review: ${reviewStatus}`,
        );

        // Surface review feedback so the user can see why it failed
        if (result.taskReview && result.taskReview.status !== 'pass') {
          if (result.taskReview.reasoning) {
            emitActivityStatus(podId, `Review: ${result.taskReview.reasoning}`);
          }
          for (const issue of result.taskReview.issues) {
            emitActivityStatus(podId, `  → ${issue}`);
          }
        }

        // ── Validation overrides: apply existing dismissals, detect recurring findings ──
        let effectiveResult = result;
        if (s2.validationOverrides && s2.validationOverrides.length > 0) {
          effectiveResult = applyOverrides(result, s2.validationOverrides);
          if (effectiveResult.overall !== result.overall) {
            logger.info(
              {
                podId,
                originalOverall: result.overall,
                patchedOverall: effectiveResult.overall,
              },
              'Validation overrides changed overall result',
            );
            emitActivityStatus(podId, 'Human overrides applied — re-evaluated result');
          }
        }

        // Detect recurring findings and auto-hoist / escalate to human
        if (effectiveResult.overall === 'fail' && attempt >= 2) {
          const previousValidations = validationRepo?.getForSession(podId);
          const previousResult = previousValidations
            ?.filter((v) => v.attempt < attempt)
            ?.sort((a, b) => b.attempt - a.attempt)?.[0]?.result;

          if (previousResult) {
            const currentFindings = extractFindings(effectiveResult);
            const previousFindings = extractFindings(previousResult);
            const recurring = detectRecurringFindings(currentFindings, previousFindings);

            if (recurring.length > 0) {
              logger.info(
                { podId, recurringCount: recurring.length, attempt },
                'Recurring validation findings detected',
              );
              emitActivityStatus(
                podId,
                `${recurring.length} recurring finding(s) detected — auto-hoisting to deeper review tier`,
              );

              // Auto-hoist: re-run task review at Tier 2+ (deep) to get a second opinion.
              // Only re-runs the AI review, not build/health/smoke (those are objective).
              let hoistedResult: typeof effectiveResult | null = null;
              try {
                hoistedResult = await validationEngine.validate(
                  { ...validationConfig, reviewDepth: 'deep' },
                  (phase) => emitActivityStatus(podId, phase),
                  validationController.signal,
                );
                if (s2.validationOverrides && s2.validationOverrides.length > 0) {
                  hoistedResult = applyOverrides(hoistedResult, s2.validationOverrides);
                }
              } catch (err) {
                logger.warn({ err, podId }, 'Auto-hoist deeper review failed');
              }

              if (hoistedResult && hoistedResult.overall === 'pass') {
                // Deeper review resolved the false positives — use the hoisted result
                effectiveResult = hoistedResult;
                emitActivityStatus(podId, 'Deeper review tier passed — overriding Tier 1 result');
                logger.info({ podId }, 'Auto-hoist resolved recurring findings');
                // Update stored result with the hoisted one
                podRepo.update(podId, { lastValidationResult: hoistedResult });
                validationRepo?.insert(podId, attempt, hoistedResult);
              } else {
                // Deeper review still flags same findings — escalate to human
                const hoistedFindings = hoistedResult
                  ? extractFindings(hoistedResult)
                  : currentFindings;
                const stillRecurring = detectRecurringFindings(hoistedFindings, previousFindings);

                if (stillRecurring.length > 0) {
                  emitActivityStatus(
                    podId,
                    `Deeper review still flagged ${stillRecurring.length} recurring finding(s) — escalating to human`,
                  );

                  const escalation: EscalationRequest = {
                    id: generateId(12),
                    podId,
                    type: 'validation_override',
                    timestamp: new Date().toISOString(),
                    payload: {
                      findings: stillRecurring,
                      attempt,
                      maxAttempts: s2.maxValidationAttempts,
                    },
                    response: null,
                  };

                  escalationRepo.insert(escalation);
                  podRepo.update(podId, {
                    pendingEscalation: escalation,
                    escalationCount: s2.escalationCount + 1,
                  });
                  transition(s2, 'awaiting_input');

                  logger.info(
                    { podId, escalationId: escalation.id, findingCount: stillRecurring.length },
                    'Validation override escalation created — waiting for human',
                  );
                  return; // Wait for human response via sendMessage()
                }
                // No recurring after hoist — fall through to normal retry/fail path
              }
            }
          }
        }

        // Skip-validation may have been toggled while this run was in flight — bypass result.
        if (s2.skipValidation) {
          emitActivityStatus(podId, 'Validation skipped by human toggle — marking as validated');
          logger.info({ podId, attempt }, 'skip_validation set mid-run — bypassing result');
          const validatedPod = transition(s2, 'validated');
          maybeTriggerDependents(validatedPod);
          return;
        }

        if (effectiveResult.overall === 'pass') {
          emitActivityStatus(podId, `Validation passed (attempt ${attempt})`);
          const passDefaultBranch = profile.defaultBranch ?? 'main';
          // Push branch and create PR before transitioning to validated.
          // Fix pods already have prUrl set — carry it forward and skip PR creation.
          let prUrl: string | null = s2.prUrl ?? null;
          const prManager = prManagerFactory ? prManagerFactory(profile) : null;
          if (prManager && s2.worktreePath && s2.options?.output !== 'branch') {
            // Commit screenshots to the branch so they're visible in the PR
            try {
              await worktreeManager.commitFiles(
                s2.worktreePath,
                ['.autopod/screenshots'],
                'chore: add validation screenshots',
              );
            } catch (err) {
              logger.warn({ err, podId }, 'Failed to commit screenshots');
            }

            // Push branch so `gh pr create --head` can reference it. If sync-back failed
            // earlier in this validation run, tighten the deletion guard so a ghost
            // mass-deletion cannot ship as "chore: auto-commit …".
            // Rethrow on non-guard errors: a swallowed push lets the carry-forward
            // path approve & merge a PR whose tip never advanced (real bug from
            // misrouted fix pods writing to the wrong branch).
            emitActivityStatus(podId, 'Branch validated — pushing…');
            try {
              await worktreeManager.mergeBranch({
                worktreePath: s2.worktreePath,
                // Push the feature branch up so `gh pr create --head <branch>` can reference it.
                // The PR is opened against passDefaultBranch separately by prManager.createPr.
                targetBranch: s2.branch,
                // Pass the PAT explicitly — the in-memory cache may be cold after a daemon
                // restart or for recovery pods that mount an existing worktree without
                // re-warming via create(). Without this, ADO URLs of the form
                // https://<org>@dev.azure.com/... cause git to prompt for a password.
                pat: selectGitPat(profile),
                maxDeletions: validationSyncOk ? 100 : 0,
                podTask: pod.task,
              });
            } catch (err) {
              logger.warn({ err, podId }, 'Failed to push branch for PR');
              if (!handleDeletionGuardError(podId, err)) {
                throw err;
              }
            }

            // Re-compute diff stats now that auto-commit has run.
            try {
              const prSinceCommit = s2.startCommitSha ?? undefined;
              const prBaseBranch = s2.baseBranch ?? passDefaultBranch;
              const stats = await worktreeManager.getDiffStats(
                s2.worktreePath,
                prBaseBranch,
                prSinceCommit,
              );
              podRepo.update(podId, {
                filesChanged: stats.filesChanged,
                linesAdded: stats.linesAdded,
                linesRemoved: stats.linesRemoved,
              });
            } catch (err) {
              logger.warn({ err, podId }, 'Failed to recompute diff stats after merge');
            }

            // Build screenshot URLs for the PR body (only for pods with a repo URL)
            const repoUrlForScreenshots = profile.repoUrl;
            const screenshotRefs = repoUrlForScreenshots
              ? result.smoke.pages
                  .filter((p) => p.screenshotPath)
                  .map((p) => ({
                    pagePath: p.path,
                    imageUrl: buildGitHubImageUrl(
                      repoUrlForScreenshots,
                      s2.branch,
                      p.screenshotPath.replace(/^\/workspace\//, ''),
                    ),
                  }))
              : [];

            if (!prUrl) {
              try {
                emitActivityStatus(podId, 'Creating PR…');
                const s3 = podRepo.getOrThrow(podId);
                warnIfSinglePrSeriesMissingSeriesMeta(s2, logger);
                prUrl = await prManager.createPr({
                  // biome-ignore lint/style/noNonNullAssertion: worktreePath is non-null here — PR creation only occurs for non-artifact pods which always have a worktree
                  worktreePath: s2.worktreePath!,
                  repoUrl: profile.repoUrl ?? undefined,
                  branch: s2.branch,
                  baseBranch: passDefaultBranch,
                  podId,
                  task: s2.task,
                  profileName: s2.profileName,
                  validationResult: result,
                  filesChanged: s3.filesChanged,
                  linesAdded: s3.linesAdded,
                  linesRemoved: s3.linesRemoved,
                  previewUrl: s2.previewUrl,
                  screenshots: screenshotRefs,
                  taskSummary: s3.taskSummary ?? undefined,
                  seriesDescription: s2.seriesDescription ?? undefined,
                  seriesName: s2.seriesName ?? undefined,
                  securityFindings: getLatestPushFindings(podId),
                });
                if (prUrl) {
                  emitActivityStatus(podId, `PR created: ${prUrl}`);
                }
              } catch (err) {
                logger.warn({ err, podId }, 'Failed to create PR — pod still validated');
                emitActivityStatus(podId, 'PR creation failed — pod still validated');
              }
            } else {
              emitActivityStatus(podId, `Carrying forward existing PR: ${prUrl}`);
            }
          }

          podRepo.update(podId, { lastCorrectionMessage: null });
          const validatedPod = transition(s2, 'validated', { prUrl });
          maybeTriggerDependents(validatedPod);

          // Stop the container (not remove) so it can be restarted for preview
          if (s2.containerId) {
            try {
              const cm = containerManagerFactory.get(s2.executionTarget);
              await cm.stop(s2.containerId);
              logger.info({ podId }, 'Container stopped post-validation');
            } catch (err) {
              logger.warn({ err, podId }, 'Failed to stop container post-validation');
            }
          }

          if (validatedPod.autoApprove) {
            logger.info({ podId }, 'Auto-approving pod after validation');
            setImmediate(() => {
              this.approveSession(podId).catch((err) =>
                logger.warn({ err, podId }, 'Auto-approve failed'),
              );
            });
          }
        } else if (force || attempt < s2.maxValidationAttempts) {
          emitActivityStatus(
            podId,
            `Validation failed (attempt ${attempt}/${s2.maxValidationAttempts}) — retrying`,
          );
          // Build correction message with structured feedback for the agent
          emitActivityStatus(podId, 'Sending validation feedback to agent…');
          const cm = containerManagerFactory.get(s2.executionTarget);
          let correctionMessage = await buildCorrectionMessage(s2, profile, effectiveResult, cm);

          // Flush overrides that arrived during the await above (race window: pod was still
          // `validating` so the override route couldn't queue a nudge for a running agent)
          const raceOverrides = deps.pendingOverrideRepo?.flush(podId) ?? [];
          if (raceOverrides.length > 0) {
            const merged = mergeOverrides(s2.validationOverrides ?? [], raceOverrides);
            podRepo.update(podId, { validationOverrides: merged });
            const overrideLines = raceOverrides.map((o) => {
              const detail =
                o.action === 'guidance' && o.guidance
                  ? `Guidance: ${o.guidance}`
                  : `Dismissed${o.reason ? `: ${o.reason}` : ''}`;
              return `- "${o.description}" — ${detail}`;
            });
            correctionMessage += `\n\n### Overridden Findings (a human reviewed these — do NOT address them)\n${overrideLines.join('\n')}`;
          }

          podRepo.update(podId, { lastCorrectionMessage: correctionMessage });

          // Transition back to running for retry
          transition(s2, 'running');

          // Resume the agent with correction feedback
          emitActivityStatus(podId, 'Agent working on fixes…');
          const resumeEnv = await getResumeEnv(s2);
          const runtime = runtimeRegistry.get(s2.runtime);
          if (!s2.containerId) throw new Error(`Pod ${podId} has no container`);
          const events = runtime.resume(podId, correctionMessage, s2.containerId, resumeEnv);
          await this.consumeAgentEvents(podId, events);
          emitActivityStatus(podId, 'Agent finished applying fixes');
          await this.handleCompletion(podId);

          logger.info(
            {
              podId,
              attempt,
              maxAttempts: s2.maxValidationAttempts,
            },
            'Retrying after validation failure',
          );
        } else {
          emitActivityStatus(
            podId,
            `Validation failed — max attempts (${s2.maxValidationAttempts}) exhausted, needs review`,
          );
          transition(s2, 'review_required');

          // Stop the container (not remove) so it can be restarted for preview
          if (s2.containerId) {
            try {
              const cm = containerManagerFactory.get(s2.executionTarget);
              await cm.stop(s2.containerId);
              logger.info({ podId }, 'Container stopped after max validation attempts');
            } catch (stopErr) {
              logger.warn({ err: stopErr, podId }, 'Failed to stop container post-validation');
            }
          }
        }
      } catch (err) {
        logger.error({ err, podId }, 'Validation error');
        const s2 = podRepo.getOrThrow(podId);
        transition(s2, 'failed');

        // Stop the container (not remove) so it can be restarted for preview
        if (s2.containerId) {
          try {
            const cm = containerManagerFactory.get(s2.executionTarget);
            await cm.stop(s2.containerId);
          } catch (stopErr) {
            logger.warn({ err: stopErr, podId }, 'Failed to stop container post-validation');
          }
        }
      }
    },

    async revalidateSession(
      podId: string,
    ): Promise<{ newCommits: boolean; result: 'pass' | 'fail' }> {
      const pod = podRepo.getOrThrow(podId);
      if (pod.status !== 'failed' && pod.status !== 'review_required') {
        throw new AutopodError(
          `Cannot revalidate pod ${podId} in status ${pod.status} — only failed or review_required pods can be revalidated`,
          'INVALID_STATE',
          409,
        );
      }
      if (!pod.worktreePath) {
        throw new AutopodError(
          `Pod ${podId} has no worktree — cannot pull latest`,
          'INVALID_STATE',
          400,
        );
      }

      // Pull latest from remote branch (human may have pushed fixes)
      emitActivityStatus(podId, 'Pulling latest changes from remote branch…');
      const { newCommits } = await worktreeManager.pullBranch(pod.worktreePath);

      if (!newCommits) {
        logger.info({ podId }, 'No new commits on branch — skipping revalidation');
        emitActivityStatus(podId, 'No new commits found — nothing to revalidate');
        return { newCommits: false, result: 'fail' };
      }

      logger.info({ podId }, 'New commits found — running revalidation');
      emitActivityStatus(podId, 'New commits detected — starting revalidation…');

      // Reset validation attempts for the fresh human-driven validation
      podRepo.update(podId, { validationAttempts: 0 });

      // Pre-push security scan: human-pushed fixes also need to clear the gate.
      const profile = profileStore.get(pod.profileName);
      await runPushCheckpointScan(pod, profile);

      // Transition to validating
      transition(pod, 'validating');

      // Re-run validation (force=true restarts container, but we don't want agent retry on failure)
      const attempt = 1;
      podRepo.update(podId, { validationAttempts: attempt });

      emitActivityStatus(podId, 'Starting revalidation (human fix)…');

      try {
        if (!pod.containerId) {
          throw new Error(`Pod ${podId} has no container — cannot validate`);
        }

        // Restart the container with updated worktree
        const cm = containerManagerFactory.get(pod.executionTarget);
        try {
          await cm.start(pod.containerId);
        } catch (err) {
          if (isExpectedDockerError(err, [404])) {
            podRepo.update(podId, { containerId: null });
            throw new AutopodError(
              `Container for pod ${podId} no longer exists — use "Retry" to re-provision with a fresh agent run`,
              'CONTAINER_NOT_FOUND',
              409,
            );
          }
          throw err;
        }

        const revalDefaultBranch = profile.defaultBranch ?? 'main';
        const [diff, commitLog] = pod.worktreePath
          ? await Promise.all([
              worktreeManager.getDiff(
                pod.worktreePath,
                revalDefaultBranch,
                undefined,
                pod.startCommitSha ?? undefined,
              ),
              worktreeManager.getCommitLog(
                pod.worktreePath,
                revalDefaultBranch,
                undefined,
                pod.startCommitSha ?? undefined,
              ),
            ])
          : ['', ''];

        const codeReviewSkill = pod.worktreePath
          ? await loadCodeReviewSkill(pod.worktreePath, logger)
          : undefined;

        let result: Awaited<ReturnType<typeof validationEngine.validate>>;
        const revalidateController = new AbortController();
        validationAbortControllers.set(podId, revalidateController);
        try {
          result = await validationEngine.validate(
            {
              podId,
              containerId: pod.containerId,
              previewUrl: pod.previewUrl ?? `http://127.0.0.1:${CONTAINER_APP_PORT}`,
              containerBaseUrl: `http://127.0.0.1:${CONTAINER_APP_PORT}`,
              buildCommand: profile.buildCommand ?? '',
              startCommand: profile.startCommand ?? '',
              buildWorkDir: profile.buildWorkDir ?? undefined,
              healthPath: profile.healthPath ?? '/',
              healthTimeout: profile.healthTimeout ?? 120,
              smokePages: profile.smokePages,
              attempt,
              task: pod.task,
              diff,
              testCommand: profile.testCommand,
              buildTimeout: (profile.buildTimeout ?? 300) * 1_000,
              testTimeout: (profile.testTimeout ?? 600) * 1_000,
              lintCommand: profile.lintCommand ?? undefined,
              lintTimeout: (profile.lintTimeout ?? 120) * 1_000,
              sastCommand: profile.sastCommand ?? undefined,
              sastTimeout: (profile.sastTimeout ?? 300) * 1_000,
              reviewerModel: profile.reviewerModel || profile.defaultModel || 'sonnet',
              acceptanceCriteria: pod.acceptanceCriteria ?? undefined,
              codeReviewSkill,
              commitLog: commitLog || undefined,
              plan: pod.plan ?? undefined,
              taskSummary: pod.taskSummary ?? undefined,
              worktreePath: pod.worktreePath ?? undefined,
              startCommitSha: pod.startCommitSha ?? undefined,
              hasWebUi: profile.hasWebUi ?? true,
            },
            (phase) => emitActivityStatus(podId, phase),
            revalidateController.signal,
          );
        } catch (validateErr) {
          logger.error({ err: validateErr, podId }, 'Revalidation engine threw unexpectedly');
          const isContainerStopped =
            validateErr instanceof Error &&
            (validateErr.message.includes('container stopped/paused') ||
              (validateErr as NodeJS.ErrnoException & { statusCode?: number }).statusCode === 409);
          const buildOutput = isContainerStopped
            ? `Container exited before validation could run — check agent logs for errors`
            : String(validateErr);
          result = {
            podId,
            attempt,
            timestamp: new Date().toISOString(),
            overall: 'fail',
            smoke: {
              status: 'fail',
              build: { status: 'fail', output: buildOutput, duration: 0 },
              health: { status: 'fail', url: '', responseCode: null, duration: 0 },
              pages: [],
            },
            taskReview: null,
            duration: 0,
          };
        } finally {
          validationAbortControllers.delete(podId);
        }

        podRepo.update(podId, { lastValidationResult: result });
        validationRepo?.insert(podId, attempt, result);

        eventBus.emit({
          type: 'pod.validation_completed',
          timestamp: new Date().toISOString(),
          podId,
          result,
        });

        const s2 = podRepo.getOrThrow(podId);

        if (isTerminalState(s2.status) || s2.status === 'killing') {
          return { newCommits: true, result: 'fail' };
        }

        if (result.overall === 'pass') {
          emitActivityStatus(podId, 'Revalidation passed — human fix worked!');

          // Push branch and create PR (same as triggerValidation pass path).
          // Fix pods already have prUrl set — carry it forward and skip PR creation.
          let prUrl: string | null = s2.prUrl ?? null;
          const prManager = prManagerFactory ? prManagerFactory(profile) : null;
          if (prManager && s2.worktreePath && s2.options?.output !== 'branch') {
            try {
              await worktreeManager.commitFiles(
                s2.worktreePath,
                ['.autopod/screenshots'],
                'chore: add validation screenshots',
              );
            } catch (err) {
              logger.warn({ err, podId }, 'Failed to commit screenshots');
            }

            try {
              // revalidateSession runs on a worktree just pushed by a human — nothing should
              // be uncommitted. If git add -A finds phantom deletions, it's a sync artifact,
              // not real work; block it.
              await worktreeManager.mergeBranch({
                worktreePath: s2.worktreePath,
                // Push the feature branch up — the PR is opened against revalDefaultBranch
                // separately by the PR manager.
                targetBranch: s2.branch,
                // Pass the PAT explicitly — revalidation often runs after a daemon restart,
                // when the in-memory PAT cache for this bare repo is cold.
                pat: selectGitPat(profile),
                maxDeletions: 0,
                podTask: pod.task,
              });
            } catch (err) {
              logger.warn({ err, podId }, 'Failed to push branch for PR');
              if (!handleDeletionGuardError(podId, err)) {
                throw err;
              }
            }

            try {
              const failSinceCommit = s2.startCommitSha ?? undefined;
              const failBaseBranch = s2.baseBranch ?? revalDefaultBranch;
              const stats = await worktreeManager.getDiffStats(
                s2.worktreePath,
                failBaseBranch,
                failSinceCommit,
              );
              podRepo.update(podId, {
                filesChanged: stats.filesChanged,
                linesAdded: stats.linesAdded,
                linesRemoved: stats.linesRemoved,
              });
            } catch (err) {
              logger.warn({ err, podId }, 'Failed to recompute diff stats');
            }

            if (!prUrl) {
              try {
                emitActivityStatus(podId, 'Creating PR…');
                const s3 = podRepo.getOrThrow(podId);
                warnIfSinglePrSeriesMissingSeriesMeta(s2, logger);
                prUrl = await prManager.createPr({
                  // biome-ignore lint/style/noNonNullAssertion: worktreePath is non-null here — PR creation only occurs for non-artifact pods which always have a worktree
                  worktreePath: s2.worktreePath!,
                  repoUrl: profile.repoUrl ?? undefined,
                  branch: s2.branch,
                  baseBranch: revalDefaultBranch,
                  podId,
                  task: s2.task,
                  profileName: s2.profileName,
                  validationResult: result,
                  filesChanged: s3.filesChanged,
                  linesAdded: s3.linesAdded,
                  linesRemoved: s3.linesRemoved,
                  previewUrl: s2.previewUrl,
                  screenshots: [],
                  taskSummary: s3.taskSummary ?? undefined,
                  seriesDescription: s2.seriesDescription ?? undefined,
                  seriesName: s2.seriesName ?? undefined,
                  securityFindings: getLatestPushFindings(podId),
                });
                if (prUrl) emitActivityStatus(podId, `PR created: ${prUrl}`);
              } catch (err) {
                logger.warn({ err, podId }, 'Failed to create PR — pod still validated');
                emitActivityStatus(podId, 'PR creation failed — pod still validated');
              }
            } else {
              emitActivityStatus(podId, `Carrying forward existing PR: ${prUrl}`);
            }
          }

          const revalidatedPod = transition(s2, 'validated', { prUrl });
          maybeTriggerDependents(revalidatedPod);

          // Stop the container
          if (s2.containerId) {
            try {
              const cm2 = containerManagerFactory.get(s2.executionTarget);
              await cm2.stop(s2.containerId);
            } catch (err) {
              logger.warn({ err, podId }, 'Failed to stop container post-revalidation');
            }
          }

          if (revalidatedPod.autoApprove) {
            logger.info({ podId }, 'Auto-approving pod after revalidation');
            setImmediate(() => {
              this.approveSession(podId).catch((err) =>
                logger.warn({ err, podId }, 'Auto-approve failed after revalidation'),
              );
            });
          }

          return { newCommits: true, result: 'pass' };
        }

        // Validation failed — stay in failed state, no agent rework
        const buildStatus2 = result.smoke.build.status;
        const healthStatus2 = result.smoke.health.status;
        const acStatus2 = result.acValidation?.status ?? 'skip';
        const reviewStatus2 = result.taskReview?.status ?? 'skip';
        emitActivityStatus(
          podId,
          `Revalidation fail — build: ${buildStatus2}, health: ${healthStatus2}, ac: ${acStatus2}, review: ${reviewStatus2}`,
        );
        if (result.taskReview && result.taskReview.status !== 'pass') {
          if (result.taskReview.reasoning) {
            emitActivityStatus(podId, `Review: ${result.taskReview.reasoning}`);
          }
          for (const issue of result.taskReview.issues) {
            emitActivityStatus(podId, `  → ${issue}`);
          }
        }
        emitActivityStatus(podId, 'Revalidation failed — human fix did not resolve all issues');
        transition(s2, 'failed');

        if (s2.containerId) {
          try {
            const cm2 = containerManagerFactory.get(s2.executionTarget);
            await cm2.stop(s2.containerId);
          } catch (err) {
            logger.warn({ err, podId }, 'Failed to stop container post-revalidation');
          }
        }

        return { newCommits: true, result: 'fail' };
      } catch (err) {
        logger.error({ err, podId }, 'Revalidation error');
        const s2 = podRepo.getOrThrow(podId);
        transition(s2, 'failed');
        return { newCommits: true, result: 'fail' };
      }
    },

    fixManually(podId: string, userId: string): Pod {
      const worker = podRepo.getOrThrow(podId);
      if (
        worker.status !== 'failed' &&
        worker.status !== 'review_required' &&
        worker.status !== 'validated'
      ) {
        throw new AutopodError(
          `Cannot fix pod ${podId} in status ${worker.status} — only failed, review_required, or validated pods`,
          'INVALID_STATE',
          409,
        );
      }

      // Create a workspace pod on the same branch, linked to the failed worker
      const workspace = this.createSession(
        {
          profileName: worker.profileName,
          task: `Human fix for failed pod ${worker.id}: ${worker.task}`,
          branch: worker.branch,
          outputMode: 'workspace',
          baseBranch: worker.baseBranch ?? undefined,
          linkedPodId: worker.id,
        },
        userId,
      );

      logger.info(
        { workerId: podId, workspaceId: workspace.id },
        'Created linked workspace for human fix',
      );
      emitActivityStatus(podId, `Human fix workspace created: ${workspace.id}`);

      return workspace;
    },

    notifyEscalation(podId: string, escalation: EscalationRequest): void {
      const pod = podRepo.getOrThrow(podId);
      if (pod.status === 'running') {
        transition(pod, 'awaiting_input', {
          pendingEscalation: escalation,
          escalationCount: pod.escalationCount + 1,
        });
      }
    },

    touchHeartbeat,

    async deleteSession(podId: string): Promise<void> {
      clearPreviewTimer(podId);
      const pod = podRepo.getOrThrow(podId);
      const deletable =
        isTerminalState(pod.status) ||
        pod.status === 'failed' ||
        pod.status === 'review_required' ||
        pod.status === 'killing';
      if (!deletable) {
        throw new AutopodError(
          `Cannot delete pod ${podId} in status ${pod.status} — kill it first`,
          'INVALID_STATE',
          409,
        );
      }

      // Clean up container if still present
      await killSidecarsForPod(podId);
      await cleanupTestRunBranches(podId);
      if (pod.containerId) {
        try {
          const cm = containerManagerFactory.get(pod.executionTarget);
          await cm.kill(pod.containerId);
        } catch (err) {
          logger.warn({ err, podId }, 'Failed to kill container during delete');
        }
      }
      await destroyPodNetwork(podId);

      // Clean up worktree if still present
      if (pod.worktreePath) {
        try {
          await worktreeManager.cleanup(pod.worktreePath);
        } catch (err) {
          logger.warn({ err, podId }, 'Failed to cleanup worktree during delete');
        }
      }

      podRepo.delete(podId);
      logger.info({ podId }, 'Pod deleted');
    },

    async startPreview(podId: string): Promise<{ previewUrl: string }> {
      const pod = podRepo.getOrThrow(podId);

      if (!pod.containerId) {
        throw new AutopodError(
          `Pod ${podId} has no container — cannot start preview`,
          'INVALID_STATE',
          409,
        );
      }

      if (!pod.previewUrl) {
        throw new AutopodError(`Pod ${podId} has no preview URL`, 'INVALID_STATE', 409);
      }

      const cm = containerManagerFactory.get(pod.executionTarget);
      const status = await cm.getStatus(pod.containerId);

      if (status === 'running') {
        // Already running — idempotent, just reset the auto-stop timer
        schedulePreviewAutoStop(podId, pod.containerId, pod.executionTarget);
        return { previewUrl: pod.previewUrl };
      }

      if (status === 'unknown') {
        throw new AutopodError(
          `Container for pod ${podId} has been removed — cannot start preview`,
          'INVALID_STATE',
          409,
        );
      }

      // Container is stopped — start it
      await cm.start(pod.containerId);

      // Re-run the start command and wait for health check
      const profile = profileStore.get(pod.profileName);
      if (profile.startCommand) {
        cm.execInContainer(pod.containerId, ['sh', '-c', `${profile.startCommand} &`], {
          cwd: '/workspace',
        }).catch((err) => {
          logger.warn(
            { err, podId },
            'Preview start command errored (may be expected for long-running processes)',
          );
        });

        // Poll for health
        const healthUrl = pod.previewUrl + profile.healthPath;
        const timeoutMs = (profile.healthTimeout ?? 30) * 1_000;
        const pollIntervalMs = 2_000;
        const start = Date.now();

        while (Date.now() - start < timeoutMs) {
          try {
            const response = await fetch(healthUrl, {
              signal: AbortSignal.timeout(5_000),
            });
            if (response.status === 200) {
              logger.info({ podId, healthUrl }, 'Preview health check passed');
              break;
            }
          } catch {
            // Health check not ready yet
          }
          const remaining = timeoutMs - (Date.now() - start);
          if (remaining > 0) {
            await new Promise<void>((r) => setTimeout(r, Math.min(pollIntervalMs, remaining)));
          }
        }
      }

      schedulePreviewAutoStop(podId, pod.containerId, pod.executionTarget);
      logger.info({ podId, previewUrl: pod.previewUrl }, 'Preview started');
      return { previewUrl: pod.previewUrl };
    },

    async stopPreview(podId: string): Promise<void> {
      clearPreviewTimer(podId);
      const pod = podRepo.getOrThrow(podId);

      if (!pod.containerId) {
        throw new AutopodError(
          `Pod ${podId} has no container — cannot stop preview`,
          'INVALID_STATE',
          409,
        );
      }

      const cm = containerManagerFactory.get(pod.executionTarget);
      await cm.stop(pod.containerId);
      logger.info({ podId }, 'Preview stopped');
    },

    getSession(podId: string): Pod {
      return podRepo.getOrThrow(podId);
    },

    getInjectedMcpServers(podId: string): InjectedMcpServer[] {
      const pod = podRepo.getOrThrow(podId);
      const profile = profileStore.get(pod.profileName);
      return mergeMcpServers(daemonConfig.mcpServers, profile.mcpServers);
    },

    listSessions(filters?) {
      return podRepo.list(filters);
    },

    getSessionStats(filters?) {
      return podRepo.getStats(filters);
    },

    getSeriesPods(seriesId: string): Pod[] {
      return podRepo.getPodsBySeries(seriesId);
    },

    rehydrateDependentSessions(): void {
      const PARENT_DONE = new Set([
        'validated',
        'approved',
        'merging',
        'merge_pending',
        'complete',
      ]);
      const stuckDeps = podRepo
        .list({ status: 'queued' })
        .filter((p) => p.dependsOnPodIds.length > 0 || !!p.dependsOnPodId);

      for (const dep of stuckDeps) {
        const parentIds =
          dep.dependsOnPodIds.length > 0
            ? dep.dependsOnPodIds
            : dep.dependsOnPodId
              ? [dep.dependsOnPodId]
              : [];
        if (parentIds.length === 0) continue;

        const allParentsDone = parentIds.every((pid) => {
          try {
            const parent = podRepo.getOrThrow(pid);
            // Shared branch: parent must reach 'complete' before its worktree
            // releases the branch lock. See maybeTriggerDependents for rationale.
            if (parent.branch === dep.branch) {
              return parent.status === 'complete';
            }
            return PARENT_DONE.has(parent.status);
          } catch {
            return false;
          }
        });
        if (!allParentsDone) continue;

        // Enqueue each stuck pod directly (once per pod) rather than calling
        // maybeTriggerDependents which iterates *all* dependents of the parent
        // and would fire multiple times if called once per stuck dep in the loop.
        const firstParentId = parentIds[0];
        if (!firstParentId) continue;
        try {
          const firstParent = podRepo.getOrThrow(firstParentId);
          podRepo.update(dep.id, {
            baseBranch: firstParent.branch,
            dependencyStartedAt: new Date().toISOString(),
          });
          enqueueSession(dep.id);
          logger.info({ podId: dep.id, firstParentId }, 'Series: rehydrated stuck dependent pod');
        } catch {
          logger.warn({ podId: dep.id }, 'rehydrate: failed to enqueue dependent');
        }
      }
    },

    async deleteSeriesWithCascade(seriesId: string): Promise<void> {
      const seriesPods = podRepo.getPodsBySeries(seriesId);
      if (seriesPods.length === 0) {
        throw new AutopodError(`Series ${seriesId} not found`, 'NOT_FOUND', 404);
      }
      for (const pod of seriesPods) {
        if (canKill(pod.status)) {
          await this.killSession(pod.id).catch((err) =>
            logger.warn({ err, podId: pod.id, seriesId }, 'Series delete: kill failed, continuing'),
          );
        }
        await this.deleteSession(pod.id).catch((err) =>
          logger.warn({ err, podId: pod.id, seriesId }, 'Series delete: delete failed, continuing'),
        );
      }
      logger.info({ seriesId, count: seriesPods.length }, 'Series deleted');
    },

    getValidationHistory(podId: string) {
      // Verify pod exists
      podRepo.getOrThrow(podId);
      return validationRepo?.getForSession(podId) ?? [];
    },

    async approveAllValidated(): Promise<{ approved: string[] }> {
      const validated = podRepo.list({ status: 'validated' });
      const approved: string[] = [];
      for (const pod of validated) {
        try {
          await this.approveSession(pod.id);
          approved.push(pod.id);
        } catch (err) {
          logger.warn({ err, podId: pod.id }, 'Failed to approve pod in bulk');
        }
      }
      return { approved };
    },

    async killAllFailed(): Promise<{ killed: string[] }> {
      const failed = podRepo.list({ status: 'failed' });
      const killed: string[] = [];
      for (const pod of failed) {
        try {
          await this.killSession(pod.id);
          killed.push(pod.id);
        } catch (err) {
          logger.warn({ err, podId: pod.id }, 'Failed to kill pod in bulk');
        }
      }
      return { killed };
    },

    async extendAttempts(podId: string, additionalAttempts: number): Promise<void> {
      const pod = podRepo.getOrThrow(podId);
      if (pod.status !== 'review_required') {
        throw new AutopodError(
          `Cannot extend attempts for pod ${podId} in status ${pod.status} — only review_required pods`,
          'INVALID_STATE',
          409,
        );
      }
      const newMax = pod.maxValidationAttempts + additionalAttempts;
      if (newMax > 10) {
        throw new AutopodError(
          `Cannot exceed 10 total validation attempts (current: ${pod.maxValidationAttempts}, requested: +${additionalAttempts})`,
          'VALIDATION_ERROR',
          400,
        );
      }
      podRepo.update(podId, { maxValidationAttempts: newMax });
      logger.info(
        { podId, oldMax: pod.maxValidationAttempts, newMax, additionalAttempts },
        'Extended validation attempts',
      );
      emitActivityStatus(podId, `Validation attempts extended to ${newMax} — resuming validation`);
      // Use force=true so triggerValidation re-provisions the container. The pod is in
      // review_required (terminal), so force+fromTerminal triggers a clean re-provision:
      // old container killed, worktree preserved, agent re-run with the "exhausted attempts"
      // rework prompt. This is safer than manually calling cm.start() and silently swallowing
      // errors — if the container was removed rather than stopped, exec calls would 404.
      await this.triggerValidation(podId, { force: true });
    },

    async applyOverridesInstant(podId: string): Promise<{ advanced: boolean }> {
      const pod = podRepo.getOrThrow(podId);
      if (pod.status !== 'review_required') {
        throw new AutopodError(
          `Cannot apply overrides instantly for pod ${podId} in status ${pod.status} — only review_required pods`,
          'INVALID_STATE',
          409,
        );
      }
      if (!pod.lastValidationResult) {
        return { advanced: false };
      }

      // Flush pending overrides and merge into permanent overrides
      const pendingOverrides = deps.pendingOverrideRepo?.flush(podId) ?? [];
      const existingOverrides = pod.validationOverrides ?? [];
      const currentOverrides =
        pendingOverrides.length > 0
          ? mergeOverrides(existingOverrides, pendingOverrides)
          : existingOverrides;

      if (currentOverrides.length === 0) {
        return { advanced: false };
      }

      podRepo.update(podId, { validationOverrides: currentOverrides });

      // Re-evaluate the cached result with overrides applied
      const patched = applyOverrides(pod.lastValidationResult, currentOverrides);
      podRepo.update(podId, { lastValidationResult: patched });

      emitActivityStatus(podId, 'Human overrides applied — re-evaluating cached result…');

      if (patched.overall === 'pass') {
        transition(pod, 'validated');
        emitActivityStatus(podId, 'All findings resolved — validation passed');
        logger.info(
          { podId, overrideCount: currentOverrides.length },
          'Instant override advanced pod to validated',
        );
        return { advanced: true };
      }

      emitActivityStatus(podId, 'Some findings remain — pod still needs review');
      return { advanced: false };
    },

    async forceApprove(podId: string, reason?: string): Promise<void> {
      const pod = podRepo.getOrThrow(podId);
      if (pod.status !== 'failed' && pod.status !== 'review_required') {
        throw new AutopodError(
          `Cannot force-approve pod ${podId} in status ${pod.status} — only failed or review_required pods`,
          'INVALID_STATE',
          409,
        );
      }
      const note = reason
        ? `[FORCE APPROVED] ${reason}`
        : '[FORCE APPROVED] Human overrode validation — no further agent run needed';
      podRepo.update(podId, { lastCorrectionMessage: note });
      transition(pod, 'validated');
      emitActivityStatus(podId, 'Force approved — validation bypassed by human');
      logger.info({ podId, reason }, 'Pod force-approved, transitioning to validated');
    },

    async extendPrAttempts(podId: string, additionalAttempts: number): Promise<void> {
      const pod = podRepo.getOrThrow(podId);
      if (pod.status !== 'failed') {
        throw new AutopodError(
          `Cannot extend PR attempts for pod ${podId} in status ${pod.status} — only failed pods`,
          'INVALID_STATE',
          409,
        );
      }
      if (!pod.mergeBlockReason?.startsWith('Max PR fix attempts')) {
        throw new AutopodError(
          `Pod ${podId} did not fail due to exhausted PR fix attempts`,
          'INVALID_STATE',
          409,
        );
      }
      const currentMax = pod.maxPrFixAttempts ?? DEFAULT_MAX_PR_FIX_ATTEMPTS;
      const newMax = currentMax + additionalAttempts;
      if (newMax > 20) {
        throw new AutopodError(
          `Cannot exceed 20 total PR fix attempts (current: ${currentMax}, requested: +${additionalAttempts})`,
          'VALIDATION_ERROR',
          400,
        );
      }
      // Clear stale fixPodId so the next poll can spawn freely
      podRepo.update(podId, { maxPrFixAttempts: newMax, fixPodId: null });
      // failed → merge_pending re-enters the polling loop
      transition(pod, 'merge_pending', {
        mergeBlockReason: 'Awaiting merge — PR fix attempts extended',
      });
      emitActivityStatus(podId, `PR fix attempts extended to ${newMax} — resuming merge polling`);
      startMergePolling(podId);
      logger.info(
        { podId, oldMax: currentMax, newMax, additionalAttempts },
        'Extended PR fix attempts',
      );
    },

    interruptValidation(podId: string): void {
      validationAbortControllers.get(podId)?.abort();
    },

    setSkipValidation(podId: string, skip: boolean): void {
      podRepo.getOrThrow(podId);
      podRepo.update(podId, { skipValidation: skip });
      const msg = skip
        ? 'Skip-validation toggled on — next validation result will be bypassed'
        : 'Skip-validation toggled off — validation will run normally';
      emitActivityStatus(podId, msg);
      logger.info({ podId, skip }, 'skip_validation updated by user');
    },

    async refreshNetworkPolicy(profileName: string): Promise<void> {
      if (!networkManager) return;

      const profile = profileStore.get(profileName);
      if (!profile.networkPolicy?.enabled) return;

      const runningSessions = podRepo
        .list({ status: 'running' })
        .filter(
          (s) =>
            s.profileName === profileName && s.executionTarget === 'local' && s.containerId != null,
        );

      if (runningSessions.length === 0) return;

      const mergedServers = mergeMcpServers(daemonConfig.mcpServers, profile.mcpServers);
      const cm = containerManagerFactory.get('local');

      // Resolve the current bridge IP of each sidecar for a given pod. With
      // per-pod networks each pod has its own `autopod-<podId>` bridge, and
      // sidecar IPs can be different across pods.
      const collectSidecarIps = async (pod: import('@autopod/shared').Pod): Promise<string[]> => {
        if (!sidecarManager || !pod.sidecarContainerIds) return [];
        const networkName = networkNameForPod(pod.id);
        const ips: string[] = [];
        for (const [name, containerId] of Object.entries(pod.sidecarContainerIds)) {
          const ip = await sidecarManager.getBridgeIp({ containerId, name }, networkName);
          if (ip) ips.push(ip);
        }
        return ips;
      };

      // With per-pod networks, each pod has its own bridge and may have
      // different sidecar IPs to allowlist. Build the firewall script per
      // pod rather than once for the whole profile.
      await Promise.all(
        runningSessions.map(async (pod) => {
          try {
            const gatewayIp = await networkManager.getGatewayIp(pod.id);
            const sidecarIps = await collectSidecarIps(pod);
            const sidecarDnsNames = Object.keys(pod.sidecarContainerIds ?? {});
            const netConfig = await networkManager.buildNetworkConfig(
              profile.networkPolicy,
              mergedServers,
              gatewayIp,
              profile.privateRegistries,
              pod.id,
              sidecarIps,
              sidecarDnsNames,
            );
            if (!netConfig) return;
            // biome-ignore lint/style/noNonNullAssertion: runningSessions always have a containerId
            await cm.refreshFirewall(pod.containerId!, netConfig.firewallScript);
            logger.info(
              { podId: pod.id, profileName },
              'Network policy refreshed on running container',
            );
          } catch (err) {
            logger.warn(
              { err, podId: pod.id, profileName },
              'Failed to refresh network policy on running container',
            );
          }
        }),
      );
    },

    async injectCredential(podId: string, service: 'github' | 'ado'): Promise<void> {
      const pod = podRepo.getOrThrow(podId);
      if (pod.status !== 'running') {
        throw new AutopodError(
          `Pod ${podId} is ${pod.status} — can only inject credentials into running pods.`,
          'INVALID_STATE',
          409,
        );
      }
      if (!pod.containerId) {
        throw new AutopodError(`Pod ${podId} has no running container`, 'INVALID_STATE', 409);
      }
      await performCredentialInjection(podId, service);
      emitActivityStatus(podId, `${service} credentials injected.`);
    },

    async installCliTool(podId: string, tool: 'gh' | 'az'): Promise<void> {
      const pod = podRepo.getOrThrow(podId);
      if (pod.status !== 'running') {
        throw new AutopodError(
          `Pod ${podId} is ${pod.status} — can only install tools into running pods.`,
          'INVALID_STATE',
          409,
        );
      }
      if (!pod.containerId) {
        throw new AutopodError(`Pod ${podId} has no running container`, 'INVALID_STATE', 409);
      }
      const cm = containerManagerFactory.get(pod.executionTarget);
      const containerId = pod.containerId;

      const check = await cm.execInContainer(containerId, ['sh', '-c', `command -v ${tool}`]);
      if (check.exitCode === 0) {
        emitActivityStatus(podId, `${tool} is already installed.`);
        return;
      }

      emitActivityStatus(podId, `Installing ${tool} CLI…`);
      if (tool === 'gh') {
        await installGhBinary(cm, containerId, podId);
      } else {
        await installAzViaPip(cm, containerId, podId);
      }
      emitActivityStatus(podId, `${tool} CLI installed.`);
    },

    async spawnFixSession(podId: string, userMessage?: string): Promise<void> {
      const pod = podRepo.getOrThrow(podId);
      if (pod.status !== 'merge_pending' && pod.status !== 'complete') {
        throw new AutopodError(
          `Cannot spawn fix pod for ${podId} in status ${pod.status} — only merge_pending or complete pods`,
          'INVALID_STATE',
          409,
        );
      }
      if (pod.linkedPodId) {
        throw new AutopodError(
          `Pod ${podId} is already a fix pod — only root pods can spawn fixers`,
          'INVALID_STATE',
          409,
        );
      }
      // In a single-PR series only the PR-owning pod has prUrl set, but the user
      // may legitimately click a sibling. resolveBranchSource will route the fix
      // pod to the PR owner; we just need a series anchor here.
      const isSingleSeriesMember = pod.prMode === 'single' && Boolean(pod.seriesId);
      if (!pod.prUrl && !isSingleSeriesMember) {
        throw new AutopodError(`Pod ${podId} has no PR URL`, 'INVALID_STATE', 409);
      }

      // Bump maxPrFixAttempts if the current cap would block the spawn
      const currentMax = pod.maxPrFixAttempts ?? DEFAULT_MAX_PR_FIX_ATTEMPTS;
      const currentAttempts = pod.prFixAttempts ?? 0;
      if (currentAttempts >= currentMax) {
        const newMax = Math.min(currentAttempts + 3, 20);
        podRepo.update(podId, { maxPrFixAttempts: newMax });
        logger.info(
          { podId, currentAttempts, newMax },
          'Manual spawn: bumped maxPrFixAttempts to allow fix',
        );
      }

      // Clear any stale fixPodId so maybeSpawnFixSession won't wait a cycle
      podRepo.update(podId, { fixPodId: null });

      // Fetch current PR status to build a meaningful fix task. For single-mode
      // siblings the PR lives on a different pod — resolve it so we fetch the
      // real PR's status instead of skipping.
      const profile = profileStore.get(pod.profileName);
      const prManager = prManagerFactory ? prManagerFactory(profile) : null;
      const prUrlForStatus = pod.prUrl ?? resolveBranchSource(pod).prUrl ?? null;
      let status: PrMergeStatus = {
        merged: false,
        open: true,
        blockReason: pod.mergeBlockReason ?? 'PR needs fixes',
        ciFailures: [],
        reviewComments: [],
      };
      if (prManager && prUrlForStatus) {
        try {
          status = await prManager.getPrStatus({
            prUrl: prUrlForStatus,
            worktreePath: pod.worktreePath ?? undefined,
          });
        } catch (err) {
          logger.warn(
            { err, podId },
            'Manual spawn: failed to fetch PR status, using cached block reason',
          );
        }
      }

      await maybeSpawnFixSession(podId, status, userMessage, true);
      logger.info(
        { podId, hasUserMessage: Boolean(userMessage) },
        'Manual fix pod spawn triggered',
      );
    },

    async retryCreatePr(podId: string): Promise<void> {
      const pod = podRepo.getOrThrow(podId);
      if (pod.status !== 'complete') {
        throw new AutopodError(
          `Cannot retry PR creation for ${podId} in status ${pod.status} — only complete pods`,
          'INVALID_STATE',
          409,
        );
      }
      if (pod.prUrl) {
        throw new AutopodError(`Pod ${podId} already has a PR: ${pod.prUrl}`, 'INVALID_STATE', 409);
      }
      if (!pod.worktreePath) {
        throw new AutopodError(
          `Pod ${podId} has no worktree — cannot create PR`,
          'INVALID_STATE',
          409,
        );
      }

      const profile = profileStore.get(pod.profileName);
      const prManager = prManagerFactory ? prManagerFactory(profile) : null;
      if (!prManager) {
        throw new AutopodError(
          `No PR manager configured for profile ${pod.profileName}`,
          'INVALID_STATE',
          409,
        );
      }

      emitActivityStatus(podId, 'Retrying PR creation…');
      const baseBranch = profile.defaultBranch ?? 'main';

      // Push the branch to the remote — intermediate series pods (output='branch') skip this
      // during normal completion, so the branch may only exist locally. Pass the PAT explicitly
      // because the in-memory cache may be cold after a daemon restart.
      const retryPat = selectGitPat(profile);
      try {
        await worktreeManager.mergeBranch({
          worktreePath: pod.worktreePath,
          // Push the feature branch up to origin so the PR can be opened against baseBranch.
          // mergeBranch verifies HEAD is on targetBranch and pushes to refs/heads/<targetBranch>;
          // passing baseBranch here would force-push the feature work onto main.
          targetBranch: pod.branch,
          pat: retryPat,
          // retryCreatePr runs post-container with no fresh sync-back: if the worktree is
          // missing files, it's almost certainly a ghost from an earlier sync failure.
          // Block auto-commit deletions entirely — the user wants to ship what's already
          // on the branch, not commit a catastrophic delete on top of it.
          maxDeletions: 0,
          // Provide pod task as context for any auto-generated commit message.
          podTask: pod.task,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({ podId, err }, 'retryCreatePr: branch push failed');
        if (handleDeletionGuardError(podId, err)) {
          // The guard already surfaced a specific activity-status message + event.
          // Use a distinct error code so the desktop can render a recovery banner
          // instead of a generic failure toast.
          throw new AutopodError(message, 'WORKTREE_COMPROMISED', 409);
        }
        emitActivityStatus(podId, `Branch push failed: ${message}`);
        throw new AutopodError(message, 'BRANCH_PUSH_FAILED', 502);
      }

      let newPrUrl: string;
      try {
        newPrUrl = await prManager.createPr({
          worktreePath: pod.worktreePath,
          repoUrl: profile.repoUrl ?? undefined,
          branch: pod.branch,
          baseBranch,
          podId,
          task: pod.task,
          profileName: pod.profileName,
          validationResult: null,
          filesChanged: pod.filesChanged,
          linesAdded: pod.linesAdded,
          linesRemoved: pod.linesRemoved,
          previewUrl: pod.previewUrl,
          screenshots: [],
          taskSummary: pod.taskSummary ?? undefined,
          seriesDescription: pod.seriesDescription ?? undefined,
          seriesName: pod.seriesName ?? undefined,
          securityFindings: getLatestPushFindings(podId),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({ podId, err }, 'retryCreatePr: PR creation failed');
        emitActivityStatus(podId, `PR creation failed: ${message}`);
        throw new AutopodError(message, 'PR_CREATION_FAILED', 502);
      }
      podRepo.update(podId, { prUrl: newPrUrl });
      emitActivityStatus(podId, `PR created: ${newPrUrl}`);
      logger.info({ podId, prUrl: newPrUrl }, 'PR created via retryCreatePr');
    },

    async recoverWorktree(podId: string): Promise<{ recovered: boolean; message: string }> {
      const pod = podRepo.getOrThrow(podId);
      if (!pod.worktreeCompromised) {
        throw new AutopodError(
          `Pod ${podId} worktree is not compromised — nothing to recover`,
          'INVALID_STATE',
          409,
        );
      }
      if (!pod.containerId || !pod.worktreePath) {
        return {
          recovered: false,
          message: 'Pod has no container or worktree — manual extraction needed',
        };
      }
      const cm = containerManagerFactory.get(pod.executionTarget);
      const recovered = await recoverWorktreeFromContainer(pod.containerId, pod.worktreePath, cm);
      if (!recovered) {
        return {
          recovered: false,
          message: 'Container not reachable — manual extraction needed',
        };
      }
      try {
        await worktreeManager.commitPendingChangesWithGeneratedMessage(pod.worktreePath, pod.task, {
          maxDeletions: 100,
        });
        podRepo.update(podId, { worktreeCompromised: false });
        emitActivityStatus(podId, 'Worktree recovered from container and committed successfully');
        return { recovered: true, message: 'Worktree recovered and committed' };
      } catch (err) {
        return {
          recovered: false,
          message: `Recovery failed at commit stage: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}

/**
 * Translate profile.codeIntelligence flags into StdioInjectedMcpServer entries.
 * These are written directly to /workspace/.mcp.json — they bypass the daemon proxy
 * because they are local subprocesses inside the container, not remote HTTP servers.
 */
function buildCodeIntelligenceServers(profile: Profile): StdioInjectedMcpServer[] {
  const servers: StdioInjectedMcpServer[] = [];
  if (profile.codeIntelligence?.serena) {
    // Upstream contract: `serena start-mcp-server --context=claude-code --project=<dir>`.
    // The bare `--project /workspace` form (the previous version) silently failed
    // because it skips the `start-mcp-server` subcommand entirely.
    servers.push({
      type: 'stdio',
      name: 'serena',
      command: 'serena',
      args: ['start-mcp-server', '--context=claude-code', '--project=/workspace'],
      description:
        'LSP-backed semantic code navigation. Provides go-to-definition, find-references, ' +
        'type hierarchy, and barrel-export resolution for TypeScript (tsserver) and C# (Roslyn).',
      toolHints: [
        'ALWAYS use instead of grep for symbol navigation — tsserver resolves path aliases and declaration merging that grep misses',
        'Finding a symbol definition or all callers: use find_symbol / find_referencing_symbols — NOT grep',
        'Resolving a barrel export or path-aliased import: use symbol_overview — NOT file reads',
        'Understanding a class hierarchy: use type_hierarchy — NOT manual directory traversal',
      ],
      toolNames: [
        'mcp__serena__find_symbol',
        'mcp__serena__find_referencing_symbols',
        'mcp__serena__find_implementations',
        'mcp__serena__symbol_overview',
        'mcp__serena__type_hierarchy',
        'mcp__serena__search_for_pattern',
      ],
    });
  }
  if (profile.codeIntelligence?.roslynCodeLens) {
    servers.push({
      type: 'stdio',
      name: 'roslyn-codelens',
      command: 'roslyn-codelens-mcp',
      description:
        'Roslyn-backed C# DI analysis. Use get_di_registrations to trace which concrete type ' +
        'the DI container injects for an interface, and find_implementations for interface resolution.',
      toolHints: [
        'ALWAYS call get_di_registrations before reading service registration files — do NOT trace registrations manually',
        'Resolving interface → concrete type: use find_implementations — NOT grep for class names',
        'Finding all callers of a method: use find_callers — NOT grep',
        'Navigating to a definition: use go_to_definition — NOT file reads',
      ],
      toolNames: [
        'mcp__roslyn-codelens__get_di_registrations',
        'mcp__roslyn-codelens__find_implementations',
        'mcp__roslyn-codelens__find_references',
        'mcp__roslyn-codelens__find_callers',
        'mcp__roslyn-codelens__go_to_definition',
        'mcp__roslyn-codelens__get_type_hierarchy',
      ],
    });
  }
  return servers;
}
