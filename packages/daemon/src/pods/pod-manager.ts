import { execFile } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
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
  NetworkPolicy,
  PageResult,
  PodOptions,
  PrivateRegistry,
  Profile,
  ReferenceRepo,
  RequestCredentialPayload,
  Pod,
  PodStatus,
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
  resolvePodOptions,
} from '@autopod/shared';
import type { Logger } from 'pino';
import type { ActionAuditRepository } from '../actions/audit-repository.js';
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
import type { ProfileStore } from '../profiles/index.js';
import { buildProviderEnv, persistRefreshedCredentials } from '../providers/index.js';
import type { ClaudeRuntime } from '../runtimes/claude-runtime.js';
import { detectRecurringFindings, extractFindings } from '../validation/finding-fingerprint.js';
import { applyOverrides } from '../validation/override-applicator.js';
import { buildGitHubImageUrl, collectScreenshots } from '../validation/screenshot-collector.js';
import { readAcFile } from './ac-file-parser.js';
import { buildCorrectionMessage } from './correction-context.js';
import type { EscalationRepository } from './escalation-repository.js';
import type { EventBus } from './event-bus.js';
import type { EventRepository } from './event-repository.js';
import { formatFeedback } from './feedback-formatter.js';
import { mergeClaudeMdSections, mergeMcpServers, mergeSkills } from './injection-merger.js';
import type { NudgeRepository } from './nudge-repository.js';
import type { ProgressEventRepository } from './progress-event-repository.js';
import {
  buildContinuationPrompt,
  buildRecoveryTask,
  buildReworkTask,
} from './recovery-context.js';
import {
  CREDENTIAL_GUARD_HOOK,
  buildNuGetCredentialEnv,
  buildRegistryFiles,
  ensureNuGetCredentialProvider,
  validateRegistryFiles,
} from './registry-injector.js';
import { resolveSections } from './section-resolver.js';
import type { PodRepository, PodStats, PodUpdates } from './pod-repository.js';
import { resolveSkills } from './skill-resolver.js';
import {
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

/**
 * Build the task string for a PR fix pod, injecting CI failure details and
 * review comments so the agent knows exactly what to fix.
 */
function buildPrFixTask(
  pod: Pod,
  status: PrMergeStatus,
  podRepo: PodRepository,
): string {
  const attempt = (pod.prFixAttempts ?? 0) + 1;

  // Resolve the root original task by following linkedPodId back to the source.
  // Prevents nested [PR FIX] boilerplate + duplicate review-comment blocks when a
  // fix pod somehow ends up spawning a sub-fixer.
  let rootTask = pod.task;
  let cursor: Pod = pod;
  while (cursor.linkedPodId) {
    try {
      const parent = podRepo.getOrThrow(cursor.linkedPodId);
      rootTask = parent.task;
      cursor = parent;
    } catch {
      break;
    }
  }

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
          sections.push(`  - ${ann.path}: ${ann.message} [${ann.annotationLevel}]`);
        }
      }
      sections.push('');
    }
  }

  if (status.reviewComments.length > 0) {
    sections.push('## Review Comments\n');
    for (const rc of status.reviewComments) {
      const prefix = rc.path ? `\`${rc.path}\`: ` : '';
      sections.push(`${prefix}${rc.body}`);
      sections.push('');
    }
  }

  sections.push('After pushing your fixes, the PR will be re-evaluated automatically.');
  return sections.join('\n');
}

/** Auto-stop preview containers after this duration (default 10 minutes). */
const PREVIEW_AUTO_STOP_MS = 10 * 60 * 1000;

const execFileAsync = promisify(execFile);

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
  ): Promise<{ networkName: string; firewallScript: string } | null>;
  getGatewayIp(): Promise<string>;
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
  extendPrAttempts(podId: string, additionalAttempts: number): Promise<void>;
  pauseSession(podId: string): Promise<void>;
  nudgeSession(podId: string, message: string): void;
  killSession(podId: string): Promise<void>;
  completeSession(
    podId: string,
    options?: { promoteTo?: 'pr' | 'branch' | 'artifact' | 'none' },
  ): Promise<{ pushError?: string; promotedTo?: 'pr' | 'branch' | 'artifact' | 'none' }>;
  /** Promote an interactive pod to auto on the same pod ID. */
  promoteToAuto(
    podId: string,
    targetOutput: 'pr' | 'branch' | 'artifact' | 'none',
  ): Promise<void>;
  triggerValidation(podId: string, options?: { force?: boolean }): Promise<void>;
  /** Pull latest from remote branch and re-run validation without agent rework on failure.
   *  Used after human fixes via a linked workspace pod. */
  revalidateSession(podId: string): Promise<{ newCommits: boolean; result: 'pass' | 'fail' }>;
  /** Create a linked workspace pod on the same branch as a failed worker pod for human fixes. */
  fixManually(podId: string, userId: string): Pod;
  createHistoryWorkspace(profileName: string, userId: string, historyQuery: HistoryQuery): Pod;
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
  /**
   * Inject provider credentials directly into a running container without exposing the token.
   * Reads the PAT from the profile, runs the auth command inside the container, and deletes
   * the temp credential file. Safe to call from user-initiated flows (workspace pods, CLI).
   */
  injectCredential(podId: string, service: 'github' | 'ado'): Promise<void>;
  /**
   * Manually spawn a fix pod for a merge_pending pod, bypassing the
   * automatic detection guards. Clears any stale fixPodId first so the fix
   * is created immediately rather than waiting for the next poll cycle.
   * Bumps maxPrFixAttempts if the current cap would otherwise block spawn.
   */
  spawnFixSession(podId: string): Promise<void>;
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
    prManagerFactory,
    enqueueSession,
    mcpBaseUrl,
    daemonConfig,
    logger,
    validationRepo,
    progressEventRepo,
  } = deps;

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
   * Spawns a new child fix pod on the same branch when the PR has actionable
   * failures (CI check failures or CHANGES_REQUESTED review comments).
   * Guards against double-spawning and enforces maxPrFixAttempts.
   * Lifted to outer scope so both the merge poller and spawnFixSession can call it.
   */
  const maybeSpawnFixSession = async (
    parentSessionId: string,
    status: PrMergeStatus,
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

    // Build fix task and create child pod directly using closure deps
    const newAttempt = (parent.prFixAttempts ?? 0) + 1;
    const fixTask = buildPrFixTask(parent, status, podRepo);
    const profile = profileStore.get(parent.profileName);

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
          branch: parent.branch,
          userId: parent.userId,
          maxValidationAttempts: profile.maxValidationAttempts,
          skipValidation: false,
          options: parent.options,
          outputMode: parent.outputMode,
          baseBranch: parent.baseBranch ?? null,
          linkedPodId: parent.id,
          pimGroups: parent.pimGroups ?? null,
          prUrl: parent.prUrl ?? null,
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

    // Record fix pod on parent
    podRepo.update(parentSessionId, {
      prFixAttempts: newAttempt,
      fixPodId: fixId,
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
          transition(pod, 'complete', {
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
              duration: pod.startedAt
                ? Date.now() - new Date(pod.startedAt).getTime()
                : null,
              filesChanged: pod.filesChanged,
              createdAt: pod.createdAt,
            },
          });

          logger.info(
            { podId, prUrl: pod.prUrl },
            'Merge polling: PR merged — pod complete',
          );
          stopMergePolling(podId);
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
      logger.info(
        { podId: pod.id, prUrl: pod.prUrl },
        'Resuming merge polling after restart',
      );
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
        const shaResult = await cm.execInContainer(
          pod.containerId,
          ['git', 'rev-parse', 'HEAD'],
          { cwd: '/workspace', timeout: 5_000 },
        );
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
   * Needed because OAuth tokens may have been rotated since the initial spawn.
   *
   * Before refreshing via the OAuth endpoint, we attempt to recover the latest
   * credentials directly from the container filesystem — Claude Code writes
   * rotated tokens there, and our post-exec persistence may have silently failed.
   */
  async function getResumeEnv(pod: Pod): Promise<Record<string, string> | undefined> {
    const profile = profileStore.get(pod.profileName);
    const provider = profile.modelProvider;
    // Only MAX provider needs fresh env on resume (token rotation)
    if (provider !== 'max') return undefined;

    // Recover latest tokens from the container before we try to refresh.
    // The container is the source of truth — Claude Code rotates tokens during use
    // and writes them to ~/.claude/.credentials.json. If our earlier persistence
    // missed the update, the profile store has a stale (already-invalidated) refresh
    // token and the OAuth refresh will fail with invalid_grant.
    if (pod.containerId) {
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
    // Also re-write credential files to container in case tokens were rotated
    if (result.containerFiles.length > 0 && pod.containerId) {
      const cm = containerManagerFactory.get(pod.executionTarget);
      for (const file of result.containerFiles) {
        await cm.writeFile(pod.containerId, file.path, file.content);
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
   * If the container is already stopped (user disconnected before sync ran), falls
   * back to Docker's archive API which reads the container filesystem offline.
   */
  async function syncWorkspaceBack(
    containerId: string,
    worktreePath: string,
    cm: ContainerManager,
  ): Promise<void> {
    try {
      await cm.execInContainer(
        containerId,
        [
          'sh',
          '-c',
          'find /mnt/worktree -mindepth 1 -maxdepth 1 -exec rm -rf {} + && cp -a /workspace/. /mnt/worktree/',
        ],
        { timeout: 120_000 },
      );
    } catch (err) {
      // Container may have already exited before we could exec into it.
      // Docker returns 409 for exec on a stopped container. In that case, fall back to
      // extracting /workspace directly from the container's filesystem via the archive API,
      // which works on stopped (but not yet removed) containers.
      const isContainerNotRunning =
        (err &&
          typeof err === 'object' &&
          'statusCode' in err &&
          (err as { statusCode: number }).statusCode === 409) ||
        (err instanceof Error && err.message.includes('is not running'));
      if (isContainerNotRunning) {
        await cm.extractDirectoryFromContainer(containerId, '/workspace', worktreePath);
      } else {
        throw err;
      }
    }

    // Restore the bare repo's worktrees/<name>/gitdir to the host path now that files
    // are back on the host filesystem. During the pod it was pointed at /workspace/.git
    // (a container-only path) — leaving it there would break host-side git operations.
    try {
      const gitlinkContent = await readFile(path.join(worktreePath, '.git'), 'utf8');
      const bareWtDir = gitlinkContent.replace(/^gitdir:\s*/m, '').trim();
      await writeFile(path.join(bareWtDir, 'gitdir'), path.join(worktreePath, '.git') + '\n');
    } catch (err) {
      logger.warn({ err, worktreePath }, 'Failed to restore worktree gitdir after sync');
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
    logger.info(
      { podId, containerId },
      'Installing az CLI via pip (bootstrap.pypa.io get-pip.py)',
    );
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

  function transition(
    pod: Pod,
    to: PodStatus,
    extraUpdates?: Partial<PodUpdates>,
  ): Pod {
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

  return {
    createSession(request: CreatePodRequest, userId: string): Pod {
      const profile = profileStore.get(request.profileName);
      const model = request.model ?? profile.defaultModel;
      const runtime = request.runtime ?? profile.defaultRuntime;
      const executionTarget = request.executionTarget ?? profile.executionTarget;
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

      // Derive referenceRepos with mountPath from URL last segment
      const derivedReferenceRepos: ReferenceRepo[] = (request.referenceRepos ?? []).map((r) => ({
        url: r.url,
        mountPath:
          r.url
            .replace(/\.git$/, '')
            .split('/')
            .pop() ?? r.url,
      }));

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
            maxValidationAttempts: profile.maxValidationAttempts,
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
            referenceRepoPat: request.referenceRepoPat ?? null,
            scheduledJobId: request.scheduledJobId ?? null,
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

      enqueueSession(id);
      logger.info({ podId: id, profile: request.profileName }, 'Pod created');
      return pod;
    },

    createHistoryWorkspace(
      profileName: string,
      userId: string,
      historyQuery: HistoryQuery,
    ): Pod {
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

    async processPod(podId: string): Promise<void> {
      let pod = podRepo.getOrThrow(podId);
      const profile = profileStore.get(pod.profileName);

      function emitStatus(message: string): void {
        emitActivityStatus(podId, message);
      }

      try {
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
              await access(path.join(pod.recoveryWorktreePath, '.git'));
              recoveryViable = true;
            } catch {
              logger.warn(
                { podId, worktreePath: pod.recoveryWorktreePath },
                'Recovery worktree missing or not a git directory — falling back to fresh worktree',
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
            const result = await worktreeManager.create({
              repoUrl: profile.repoUrl,
              branch: pod.branch,
              baseBranch: pod.baseBranch ?? profile.defaultBranch,
              pat: profile.adoPat ?? profile.githubPat ?? undefined,
            });
            worktreePath = result.worktreePath;
            bareRepoPath = result.bareRepoPath;
          }
        }

        // If acFrom is set, read acceptance criteria from the worktree
        if (pod.acFrom && worktreePath) {
          const criteria = await readAcFile(worktreePath, pod.acFrom);
          podRepo.update(podId, { acceptanceCriteria: criteria });
          pod = podRepo.getOrThrow(podId);
          logger.info(
            { podId, acFrom: pod.acFrom, count: criteria.length },
            'Loaded acceptance criteria from file',
          );
        }

        // Select container manager based on execution target
        const containerManager = containerManagerFactory.get(pod.executionTarget);

        // Compute network isolation config (Docker only, opt-in via profile)
        let networkName: string | undefined;
        let firewallScript: string | undefined;
        if (
          networkManager &&
          pod.executionTarget === 'local' &&
          profile.networkPolicy?.enabled
        ) {
          const mergedServers = mergeMcpServers(daemonConfig.mcpServers, profile.mcpServers);
          const gatewayIp = await networkManager.getGatewayIp();
          const netConfig = await networkManager.buildNetworkConfig(
            profile.networkPolicy,
            mergedServers,
            gatewayIp,
            profile.privateRegistries,
          );
          if (netConfig) {
            networkName = netConfig.networkName;
            firewallScript = netConfig.firewallScript;
          }
        }

        // Allocate a host port for the container's app server
        const hostPort = allocateHostPort();

        // Spawn container with port mapping so daemon + user can reach the app
        emitStatus(`Spawning container (${profile.template})…`);

        // For .NET templates, cap MSBuild node count to half the available CPUs
        // (min 2, max 4) to prevent dozens of MSBuild workers from exhausting memory.
        const isDotnet = profile.template.startsWith('dotnet');

        // Resolve registry PAT early — needed for both container env vars and config files.
        // Fall back to adoPat when registryPat isn't set — they're usually the same
        // PAT for ADO-hosted feeds, and requiring both is a footgun.
        const effectiveRegistryPat = profile.registryPat ?? profile.adoPat ?? null;

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
          // NuGet credential provider env — auth handled via env var, not config files
          ...buildNuGetCredentialEnv(profile.privateRegistries, effectiveRegistryPat),
        };

        const containerId = await containerManager.spawn({
          image: getBaseImage(profile.template),
          podId,
          env: containerEnv,
          ports: [{ container: CONTAINER_APP_PORT, host: hostPort }],
          volumes: [
            ...(worktreePath ? [{ host: worktreePath, container: '/mnt/worktree' }] : []),
            ...(bareRepoPath ? [{ host: bareRepoPath, container: bareRepoPath }] : []),
          ],
          networkName,
          firewallScript,
          memoryBytes:
            (profile.containerMemoryGb ?? DEFAULT_CONTAINER_MEMORY_GB) * 1024 * 1024 * 1024,
        });

        // Copy worktree content from bind mount to container's native filesystem.
        // VirtioFS bind mounts break getcwd() on Docker Desktop for Mac — overlayfs does not.
        // Skipped for artifact pods with no worktree.
        if (worktreePath) {
          emitStatus('Populating workspace…');
          await containerManager.execInContainer(
            containerId,
            ['cp', '-a', '/mnt/worktree/.', '/workspace/'],
            { timeout: 120_000 },
          );
          // The bare repo's worktrees/<name>/gitdir still points to the host bind-mount
          // path (/mnt/worktree or the host worktree dir). Repoint it to /workspace so
          // git commands work on the container's native overlayfs filesystem.
          await containerManager.execInContainer(
            containerId,
            [
              'sh',
              '-c',
              'BARE_WT=$(sed "s/^gitdir: //" /workspace/.git) && echo "/workspace/.git" > "${BARE_WT}/gitdir"',
            ],
            { timeout: 5_000 },
          );
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
            const refPat = pod.referenceRepoPat ?? undefined;
            const authUrl = refPat ? injectPatIntoUrl(repo.url, refPat) : repo.url;
            try {
              await containerManager.execInContainer(
                containerId,
                ['git', 'clone', '--depth', '1', authUrl, destPath],
                { timeout: 60_000 },
              );
              if (refPat) {
                // Strip the PAT from the remote so it cannot be read inside the container
                await containerManager.execInContainer(
                  containerId,
                  ['git', 'remote', 'set-url', 'origin', repo.url],
                  { cwd: destPath, timeout: 5_000 },
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
          const skillsDir = `${CONTAINER_HOME_DIR}/.claude/commands`;
          for (const skill of resolvedSkills) {
            await containerManager.writeFile(
              containerId,
              `${skillsDir}/${skill.name}.md`,
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
          // Write provider credential files + Claude config (disclaimer ack, folder trust) so
          // interactive Claude Code in the terminal doesn't show onboarding/disclaimer/trust prompts.
          // Best-effort — missing/expired credentials are fine for workspace pods since the user
          // can authenticate manually via `ap inject` after attaching.
          try {
            const wsProviderResult = await buildProviderEnv(profile, podId, logger);
            for (const file of wsProviderResult.containerFiles) {
              await containerManager.writeFile(containerId, file.path, file.content);
            }
          } catch (err) {
            logger.warn(
              { err, podId },
              'Could not write provider credentials to workspace container — user will need to authenticate manually',
            );
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

          logger.info({ podId }, 'Workspace pod running — awaiting manual attach');
          return;
        }

        // Merge daemon + profile injections
        const mergedMcpServers = mergeMcpServers(daemonConfig.mcpServers, profile.mcpServers);
        const mergedSections = mergeClaudeMdSections(
          daemonConfig.claudeMdSections,
          profile.claudeMdSections,
        );

        // Rewrite injected MCP server URLs to route through daemon proxy
        // Agent sees proxy URLs, daemon handles auth injection + PII stripping
        const proxiedMcpServers = mergedMcpServers.map((s) => ({
          ...s,
          url: `${mcpBaseUrl}/mcp-proxy/${encodeURIComponent(s.name)}/${podId}`,
          // Don't expose auth headers to agent — proxy injects them
          headers: undefined,
        }));

        // Resolve available actions from profile's action policy
        const availableActions = profile.actionPolicy
          ? (deps.actionEngine?.getAvailableActions(profile.actionPolicy) ?? [])
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
          injectedMcpServers: proxiedMcpServers,
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
        const mcpServers = [
          { name: 'escalation', url: mcpUrl, headers: escalationHeaders },
          ...proxiedMcpServers.map((s) => ({
            name: s.name,
            url: s.url,
            headers: escalationHeaders,
          })),
        ];

        // Build provider-aware env (API keys, OAuth creds, Foundry config)
        emitStatus('Building provider credentials…');
        const providerResult = await buildProviderEnv(profile, podId, logger);
        const secretEnv: Record<string, string> = {
          POD_ID: podId,
          ...providerResult.env,
        };

        // Codex runtime uses its own key from daemon env
        if (pod.runtime === 'codex' && process.env.OPENAI_API_KEY) {
          secretEnv.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
        }

        // Write provider credential files to container (e.g., OAuth .credentials.json for MAX)
        for (const file of providerResult.containerFiles) {
          await containerManager.writeFile(containerId, file.path, file.content);
          logger.info(
            { podId, path: file.path, bytes: file.content.length },
            'Wrote provider credential file to container',
          );
        }

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

        // Early validation: verify registry configs are parseable before agent starts
        if (registryFiles.length > 0) {
          try {
            await validateRegistryFiles(containerManager, containerId, registryFiles);
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
        // Try to transition to failed if possible
        try {
          pod = podRepo.getOrThrow(podId);
          if (!isTerminalState(pod.status)) {
            if (canKill(pod.status)) {
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
          } else if (
            event.type === 'status' &&
            event.message.includes('Claude pod initialized')
          ) {
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
                  emitActivityStatus(
                    podId,
                    'Token budget hard limit reached — failing pod',
                  );
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
            await cm.extractDirectoryFromContainer(
              pod.containerId,
              '/workspace',
              artifactsPath,
            );
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
            const pat = profile.adoPat ?? profile.githubPat ?? undefined;
            const worktreeResult = await worktreeManager.create({
              repoUrl: profile.repoUrl,
              branch: repoBranch,
              baseBranch: pod.baseBranch ?? profile.defaultBranch,
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
            await worktreeManager.pushBranch(worktreeResult.worktreePath);
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
      if (pod.containerId && pod.worktreePath) {
        try {
          const cm = containerManagerFactory.get(pod.executionTarget);
          await syncWorkspaceBack(pod.containerId, pod.worktreePath, cm);
        } catch (err) {
          syncSucceeded = false;
          logger.warn({ err, podId }, 'Failed to sync workspace back to host');
        }
      }

      // Auto-commit any uncommitted changes the agent left behind, then get diff stats.
      // When sync failed, block all deletions (threshold=0) to prevent committing a
      // partially-synced worktree that looks like mass file deletions.
      if (pod.worktreePath) {
        try {
          const committed = await worktreeManager.commitPendingChanges(
            pod.worktreePath,
            'chore: auto-commit uncommitted agent changes',
            { maxDeletions: syncSucceeded ? 100 : 0 },
          );
          if (committed) {
            logger.info({ podId }, 'Auto-committed uncommitted agent changes');
          }
        } catch (err) {
          logger.error({ err, podId }, 'Auto-commit blocked by deletion safety guard');
        }

        try {
          const profile = profileStore.get(pod.profileName);
          // Forked pods (linkedPodId set, or baseBranch differs from defaultBranch)
          // inherit changes from a parent branch. Diff against defaultBranch (not startCommitSha)
          // so the parent's changes are included in the stats.
          const isFork =
            Boolean(pod.linkedPodId) ||
            (pod.baseBranch && pod.baseBranch !== profile.defaultBranch);
          const sinceCommit = isFork ? undefined : (pod.startCommitSha ?? undefined);
          const stats = await worktreeManager.getDiffStats(
            pod.worktreePath,
            profile.defaultBranch,
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
        transition(s2, 'validated');
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
        emitActivityStatus(
          podId,
          `Credential injected for ${payload.service} — resuming agent…`,
        );

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
            const events = runtime.resume(
              podId,
              correctionMessage,
              pod.containerId,
              resumeEnv,
            );
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
        transition(s2, 'complete', { completedAt: new Date().toISOString() });
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
        return;
      }

      emitActivityStatus(podId, 'Approved — merging changes…');
      const s1 = transition(pod, 'approved');
      const s2 = transition(s1, 'merging');

      // Merge the PR if one was created, otherwise fall back to branch push
      const approveProfile = profileStore.get(pod.profileName);
      const prManager = prManagerFactory ? prManagerFactory(approveProfile) : null;
      if (pod.prUrl && prManager && pod.worktreePath) {
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
            logger.warn(
              { err: statusErr, podId },
              'Failed to check PR status after merge failure',
            );
          }
          emitActivityStatus(podId, 'PR merge failed — pod still completing');
        }
      } else if (!pod.prUrl && prManager && pod.worktreePath) {
        // PR creation failed during validation — retry it now
        emitActivityStatus(podId, 'No PR found — creating PR before merging…');
        try {
          const retryProfile = profileStore.get(pod.profileName);
          await worktreeManager.mergeBranch({
            worktreePath: pod.worktreePath,
            targetBranch: retryProfile.defaultBranch,
          });
          const newPrUrl = await prManager.createPr({
            // biome-ignore lint/style/noNonNullAssertion: worktreePath is non-null in approval retry — pods reach approved only after successful validation which requires a worktree
            worktreePath: pod.worktreePath!,
            repoUrl: retryProfile.repoUrl ?? undefined,
            branch: pod.branch,
            baseBranch: retryProfile.defaultBranch,
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
          emitActivityStatus(
            podId,
            'PR creation failed — branch is pushed but no PR was merged',
          );
        }
      } else if (pod.worktreePath) {
        // Fallback: no PR manager configured — push branch directly
        emitActivityStatus(podId, 'Pushing branch…');
        try {
          const profile = profileStore.get(pod.profileName);
          await worktreeManager.mergeBranch({
            worktreePath: pod.worktreePath,
            targetBranch: profile.defaultBranch,
          });
          emitActivityStatus(podId, 'Branch pushed successfully');
        } catch (err) {
          logger.error({ err, podId }, 'Failed to push branch during approval');
          emitActivityStatus(podId, 'Branch push failed — pod still completing');
        }
      }

      emitActivityStatus(podId, 'Pod complete');
      transition(s2, 'complete', { completedAt: new Date().toISOString() });

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

      logger.info(
        { podId, reason, previousStatus },
        'Pod rejected, resuming agent with feedback',
      );
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
        // Kill container
        if (pod.containerId) {
          try {
            const cm = containerManagerFactory.get(pod.executionTarget);
            await cm.kill(pod.containerId);
          } catch (err) {
            logger.warn({ err, podId }, 'Failed to kill container');
          }
        }

        // Abort runtime
        try {
          const runtime = runtimeRegistry.get(pod.runtime);
          await runtime.abort(podId);
        } catch (err) {
          logger.warn({ err, podId }, 'Failed to abort runtime');
        }

        // Cleanup worktree
        if (pod.worktreePath) {
          try {
            await worktreeManager.cleanup(pod.worktreePath);
          } catch (err) {
            logger.warn({ err, podId }, 'Failed to cleanup worktree');
          }
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

      // Sync the human's work back to the host worktree so the agent picks
      // up where they left off.
      if (pod.containerId && pod.worktreePath) {
        try {
          const cm = containerManagerFactory.get(pod.executionTarget);
          await syncWorkspaceBack(pod.containerId, pod.worktreePath, cm);
        } catch (err) {
          logger.warn({ err, podId }, 'Failed to sync workspace back during promotion');
        }
      }

      // Tear down the interactive container — processPod will spawn a
      // fresh one for the agent phase.
      if (pod.containerId) {
        try {
          const cm = containerManagerFactory.get(pod.executionTarget);
          await cm.stop(pod.containerId);
        } catch (err) {
          logger.warn({ err, podId }, 'Failed to stop interactive container during promotion');
        }
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
        containerId: null,
        // Reuse the existing worktree in recovery mode so the agent resumes
        // on the human's in-flight work.
        recoveryWorktreePath: pod.worktreePath,
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
      options?: { promoteTo?: 'pr' | 'branch' | 'artifact' | 'none' },
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
        await this.promoteToAuto(podId, options.promoteTo);
        return { promotedTo: options.promoteTo };
      }

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
      let pushError: string | undefined;
      if (pod.worktreePath) {
        try {
          // Pre-commit with tight deletion guard when sync failed, so mergeBranch
          // doesn't blindly commit a partially-synced worktree.
          if (!workspaceSyncOk) {
            await worktreeManager.commitPendingChanges(
              pod.worktreePath,
              'chore: auto-commit uncommitted changes before merge',
              { maxDeletions: 0 },
            );
          }
          // mergeBranch auto-commits any remaining uncommitted changes before pushing
          await worktreeManager.mergeBranch({
            worktreePath: pod.worktreePath,
            targetBranch: pod.branch ?? 'HEAD',
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
      if (force && fromTerminal && pod.worktreePath) {
        emitActivityStatus(podId, 'Re-provisioning pod with fresh container…');

        // Kill the old container (best-effort — it may already be dead)
        if (pod.containerId) {
          try {
            const cm = containerManagerFactory.get(pod.executionTarget);
            await cm.kill(pod.containerId);
          } catch {
            // Container may already be removed — that's fine
          }
        }

        // Re-queue through processPod with recovery worktree.
        // Clear claudeSessionId so the agent gets a fresh spawn instead of resuming
        // a stale/broken pod context. Set reworkReason so processPod builds
        // a rework-specific prompt instead of the generic "you were interrupted" recovery prompt.
        const reworkReason =
          pod.status === 'failed'
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
          recoveryWorktreePath: pod.worktreePath,
          reworkReason,
        });
        transition(pod, 'queued');
        enqueueSession(podId);

        logger.info(
          { podId, worktreePath: pod.worktreePath, reworkReason },
          'Rework: re-queued with fresh container provisioning',
        );
        return;
      }

      const profile = profileStore.get(pod.profileName);

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

      emitActivityStatus(podId, `Starting validation (attempt ${attempt})…`);

      try {
        if (!pod.containerId) {
          throw new Error(`Pod ${podId} has no container — cannot validate`);
        }

        // Restart the container if it was stopped (e.g. after max attempts exhausted)
        if (force) {
          const cm = containerManagerFactory.get(pod.executionTarget);
          await cm.start(pod.containerId);
        }

        // Sync workspace back before reading diff/commit log from host worktree
        if (pod.containerId && pod.worktreePath) {
          try {
            const cm = containerManagerFactory.get(pod.executionTarget);
            await syncWorkspaceBack(pod.containerId, pod.worktreePath, cm);
          } catch (err) {
            logger.warn({ err, podId }, 'Failed to sync workspace before validation');
          }
        }

        // Get the actual diff and commit log for AI task review.
        // Always scope to the agent's own commits via startCommitSha. The reviewer
        // should only evaluate what this agent changed — pre-existing code on a
        // parent branch is not the agent's responsibility. Stats/file counts still
        // use the full branch diff (computed earlier) for accurate PR sizing.
        const diffSinceCommit = pod.startCommitSha ?? undefined;
        const [diff, commitLog] = pod.worktreePath
          ? await Promise.all([
              worktreeManager.getDiff(
                pod.worktreePath,
                profile.defaultBranch,
                undefined,
                diffSinceCommit,
              ),
              worktreeManager.getCommitLog(
                pod.worktreePath,
                profile.defaultBranch,
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
          buildCommand: profile.buildCommand,
          startCommand: profile.startCommand,
          healthPath: profile.healthPath,
          healthTimeout: profile.healthTimeout,
          smokePages: profile.smokePages,
          attempt,
          task: pod.task,
          diff,
          testCommand: profile.testCommand,
          buildTimeout: profile.buildTimeout * 1_000,
          testTimeout: profile.testTimeout * 1_000,
          reviewerModel: profile.escalation.askAi.model || profile.defaultModel || 'sonnet',
          acceptanceCriteria: pod.acceptanceCriteria ?? undefined,
          codeReviewSkill,
          commitLog: commitLog || undefined,
          plan: pod.plan ?? undefined,
          taskSummary: pod.taskSummary ?? undefined,
          worktreePath: pod.worktreePath ?? undefined,
          startCommitSha: pod.startCommitSha ?? undefined,
          overrides: currentOverrides.length > 0 ? currentOverrides : undefined,
          hasWebUi: profile.hasWebUi ?? true,
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
          result = {
            podId,
            attempt,
            timestamp: new Date().toISOString(),
            overall: 'fail',
            smoke: {
              status: 'fail',
              build: { status: 'fail', output: String(validateErr), duration: 0 },
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
            logger.info(
              { podId, count: screenshots.length },
              'Collected validation screenshots',
            );
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
                emitActivityStatus(
                  podId,
                  'Deeper review tier passed — overriding Tier 1 result',
                );
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

        if (effectiveResult.overall === 'pass') {
          emitActivityStatus(podId, `Validation passed (attempt ${attempt})`);
          // Push branch and create PR before transitioning to validated.
          // Fix pods already have prUrl set — carry it forward and skip PR creation.
          let prUrl: string | null = s2.prUrl ?? null;
          const prManager = prManagerFactory ? prManagerFactory(profile) : null;
          if (prManager && s2.worktreePath) {
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

            // Push branch so `gh pr create --head` can reference it
            try {
              await worktreeManager.mergeBranch({
                worktreePath: s2.worktreePath,
                targetBranch: profile.defaultBranch,
              });
            } catch (err) {
              logger.warn({ err, podId }, 'Failed to push branch for PR');
            }

            // Re-compute diff stats now that auto-commit has run.
            // For forked pods, diff against baseBranch to include the parent's changes.
            try {
              const prSinceCommit =
                s2.linkedPodId || (s2.baseBranch && s2.baseBranch !== profile.defaultBranch)
                  ? undefined
                  : (s2.startCommitSha ?? undefined);
              const stats = await worktreeManager.getDiffStats(
                s2.worktreePath,
                profile.defaultBranch,
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
                prUrl = await prManager.createPr({
                  // biome-ignore lint/style/noNonNullAssertion: worktreePath is non-null here — PR creation only occurs for non-artifact pods which always have a worktree
                  worktreePath: s2.worktreePath!,
                  repoUrl: profile.repoUrl ?? undefined,
                  branch: s2.branch,
                  baseBranch: profile.defaultBranch,
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
          transition(s2, 'validated', { prUrl });

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
        } else if (force || attempt < s2.maxValidationAttempts) {
          emitActivityStatus(
            podId,
            `Validation failed (attempt ${attempt}/${s2.maxValidationAttempts}) — retrying`,
          );
          // Build correction message with structured feedback for the agent
          emitActivityStatus(podId, 'Sending validation feedback to agent…');
          const cm = containerManagerFactory.get(s2.executionTarget);
          const correctionMessage = await buildCorrectionMessage(s2, profile, result, cm);
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

      // Transition to validating
      transition(pod, 'validating');

      // Re-run validation (force=true restarts container, but we don't want agent retry on failure)
      const profile = profileStore.get(pod.profileName);
      const attempt = 1;
      podRepo.update(podId, { validationAttempts: attempt });

      emitActivityStatus(podId, 'Starting revalidation (human fix)…');

      try {
        if (!pod.containerId) {
          throw new Error(`Pod ${podId} has no container — cannot validate`);
        }

        // Restart the container with updated worktree
        const cm = containerManagerFactory.get(pod.executionTarget);
        await cm.start(pod.containerId);

        const [diff, commitLog] = pod.worktreePath
          ? await Promise.all([
              worktreeManager.getDiff(
                pod.worktreePath,
                profile.defaultBranch,
                undefined,
                pod.startCommitSha ?? undefined,
              ),
              worktreeManager.getCommitLog(
                pod.worktreePath,
                profile.defaultBranch,
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
              buildCommand: profile.buildCommand,
              startCommand: profile.startCommand,
              healthPath: profile.healthPath,
              healthTimeout: profile.healthTimeout,
              smokePages: profile.smokePages,
              attempt,
              task: pod.task,
              diff,
              testCommand: profile.testCommand,
              buildTimeout: profile.buildTimeout * 1_000,
              testTimeout: profile.testTimeout * 1_000,
              reviewerModel: profile.escalation.askAi.model || profile.defaultModel || 'sonnet',
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
          result = {
            podId,
            attempt,
            timestamp: new Date().toISOString(),
            overall: 'fail',
            smoke: {
              status: 'fail',
              build: { status: 'fail', output: String(validateErr), duration: 0 },
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
          if (prManager && s2.worktreePath) {
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
              await worktreeManager.mergeBranch({
                worktreePath: s2.worktreePath,
                targetBranch: profile.defaultBranch,
              });
            } catch (err) {
              logger.warn({ err, podId }, 'Failed to push branch for PR');
            }

            try {
              const failSinceCommit =
                s2.linkedPodId || (s2.baseBranch && s2.baseBranch !== profile.defaultBranch)
                  ? undefined
                  : (s2.startCommitSha ?? undefined);
              const stats = await worktreeManager.getDiffStats(
                s2.worktreePath,
                profile.defaultBranch,
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
                prUrl = await prManager.createPr({
                  // biome-ignore lint/style/noNonNullAssertion: worktreePath is non-null here — PR creation only occurs for non-artifact pods which always have a worktree
                  worktreePath: s2.worktreePath!,
                  repoUrl: profile.repoUrl ?? undefined,
                  branch: s2.branch,
                  baseBranch: profile.defaultBranch,
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

          transition(s2, 'validated', { prUrl });

          // Stop the container
          if (s2.containerId) {
            try {
              const cm2 = containerManagerFactory.get(s2.executionTarget);
              await cm2.stop(s2.containerId);
            } catch (err) {
              logger.warn({ err, podId }, 'Failed to stop container post-revalidation');
            }
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
      if (pod.containerId) {
        try {
          const cm = containerManagerFactory.get(pod.executionTarget);
          await cm.kill(pod.containerId);
        } catch (err) {
          logger.warn({ err, podId }, 'Failed to kill container during delete');
        }
      }

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
      emitActivityStatus(
        podId,
        `Validation attempts extended to ${newMax} — resuming validation`,
      );
      await this.triggerValidation(podId);
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
      emitActivityStatus(
        podId,
        `PR fix attempts extended to ${newMax} — resuming merge polling`,
      );
      startMergePolling(podId);
      logger.info(
        { podId, oldMax: currentMax, newMax, additionalAttempts },
        'Extended PR fix attempts',
      );
    },

    interruptValidation(podId: string): void {
      validationAbortControllers.get(podId)?.abort();
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
      const gatewayIp = await networkManager.getGatewayIp();
      const netConfig = await networkManager.buildNetworkConfig(
        profile.networkPolicy,
        mergedServers,
        gatewayIp,
        profile.privateRegistries,
      );
      if (!netConfig) return;

      const cm = containerManagerFactory.get('local');
      await Promise.all(
        runningSessions.map(async (pod) => {
          try {
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
        throw new AutopodError(
          `Pod ${podId} has no running container`,
          'INVALID_STATE',
          409,
        );
      }
      await performCredentialInjection(podId, service);
      emitActivityStatus(podId, `${service} credentials injected.`);
    },

    async spawnFixSession(podId: string): Promise<void> {
      const pod = podRepo.getOrThrow(podId);
      if (pod.status !== 'merge_pending') {
        throw new AutopodError(
          `Cannot spawn fix pod for ${podId} in status ${pod.status} — only merge_pending pods`,
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
      if (!pod.prUrl) {
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

      // Fetch current PR status to build a meaningful fix task
      const profile = profileStore.get(pod.profileName);
      const prManager = prManagerFactory ? prManagerFactory(profile) : null;
      let status: PrMergeStatus = {
        merged: false,
        open: true,
        blockReason: pod.mergeBlockReason ?? 'PR is blocked',
        ciFailures: [],
        reviewComments: [],
      };
      if (prManager) {
        try {
          status = await prManager.getPrStatus({
            prUrl: pod.prUrl,
            worktreePath: pod.worktreePath ?? undefined,
          });
        } catch (err) {
          logger.warn(
            { err, podId },
            'Manual spawn: failed to fetch PR status, using cached block reason',
          );
        }
      }

      await maybeSpawnFixSession(podId, status);
      logger.info({ podId }, 'Manual fix pod spawn triggered');
    },
  };
}
