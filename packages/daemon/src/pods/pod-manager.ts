import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { PendingRequests } from '@autopod/escalation-mcp';
import type {
  AgentEvent,
  BuildResult,
  CreatePodRequest,
  DaemonConfig,
  EscalationRequest,
  ExecutionTarget,
  FactValidationResult,
  HealthResult,
  HistoryQuery,
  InjectedMcpServer,
  LintResult,
  McpServerConfig,
  NetworkPolicy,
  PageResult,
  PhaseTokenUsage,
  Pod,
  PodOptions,
  PodStatus,
  PrivateRegistry,
  Profile,
  RequestCredentialPayload,
  SastResult,
  SpawnFixResponse,
  StdioInjectedMcpServer,
  TaskReviewResult,
  UpdateFromBaseResponse,
  ValidationFinding,
  ValidationOverride,
  ValidationOverridePayload,
  ValidationPhase,
  ValidationResult,
  ValidationWaiver,
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
import {
  type HaproxyDenyStreamHandle,
  streamHaproxyDenials,
} from '../containers/haproxy-deny-stream.js';
import type { SidecarManager } from '../containers/sidecar-manager.js';
import {
  getAutoAttachedSidecars,
  resolveSidecarSpec,
  sidecarPodEnv,
} from '../containers/sidecar-resolver.js';
import type { PodTokenIssuer } from '../crypto/pod-tokens.js';
import { createHistoryExporter } from '../history/history-exporter.js';
import {
  generateHistoryInstructions,
  getHistoryInstructionTarget,
} from '../history/instructions-generator.js';
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
import { assertNoExpiredPat } from '../profiles/pat-expiry.js';
import {
  buildClaudeConfigFiles,
  buildProviderEnv,
  persistRefreshedCredentials,
} from '../providers/index.js';
import { type ClaudeRuntime, ResumeSessionNotFoundError } from '../runtimes/claude-runtime.js';
import { cleanupClaudeState, ensureClaudeStateDir } from '../runtimes/claude-state-store.js';
import { cleanupCodexState, ensureCodexStateDir } from '../runtimes/codex-state-store.js';
import { detectRecurringFindings, extractFindings } from '../validation/finding-fingerprint.js';
import { applyOverrides } from '../validation/override-applicator.js';
import { parseDiffFilePaths } from '../validation/review-context-builder.js';
import {
  buildGitHubImageUrl,
  collectFactScreenshots,
  collectScreenshots,
} from '../validation/screenshot-collector.js';
import { pushCommitsToBareViaStagingRef } from '../worktrees/bare-push.js';
import { DeletionGuardError, GitCredentialError } from '../worktrees/local-worktree-manager.js';
import { MergeQueue } from '../worktrees/merge-queue.js';
import { agentToolingCachePaths } from './agent-tooling-cache-paths.js';
import { buildCorrectionMessage } from './correction-context.js';
import type { EscalationRepository } from './escalation-repository.js';
import type { EventBus } from './event-bus.js';
import type { EventRepository } from './event-repository.js';
import { formatFeedback } from './feedback-formatter.js';
import type { FixFeedbackRepository } from './fix-feedback-repository.js';
import { mergeClaudeMdSections, mergeMcpServers, mergeSkills } from './injection-merger.js';
import { reconcileLocalSessions } from './local-reconciler.js';
import type { NudgeRepository } from './nudge-repository.js';
import type { PodRepository, PodStats, PodUpdates } from './pod-repository.js';
import { type PreflightConflict, findPreflightConflicts } from './preflight.js';
import { buildSupervisorCommand, parseStatus } from './preview-supervisor.js';
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
import { resolvePodModel, resolvePodRuntime } from './runtime-resolver.js';
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

/** Single-line per-phase summary used in activity log lines. Covers all active
 * phases the validation engine produces — partial summaries can otherwise
 * contradict an `overall: fail` (e.g. tests/pages failed but only build/health
 * shown). Order matches pipeline order so the first `fail` is the failing gate. */
function summarizeValidationPhases(result: ValidationResult): string {
  const lintStatus = result.lint?.status ?? 'skip';
  const sastStatus = result.sast?.status ?? 'skip';
  const buildStatus = result.smoke.build.status;
  const testStatus = result.test?.status ?? 'skip';
  const healthStatus = result.smoke.health.status;
  const pagesStatus =
    result.smoke.pages.length === 0
      ? 'skip'
      : result.smoke.pages.every((p) => p.status === 'pass')
        ? 'pass'
        : 'fail';
  const factsStatus = result.factValidation?.status ?? 'skip';
  const reviewStatus = result.taskReview?.status ?? 'skip';
  return (
    `lint: ${lintStatus}, sast: ${sastStatus}, build: ${buildStatus}, ` +
    `tests: ${testStatus}, health: ${healthStatus}, pages: ${pagesStatus}, ` +
    `facts: ${factsStatus}, review: ${reviewStatus}`
  );
}

function failedValidationPhases(result: ValidationResult | null): string[] {
  if (!result) return [];
  const failed: string[] = [];
  if (result.lint?.status === 'fail') failed.push('lint');
  if (result.sast?.status === 'fail') failed.push('sast');
  if (result.smoke.build.status === 'fail') failed.push('build');
  if (result.test?.status === 'fail') failed.push('tests');
  if (result.smoke.health.status === 'fail') failed.push('health');
  if (result.smoke.pages.some((p) => p.status === 'fail')) failed.push('pages');
  if (result.factValidation?.status === 'fail') failed.push('facts');
  if (result.taskReview && result.taskReview.status !== 'pass') failed.push('review');
  return failed;
}

function failedFactIds(result: ValidationResult | null): string[] {
  return (
    result?.factValidation?.results
      .filter((fact) => fact.status === 'fail' || fact.passed === false)
      .map((fact) => fact.factId) ?? []
  );
}

function buildValidationWaiver(result: ValidationResult | null, reason?: string): ValidationWaiver {
  return {
    waivedAt: new Date().toISOString(),
    waivedBy: 'human',
    reason: reason?.trim() || 'Approved anyway by operator',
    attempt: result?.attempt ?? null,
    failedPhases: failedValidationPhases(result),
    failedFactIds: failedFactIds(result),
  };
}

/** Format a `mergeBlockReason` string for a rebase that produced conflicts.
 * Caps the conflict-file preview at 5 entries (with `…` if truncated) and
 * falls back to `(see logs)` when the conflict list itself isn't available. */
function formatRebaseConflictReason(baseBranch: string, conflicts: readonly string[]): string {
  const preview = conflicts.slice(0, 5).join(', ');
  const ellipsis = conflicts.length > 5 ? '…' : '';
  return `Rebase conflicts on ${baseBranch}: ${preview || '(see logs)'}${ellipsis}`;
}

/** Single-quote shell escaping. Names can contain spaces and apostrophes (e.g. `O'Brien`),
 * so we wrap in single quotes and escape any embedded single quotes the standard way. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

const WORKSPACE_RUNTIME_CACHE_EXCLUDES = ['node_modules', '.serena', '.roslyn-codelens'];
const WORKSPACE_SYNC_EXCLUDES = ['.git', ...WORKSPACE_RUNTIME_CACHE_EXCLUDES];

function workspaceMirrorPruneExpression(excludes: string[]): string {
  const predicates = excludes.map((name) => `-name ${shellQuote(name)}`).join(' -o ');
  return `\\( ${predicates} \\) -prune -o`;
}

function workspaceMirrorPreservePredicates(excludes: string[]): string[] {
  return excludes.flatMap((name) => [`! -path '*/${name}'`, `! -path '*/${name}/*'`]);
}

function buildWorkspaceMirrorCopyScript(
  sourceDir: string,
  targetDirArg: string,
  excludes: string[],
): string {
  const copyOne = [
    'target=$1',
    'shift',
    'for rel do',
    '  dest="$target/${rel#./}"',
    '  if [ -d "$rel" ] && [ ! -L "$rel" ]; then',
    '    mkdir -p "$dest"',
    '  else',
    '    mkdir -p "$(dirname "$dest")"',
    '    cp -a "$rel" "$dest"',
    '  fi',
    'done',
  ].join('; ');

  return [
    `cd ${shellQuote(sourceDir)}`,
    `find . -mindepth 1 ${workspaceMirrorPruneExpression(excludes)} -exec sh -c ${shellQuote(
      copyOne,
    )} sh ${targetDirArg} {} +`,
  ].join(' && ');
}

/** Normalize a JWT preferred_username into something that looks like an email.
 * Dev mode emits `developer` (no `@`); git accepts it but commits look weird.
 * Real Entra tokens already carry a UPN-shaped email here. */
function normalizeCommitEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const trimmed = email.trim();
  if (!trimmed) return null;
  return trimmed.includes('@') ? trimmed : `${trimmed}@autopod.local`;
}

/** Allocate a random host port in range 10000–48999 for container port mapping.
 * Capped at 48999 to avoid the Windows/Hyper-V ephemeral port reservation range (49152+). */
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

/**
 * Concatenates a PR's actionable failures (CI check failures + CHANGES_REQUESTED
 * review comments) into a single sanitized block, suitable for enqueueing into
 * the fix-pod feedback queue. Reviewer/CI content is attacker-controlled, so it
 * is run through the PI + PII pipeline before embedding.
 *
 * Exported for unit testing only.
 */
export function buildActionableFailureSummary(status: PrMergeStatus, profile: Profile): string {
  const sanitizeExternal = (text: string): string =>
    processContent(text, {
      quarantine: profile.contentProcessing?.quarantine ?? { enabled: true },
      sanitization: profile.contentProcessing?.sanitization ?? { preset: 'standard' },
    }).text;

  const sections: string[] = [];

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

  return sections.join('\n').trim();
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
 * Snapshot SHA-256 hashes of every script in `profile.deployment.allowedScripts`
 * read from the bare repo at the base ref. The deploy handler refuses to run a
 * script whose live container content does not hash to its baseline — without
 * this capture the agent could edit a deploy script and immediately invoke it.
 *
 * Glob patterns in `allowedScripts` (single-segment `*`) are expanded against
 * the file list at the base ref. Returns `null` when no patterns are
 * configured — caller treats that as "no baseline enforcement".
 */
async function captureDeployBaselineHashes(
  bareRepoPath: string,
  baseRef: string,
  allowedScripts: string[] | undefined,
  log: Logger,
): Promise<Record<string, string> | null> {
  if (!allowedScripts || allowedScripts.length === 0) return null;

  let files: string[];
  try {
    const { stdout } = await execFileAsync('git', [
      '--git-dir',
      bareRepoPath,
      'ls-tree',
      '-r',
      '--name-only',
      baseRef,
    ]);
    files = stdout.split('\n').filter((l) => l.length > 0);
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), bareRepoPath, baseRef },
      'deploy baseline: could not list files at base ref',
    );
    return {};
  }

  const matches = new Set<string>();
  for (const pattern of allowedScripts) {
    if (!pattern.includes('*')) {
      if (files.includes(pattern)) matches.add(pattern);
      continue;
    }
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^${escaped.replace(/\*/g, '[^/]*')}$`);
    for (const f of files) {
      if (re.test(f)) matches.add(f);
    }
  }

  const hashes: Record<string, string> = {};
  for (const scriptPath of matches) {
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['--git-dir', bareRepoPath, 'show', `${baseRef}:${scriptPath}`],
        { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
      );
      hashes[scriptPath] = createHash('sha256').update(stdout, 'utf8').digest('hex');
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), scriptPath, baseRef },
        'deploy baseline: could not read script at base ref',
      );
    }
  }

  return hashes;
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

function resolvePrBaseBranch(pod: Pod, profile: Profile): string {
  const fallback = profile.defaultBranch ?? 'main';
  const candidate = pod.baseBranch ?? fallback;
  if (candidate !== pod.branch) return candidate;
  if (fallback !== pod.branch) return fallback;
  return pod.branch === 'main' ? candidate : 'main';
}

function isSinglePrSeriesPod(pod: Pick<Pod, 'prMode' | 'seriesId'>): boolean {
  return pod.prMode === 'single' && Boolean(pod.seriesId);
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
  ): Promise<{ networkName: string; firewallScript: string } | null>;
  getGatewayIp(podId?: string): Promise<string>;
  /** Remove the per-pod bridge — called from pod cleanup. Idempotent. */
  destroyNetworkForPod?(podId: string): Promise<void>;
}

export interface PodManagerDependencies {
  podRepo: PodRepository;
  escalationRepo: EscalationRepository;
  nudgeRepo: NudgeRepository;
  /** Queue of feedback messages drained into the next fix-pod iteration. */
  fixFeedbackRepo: FixFeedbackRepository;
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
  /**
   * Operator-only: clear a stale `activeIds` entry from the queue. Used by
   * `kickPod` to recover from the stuck-queued bug where a previous run's
   * finally never cleaned up, leaving `enqueue` to silently dedup forever.
   * Returns `true` if the entry was cleared.
   */
  clearStuckQueueEntry?: (podId: string) => boolean;
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
  /** On-disk screenshot store. Smoke screenshots are written here after validation. */
  screenshotStore?: import('./screenshot-store.js').ScreenshotStore;
  /** Resolve the host Playwright screenshot directory for a pod. */
  hostScreenshotDir?: (podId: string) => string;
  /** Safety events repository for writing per-pattern detection rows. */
  safetyEventsRepo?: import('../safety/safety-events-repository.js').SafetyEventsRepository;
  logger: Logger;
}

/** Identity of the human who created a pod, used to pre-fill git config inside the container. */
export interface PodCreator {
  email?: string | null;
  name?: string | null;
}

export interface PodManager {
  createSession(request: CreatePodRequest, userId: string, creator?: PodCreator): Pod;
  processPod(podId: string): Promise<void>;
  consumeAgentEvents(
    podId: string,
    events: AsyncIterable<AgentEvent>,
    attempt?: number,
  ): Promise<void>;
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
      /** When true, promote without spawning the agent — go straight to validation/PR
       *  with the human's work as-is. Requires a promotion target (pr/artifact). */
      skipAgent?: boolean;
    },
  ): Promise<{ pushError?: string; promotedTo?: 'pr' | 'branch' | 'artifact' | 'none' }>;
  /**
   * Sync a running interactive workspace's branch to origin without changing
   * pod state — used when the desktop wants to spawn a series from briefs that
   * live in the workspace's worktree. Mirrors the sync+commit+push of
   * `completeSession` but skips worktree cleanup and the `complete` transition,
   * so the user can keep iterating after the handoff. Best-effort: errors are
   * surfaced in the return value rather than thrown so the caller can still
   * fall through to a folder-based brief preview.
   */
  syncWorkspaceBranch(podId: string): Promise<{
    committed: boolean;
    pushed: boolean;
    error?: string;
  }>;
  /** Promote an interactive pod to auto on the same pod ID.
   *  `options.instructions` is the raw human-typed handoff text from the desktop sheet
   *  (or `--instructions` on the CLI); persisted as `handoffInstructions` and consumed
   *  by the recovery restart to compose the agent-facing `## Handoff` section.
   *  `options.skipAgent` skips agent spawn entirely — pod goes straight to validation. */
  promoteToAuto(
    podId: string,
    targetOutput: 'pr' | 'branch' | 'artifact' | 'none',
    options?: { instructions?: string; skipAgent?: boolean },
  ): Promise<void>;
  triggerValidation(podId: string, options?: { force?: boolean }): Promise<void>;
  /** Pull latest from remote branch and re-run validation without agent rework on failure.
   *  Used after human fixes via a linked workspace pod.
   *  Pass `{ force: true }` to skip the no-new-commits early-exit — used by Resume
   *  when the operator suspects validation crashed on infra rather than on real
   *  findings. */
  revalidateSession(
    podId: string,
    options?: { force?: boolean },
  ): Promise<{ newCommits: boolean; result: 'pass' | 'fail' }>;
  /** Create a linked workspace pod on the same branch as a failed worker pod for human fixes. */
  fixManually(podId: string, userId: string, creator?: PodCreator): Pod;
  createHistoryWorkspace(
    profileName: string,
    userId: string,
    historyQuery: HistoryQuery,
    creator?: PodCreator,
  ): Pod;
  createMemoryWorkspace(profileName: string, userId: string, creator?: PodCreator): Pod;
  deleteSession(podId: string): Promise<void>;
  startPreview(podId: string): Promise<{ previewUrl: string }>;
  stopPreview(podId: string): Promise<void>;
  previewStatus(podId: string): Promise<{
    running: boolean;
    reachable: boolean;
    restartCount: number;
    lastError: string | null;
    previewUrl: string | null;
  }>;
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
   * Manually queue a fix-feedback message for a `merge_pending` pod and ask
   * `maybeSpawnFixSession` to spawn/recycle the canonical fix pod. The message
   * is enqueued onto the parent's fix-feedback queue and built into the fix
   * pod's task when it transitions to `running`. Bumps maxPrFixAttempts if the
   * current cap would otherwise block the spawn. Throws 409 for terminal or
   * fix-pod parents.
   */
  spawnFixSession(podId: string, userMessage?: string): Promise<void>;
  /**
   * Queue-driven fix-pod request used by the HTTP API. Enqueues `message` onto
   * the parent's fix-feedback queue and asks `maybeSpawnFixSession` to
   * spawn/recycle the canonical fix pod if needed. Returns the resulting queue
   * state. A terminal parent yields `{ ok: false, reason: 'parent_terminal' }`
   * rather than throwing; a missing parent throws `PodNotFoundError` (404) and
   * a fix pod passed as parent throws `AutopodError` (409).
   */
  requestFixSession(podId: string, message: string): Promise<SpawnFixResponse>;
  /**
   * Rebase an eligible pod branch onto the latest origin/<baseBranch> and restart
   * validation. Eligible statuses: `validating`, `failed`, `review_required`.
   * For `validating` pods, aborts current validation and queues the update intent;
   * the unwind runs the rebase before sending correction feedback.
   * Returns a typed outcome — does not wait for follow-up validation to complete.
   */
  updateFromBase(podId: string): Promise<UpdateFromBaseResponse>;
  /**
   * Retry PR creation for a complete pod whose PR was never successfully created.
   * Updates prUrl on success. Throws if the pod is not complete or already has a PR.
   */
  retryCreatePr(podId: string): Promise<void>;
  /**
   * Operator escape hatch for `failed` pods: advance the pod from where it died
   * without re-running the agent. Picks the cheapest action that fits the pod's
   * state — push + open PR if validation passed, re-validate if validation
   * failed on infra. Throws when the pod isn't in a recoverable state.
   */
  resumePod(podId: string): Promise<{ action: 'retry-pr' | 'revalidate' }>;
  /**
   * Operator admin override: force-transition a `failed` pod to `complete`,
   * skipping push, PR creation, and validation. Persists `forceCompletedAt`
   * + reason on the pod row for audit.
   */
  forceComplete(podId: string, reason?: string): Promise<void>;
  /**
   * Operator escape hatch to unstick a pod. On `queued` pods (e.g. if the queue
   * silently lost track), re-enqueues without state change. On `running` /
   * `provisioning` pods, kills the container best-effort and transitions to
   * `failed` so the slot frees up — the pod is then recoverable via
   * `resume` / `force-complete`. Persists `kickedAt` + reason for audit.
   */
  kickPod(podId: string, reason?: string): Promise<{ action: 'requeued' | 'failed' }>;
  /**
   * Start the global watchdog that detects `running` pods whose agent stream has
   * gone silent for longer than the configured threshold and transitions them to
   * `failed`. Called once from the daemon entrypoint. Idempotent.
   */
  startStuckPodWatchdog(options?: { intervalMs?: number; thresholdMs?: number }): void;
  /** Stop the stuck-pod watchdog (used in tests / shutdown). */
  stopStuckPodWatchdog(): void;
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
  recoverWorktree(podId: string): Promise<{
    recovered: boolean;
    message: string;
    blockers?: Array<{ status: string; path: string }>;
  }>;
}

/**
 * Derive the agent attempt counter from an existing phaseTokenUsage snapshot.
 * Used at the top of processPod() so a recovered/re-queued pod continues its
 * rework sequence instead of resetting to agent_initial.
 *
 * Returns the *next* attempt to write to:
 *   - 0 when no agent buckets are present (fresh or legacy pod)
 *   - 1 + highest rework N present (e.g. {agent_initial, agent_rework_2} → 3)
 */
function deriveAgentAttempt(phaseTokenUsage: PhaseTokenUsage | null): number {
  if (!phaseTokenUsage || !('agent_initial' in phaseTokenUsage)) return 0;
  let highestRework = 0;
  for (const key of Object.keys(phaseTokenUsage)) {
    if (key.startsWith('agent_rework_')) {
      const n = Number.parseInt(key.slice('agent_rework_'.length), 10);
      if (n > highestRework) highestRework = n;
    }
  }
  return 1 + highestRework;
}

function hasLatestPersistedAgentTerminalEventComplete(
  eventRepo: EventRepository | undefined,
  podId: string,
): boolean {
  if (!eventRepo) return false;
  let latestTerminalEvent: 'complete' | 'error' | null = null;
  for (const event of eventRepo.getForSession(podId)) {
    if (event.payload.type !== 'pod.agent_activity') continue;
    const agentEvent = event.payload.event;
    if (agentEvent.type === 'complete') {
      latestTerminalEvent = 'complete';
    } else if (agentEvent.type === 'error' && agentEvent.fatal) {
      latestTerminalEvent = 'error';
    }
  }
  return latestTerminalEvent === 'complete';
}

export function createPodManager(deps: PodManagerDependencies): PodManager {
  const {
    podRepo,
    escalationRepo,
    nudgeRepo,
    fixFeedbackRepo,
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
    clearStuckQueueEntry,
    mcpBaseUrl,
    daemonConfig,
    logger,
    validationRepo,
    progressEventRepo,
    repoScanner,
    scanRepo,
    screenshotStore,
    hostScreenshotDir,
    safetyEventsRepo,
  } = deps;

  /**
   * Sequential merge queue keyed by `repo+baseBranch`.
   *
   * The "rebase HEAD onto origin/<base> → push → merge" critical section runs
   * inside this queue so two pods targeting the same base never race: pod B's
   * rebase always happens against the branch pod A just pushed, eliminating the
   * "both rebases looked clean, B's became stale before push" failure mode.
   *
   * Different repos and different base branches don't conflict, so we key on
   * both — concurrency stays high in the common case where pods target different
   * targets.
   */
  const mergeQueue = new MergeQueue();

  /** Per-pod HAProxy denial log receivers. Started after container spawn in
   *  restricted mode; stopped from `cleanupContainer`. Map is the source of
   *  truth — any cleanup path that goes through `cleanupContainer` reaps the
   *  handle. */
  const haproxyDenyHandles = new Map<string, HaproxyDenyStreamHandle>();

  /** Best-effort: start the HAProxy deny log receiver for a restricted-mode
   *  pod and wire each denied SNI to a `pod.firewall_denied` event. Failures
   *  here must not block the pod — denial visibility is informational. */
  async function startHaproxyDenyReceiver(pod: Pod, containerId: string): Promise<void> {
    const cm = containerManagerFactory.get(pod.executionTarget);
    try {
      const handle = await streamHaproxyDenials(
        cm,
        containerId,
        ({ sni, src }) => {
          eventBus.emit({
            type: 'pod.firewall_denied',
            timestamp: new Date().toISOString(),
            podId: pod.id,
            sni,
            src,
          });
        },
        logger,
      );
      haproxyDenyHandles.set(pod.id, handle);
    } catch (err) {
      logger.warn(
        { err, podId: pod.id, containerId },
        'Failed to start HAProxy deny receiver — pod runs without denial visibility',
      );
    }
  }

  /** Stop the deny receiver for a pod, if one is registered. Idempotent. */
  async function stopHaproxyDenyReceiver(podId: string): Promise<void> {
    const handle = haproxyDenyHandles.get(podId);
    if (!handle) return;
    haproxyDenyHandles.delete(podId);
    try {
      await handle.stop();
    } catch (err) {
      logger.warn({ err, podId }, 'Failed to stop HAProxy deny receiver');
    }
  }

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

  /** Hard ceiling on container cleanup at terminal transitions. A wedged Docker
   *  daemon must never keep an operator endpoint hanging — once the pod is
   *  conceptually done, we proceed even if Docker is still chewing on the API
   *  call. 15s is generous for a cooperative `stop -t 10` + remove. */
  const CONTAINER_CLEANUP_TIMEOUT_MS = 15_000;

  /**
   * Best-effort container cleanup with a hard timeout. Use at terminal
   * transitions (complete, force-complete) and operator escape hatches (kick)
   * so a wedged Docker engine can't tie up the request. Never throws — the
   * caller has already decided the pod is done.
   *
   * mode='kill' stops + removes (terminal — pod will never restart).
   * mode='stop' only stops, leaving the container so it can be restarted later
   * (preview, rejection retry, resume).
   */
  async function cleanupContainer(
    pod: Pod,
    label: string,
    mode: 'kill' | 'stop' = 'kill',
  ): Promise<void> {
    if (!pod.containerId) return;
    // Stop denial receiver before killing/stopping the container so the
    // long-running socat exec gets a clean shutdown signal.
    await stopHaproxyDenyReceiver(pod.id);
    const cm = containerManagerFactory.get(pod.executionTarget);
    const op = mode === 'kill' ? cm.kill(pod.containerId) : cm.stop(pod.containerId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      op
        .catch((err) =>
          logger.warn({ err, podId: pod.id, label, mode }, `${label}: container ${mode} failed`),
        )
        .finally(() => {
          if (timer) clearTimeout(timer);
        }),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          logger.warn(
            { podId: pod.id, label, mode, timeoutMs: CONTAINER_CLEANUP_TIMEOUT_MS },
            `${label}: container ${mode} timed out — proceeding without waiting`,
          );
          resolve();
        }, CONTAINER_CLEANUP_TIMEOUT_MS);
      }),
    ]);
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

  const DEFAULT_MERGE_POLL_INTERVAL_MS = 60_000;

  /** Active AbortControllers for in-progress validation runs, keyed by podId. */
  const validationAbortControllers = new Map<string, AbortController>();

  /** Pods whose operator triggered update-from-base while they were validating.
   *  Consumed by the validation unwind to run the rebase instead of retrying the agent. */
  const pendingUpdateFromBaseIntents = new Set<string>();

  /** Pods whose branch was cleanly rebased by update-from-base.
   *  The next pushBranch call for these pods may use --force-with-lease; cleared after one use. */
  const forceWithLeaseAllowances = new Set<string>();

  /**
   * Per-pod throttle for `last_agent_event_at` DB writes. Bumped on any liveness
   * signal — agent stream events AND system status emissions during bootstrap
   * or recovery — but persisted at most once per `EVENT_TIMESTAMP_WRITE_THROTTLE_MS`
   * to avoid hammering SQLite. The watchdog threshold is in the tens of minutes
   * so 10 s granularity is fine.
   */
  const lastEventWriteAt = new Map<string, number>();
  const EVENT_TIMESTAMP_WRITE_THROTTLE_MS = 10_000;

  /**
   * Throttled write of `last_agent_event_at`. Called from both the agent stream
   * loop and `emitActivityStatus` so that bootstrap/recovery progress messages
   * count as liveness — without this, the watchdog only sees the agent SSE
   * stream and kills pods that are still mid-provisioning.
   */
  function bumpActivityTimestamp(podId: string): void {
    const eventNow = Date.now();
    const lastWrite = lastEventWriteAt.get(podId) ?? 0;
    if (eventNow - lastWrite < EVENT_TIMESTAMP_WRITE_THROTTLE_MS) return;
    lastEventWriteAt.set(podId, eventNow);
    try {
      podRepo.update(podId, { lastAgentEventAt: new Date(eventNow).toISOString() });
    } catch (err) {
      logger.warn({ err, podId }, 'Failed to bump lastAgentEventAt');
    }
  }

  /** Stuck-running watchdog interval handle (single global timer). */
  let stuckPodWatchdog: ReturnType<typeof setInterval> | null = null;
  /** Unsubscribe fn for the host.resumed wake-recovery listener. */
  let unsubscribeWakeRecovery: (() => void) | null = null;

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
   * A pod whose fix cycle is over: `complete`, `killed`, or `failed`. The
   * global `isTerminalState` excludes `failed` (failed pods are resumable),
   * but for fix-pod purposes a `failed` parent has no live merge poller to
   * drive a fix into, and a `failed` fix pod is just as recyclable as a
   * completed one. This is the single notion both cases share.
   */
  const isFixCycleTerminal = (status: PodStatus): boolean =>
    isTerminalState(status) || status === 'failed';

  /**
   * A fix pod is recyclable when it has nothing left in flight to drive a new
   * iteration into. Beyond the terminal states, `merge_pending` counts too:
   * the fix pod pushed its fix, but the PR is still failing (otherwise the
   * parent's poller would not be calling us). The pushed fix didn't work, so
   * the row is fair game to recycle for another attempt with fresh feedback.
   */
  const isFixPodRecyclable = (status: PodStatus): boolean =>
    isFixCycleTerminal(status) || status === 'merge_pending';

  /**
   * Ensures the canonical fix pod for a parent PR is alive and queued.
   *
   * Queue-driven: callers MUST `fixFeedbackRepo.enqueue(parentId, message)`
   * before calling this. The queued feedback is drained into the fix pod's
   * task at the moment it transitions to `running` (see `processPod`), so this
   * function never builds the task itself — it only decides whether to
   * spawn/recycle a fix pod, or no-op because one is already alive (the
   * running iteration recycles on completion and drains the queue then).
   *
   * One `pods` row per parent PR: a terminal fix pod is recycled via the legal
   * `complete|failed|killed → queued` transition rather than spawning a new
   * child. Lifted to outer scope so both the merge poller and `spawnFixSession`
   * can call it.
   */
  const maybeSpawnFixSession = async (
    parentSessionId: string,
    _status: PrMergeStatus,
  ): Promise<void> => {
    // Re-read from DB to avoid stale closure state across 60s intervals
    const parent = podRepo.getOrThrow(parentSessionId);

    // Guard: fix pods must never spawn sub-fixers.
    // The root parent's merge poller owns all fix-spawn decisions.
    if (parent.linkedPodId) {
      logger.debug({ podId: parentSessionId }, 'Fix pod — skipping sub-fixer spawn');
      return;
    }

    // Guard: parent already terminal — nothing to fix. The API surfaces
    // `parent_terminal` to the user; the poller simply has nothing to do.
    if (isFixCycleTerminal(parent.status)) {
      logger.debug(
        { podId: parentSessionId, status: parent.status },
        'Parent pod terminal — skipping fix-pod spawn',
      );
      return;
    }

    // Guard: a fix pod is already alive AND making progress. The queue already
    // holds the new message; the running iteration drains it on
    // completion-and-recycle. A fix pod in `merge_pending` is the exception:
    // its pushed fix didn't unblock the PR, so we treat it as recyclable
    // (see `isFixPodRecyclable`) rather than waiting indefinitely for a state
    // change that won't come on its own.
    let recycleCandidate: Pod | null = null;
    if (parent.fixPodId) {
      try {
        const fix = podRepo.getOrThrow(parent.fixPodId);
        if (!isFixPodRecyclable(fix.status)) {
          logger.debug(
            { podId: parentSessionId, fixPodId: parent.fixPodId },
            'Fix pod already active — message queued for next iteration',
          );
          return;
        }
        recycleCandidate = fix;
      } catch {
        // Fix pod row gone — treat as no live fix pod, fall through to spawn.
      }
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
        'Fix-pod spawn: max fix attempts exhausted — pod failed',
      );
      return;
    }

    const profile = profileStore.get(parent.profileName);
    const newAttempt = (parent.prFixAttempts ?? 0) + 1;

    // In a single-PR series, all pods share the root's branch but only the
    // PR-owning pod has prUrl set. The triggering pod's `branch` field can
    // diverge from the PR's actual source branch, so resolve the PR owner
    // and take branch/baseBranch/prUrl from it. Other prModes own their own
    // PR per pod, so the parent's fields are correct.
    const branchSource = resolveBranchSource(parent);

    // Recycle the terminal fix pod via the legal `complete|failed|killed →
    // queued` transition rather than creating a new child — keeps the "one fix
    // pod per PR" invariant the UI shows. The task is intentionally NOT set
    // here: it is built from the drained queue when the pod starts (see
    // `processPod`), so it picks up every message queued between now and start.
    if (recycleCandidate) {
      const fixPodId = recycleCandidate.id;
      const newIteration = (recycleCandidate.fixIteration ?? 0) + 1;

      // Terminal-state fix pods already had their merge poller stopped and
      // container reaped on the way in. A `merge_pending` fix pod, by contrast,
      // still has a live poller (60s interval) and may have left a container
      // behind — clean both up before flipping the row back to `queued` so the
      // poller's next tick doesn't observe the transition mid-flight.
      if (recycleCandidate.status === 'merge_pending') {
        stopMergePolling(fixPodId);
        await cleanupContainer(recycleCandidate, 'fix-pod-recycle');
      }

      transition(recycleCandidate, 'queued', {
        containerId: null,
        worktreePath: null,
        validationAttempts: 0,
        lastValidationResult: null,
        lastCorrectionMessage: null,
        pendingEscalation: null,
        escalationCount: 0,
        startedAt: null,
        completedAt: null,
        claudeSessionId: null,
        preSubmitReview: null,
        // report_task_summary is locked-on-first-write in pod-bridge-impl,
        // so the recycled fix pod must drop the prior round's summary to let
        // the new run record its own.
        taskSummary: null,
        fixIteration: newIteration,
        branch: branchSource.branch,
        baseBranch: branchSource.baseBranch ?? null,
        prUrl: branchSource.prUrl ?? null,
      });

      podRepo.update(parentSessionId, {
        prFixAttempts: newAttempt,
        mergeBlockReason: `Fix attempt ${newAttempt}/${maxAttempts} in progress (pod ${fixPodId})`,
      });

      enqueueSession(fixPodId);
      emitActivityStatus(
        parentSessionId,
        `Re-enqueued fix pod ${fixPodId} (iteration ${newIteration}, attempt ${newAttempt}/${maxAttempts})`,
      );
      logger.info(
        { podId: parentSessionId, fixPodId, iteration: newIteration, attempt: newAttempt },
        'Fix-pod spawn: recycled fix pod for new failures',
      );
      return;
    }

    // No fix pod row yet — create the canonical one for this parent PR. The
    // task is a placeholder; the real task is built from the drained queue
    // when the pod starts.
    const placeholderTask = '[PR FIX] Awaiting queued feedback.';
    let fixId = '';
    for (let attempt = 0; attempt < 10; attempt++) {
      fixId = generatePodId();
      try {
        podRepo.insert({
          id: fixId,
          profileName: parent.profileName,
          task: placeholderTask,
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
        task: placeholderTask,
        status: 'queued',
        model: parent.model,
        runtime: parent.runtime,
        duration: null,
        filesChanged: 0,
        createdAt: new Date().toISOString(),
      },
    });

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
      'Fix-pod spawn: spawned fix pod for actionable failures',
    );
  };

  /**
   * Completes a fix pod once its work has validated.
   *
   * A fix pod does NOT own the PR — its parent does, and the parent sits in
   * `merge_pending` with a poller that owns the actual `prManager.mergePr`
   * call. So the fix pod's job ends at "push the rebased branch to origin":
   * it rebases onto the latest base inside the merge queue, force-pushes, and
   * walks itself to `complete`. The parent's next poll picks up the freshly
   * pushed commits and re-attempts the merge.
   *
   * Never calls `prManager.mergePr` — that would race the parent's poller.
   */
  async function completeFixPodAfterPush(fixPod: Pod): Promise<void> {
    const podId = fixPod.id;
    const profile = profileStore.get(fixPod.profileName);
    const baseBranch = fixPod.baseBranch ?? profile.defaultBranch ?? 'main';
    const branch = fixPod.branch ?? '';
    const worktreePath = fixPod.worktreePath;

    if (worktreePath && branch) {
      try {
        await mergeQueue.enqueueMerge(profile.repoUrl ?? null, baseBranch, async () => {
          emitActivityStatus(podId, `Rebasing onto origin/${baseBranch}…`);
          const rebaseResult = await worktreeManager.rebaseOntoBase({
            worktreePath,
            baseBranch,
            pat: selectGitPat(profile),
          });

          if (!rebaseResult.rebased) {
            // Conflicts — leave the branch as-is and let the parent's poller
            // surface the conflict via the PR merge gate. The fix pod still
            // completes; a follow-up fix round resolves it.
            logger.info(
              { podId, baseBranch, conflicts: rebaseResult.conflicts },
              'Fix-pod post-validation rebase produced conflicts — completing without force-push',
            );
            emitActivityStatus(
              podId,
              formatRebaseConflictReason(baseBranch, rebaseResult.conflicts),
            );
            return;
          }

          if (!rebaseResult.alreadyUpToDate) {
            await worktreeManager.pushBranch(worktreePath, branch, {
              force: true,
              pat: selectGitPat(profile),
            });
            emitActivityStatus(podId, 'Rebased fix branch pushed');
          } else {
            await worktreeManager.pushBranch(worktreePath, branch, {
              pat: selectGitPat(profile),
            });
            emitActivityStatus(podId, 'Fix branch pushed');
          }
        });
      } catch (err) {
        logger.warn({ err, podId }, 'Fix-pod post-validation push failed — completing anyway');
        emitActivityStatus(podId, 'Fix branch push failed — pod still completing');
      }
    }

    emitActivityStatus(podId, 'Fix pod complete — parent poller owns the merge');
    await cleanupContainer(fixPod, 'fix-pod-pushed');
    const approved = transition(fixPod, 'approved');
    const merging = transition(approved, 'merging');
    const completed = transition(merging, 'complete', {
      completedAt: new Date().toISOString(),
    });

    eventBus.emit({
      type: 'pod.completed',
      timestamp: new Date().toISOString(),
      podId,
      finalStatus: 'complete',
      summary: {
        id: podId,
        profileName: completed.profileName,
        task: completed.task,
        status: 'complete',
        model: completed.model,
        runtime: completed.runtime,
        duration: completed.startedAt ? Date.now() - new Date(completed.startedAt).getTime() : null,
        filesChanged: completed.filesChanged,
        createdAt: completed.createdAt,
      },
    });

    logger.info(
      { podId, parentId: fixPod.linkedPodId },
      'Fix pod completed after push — parent merge poller will re-attempt merge',
    );
  }

  /**
   * Performs the rebase-and-revalidate flow for a pod whose update-from-base
   * intent was consumed during validation unwind. Pod must be in `validating`
   * state; this function handles all status transitions.
   * `startFollowUpValidation` is called (fire-and-forget) when the rebase is clean.
   */
  async function runUpdateFromBaseAfterAbort(
    podId: string,
    startFollowUpValidation: () => void,
  ): Promise<void> {
    const pod = podRepo.getOrThrow(podId);
    if (!pod.worktreePath) {
      transition(pod, 'failed');
      return;
    }
    const profile = profileStore.get(pod.profileName);
    const baseBranch = pod.baseBranch ?? profile.defaultBranch ?? 'main';

    emitActivityStatus(podId, `Update from base: rebasing onto '${baseBranch}'…`);

    const rebaseResult = await worktreeManager.rebaseOntoBase({
      worktreePath: pod.worktreePath,
      baseBranch,
      pat: selectGitPat(profile),
    });

    const freshPod = podRepo.getOrThrow(podId);

    if (rebaseResult.alreadyUpToDate) {
      emitActivityStatus(podId, `Branch already up to date with '${baseBranch}'`);
      transition(freshPod, 'failed');
      return;
    }

    if (!rebaseResult.rebased) {
      emitActivityStatus(
        podId,
        `Rebase conflict with '${baseBranch}': ${rebaseResult.conflicts.join(', ')}`,
      );
      transition(freshPod, 'review_required');
      return;
    }

    emitActivityStatus(podId, `Rebased onto '${baseBranch}' — restarting validation…`);
    forceWithLeaseAllowances.add(podId);
    transition(freshPod, 'failed');
    podRepo.update(podId, { validationAttempts: 0 });
    startFollowUpValidation();
  }

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
          await cleanupContainer(pod, 'pr-merged-complete');
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

        // Actionable failures → enqueue a sanitized summary, then ensure the
        // canonical fix pod is alive to drain it. The queue carries the
        // content so the drain at fix-pod start can build the task from a
        // minimal status (see processPod).
        //
        // Idempotency: a stuck PR re-emits the same failure signature on every
        // 60s tick. Without this guard the queue grows unboundedly (~one row
        // per minute) until the fix pod finally recycles — we've seen it hit
        // 391 rows across ~46h. Skip the enqueue when the latest queued summary
        // is byte-identical to the one we'd add. A new failure signature still
        // gets through.
        if (status.ciFailures.length > 0 || status.reviewComments.length > 0) {
          const summary = buildActionableFailureSummary(status, profile);
          const latest = fixFeedbackRepo.peekLatest(podId);
          if (latest?.message !== summary) {
            fixFeedbackRepo.enqueue(podId, summary);
          }
          await maybeSpawnFixSession(podId, status);
        } else {
          // PR is clean — actively re-attempt the merge so the poller is not
          // purely observational. The `status.merged` branch above handles the
          // transition to `complete` on a subsequent tick once the merge lands.
          const reviewOk = !status.reviewDecision || status.reviewDecision === 'APPROVED';
          if (reviewOk && pod.worktreePath && pod.prUrl) {
            const baseBranch = pod.baseBranch ?? profile.defaultBranch ?? 'main';
            const worktreePath = pod.worktreePath;
            const prUrl = pod.prUrl;
            try {
              await mergeQueue.enqueueMerge(profile.repoUrl ?? null, baseBranch, async () => {
                const result = await prManager.mergePr({ worktreePath, prUrl });
                if (result.merged) emitActivityStatus(podId, 'PR merged by poller');
              });
            } catch (err) {
              logger.debug({ err, podId }, 'Merge poller active merge attempt failed');
            }
          }
        }

        // Self-heal stale branch: if a sibling pod merged while we were waiting
        // for review/CI, our branch is now behind origin/<base> and the platform
        // auto-merge will park indefinitely. Rebase + force-push so the existing
        // auto-merge can pick up the rebased branch on its next attempt.
        // `rebaseOntoBase` short-circuits to alreadyUpToDate=true when the base
        // hasn't advanced, so this is a single fetch in the steady state.
        // Serialized with approveSession via the merge queue so two pods on the
        // same base never race.
        if (pod.worktreePath && pod.branch) {
          try {
            const baseBranch = pod.baseBranch ?? profile.defaultBranch ?? 'main';
            const queueKey = MergeQueue.keyFor(profile.repoUrl ?? null, baseBranch);
            const worktreePath = pod.worktreePath;
            const branch = pod.branch;
            await mergeQueue.run(queueKey, async () => {
              const result = await worktreeManager.rebaseOntoBase({
                worktreePath,
                baseBranch,
                pat: selectGitPat(profile),
              });
              if (!result.rebased) {
                const blockReason = formatRebaseConflictReason(baseBranch, result.conflicts);
                if (blockReason !== pod.mergeBlockReason) {
                  podRepo.update(podId, { mergeBlockReason: blockReason });
                  emitActivityStatus(podId, `Merge pending: ${blockReason}`);
                  logger.info(
                    { podId, baseBranch, conflicts: result.conflicts },
                    'Merge poller: rebase produced conflicts — manual resolution required',
                  );
                }
                return;
              }
              if (!result.alreadyUpToDate) {
                await worktreeManager.pushBranch(worktreePath, branch, {
                  force: true,
                  pat: selectGitPat(profile),
                });
                logger.info(
                  { podId, baseBranch },
                  'Merge poller: rebased stale branch and force-pushed onto latest base',
                );
              }
            });
          } catch (err) {
            logger.warn({ err, podId }, 'Merge poller self-heal rebase/push failed');
            emitActivityStatus(
              podId,
              `Self-heal rebase failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      } catch (err) {
        logger.debug({ err, podId }, 'Merge polling failed, skipping cycle');
      }
    };

    // Resolve per-profile poll interval once. Falls back to the default when
    // unset; clamped at 5s by the validator so this is safe to use directly.
    let pollIntervalMs = DEFAULT_MERGE_POLL_INTERVAL_MS;
    try {
      const pod = podRepo.getOrThrow(podId);
      const profile = profileStore.get(pod.profileName);
      if (profile.mergePollIntervalSec) {
        pollIntervalMs = profile.mergePollIntervalSec * 1_000;
      }
    } catch {
      // Pod or profile gone — let poll() decide what to do on its first tick.
    }

    // Run first poll immediately
    poll();
    const interval = setInterval(poll, pollIntervalMs);
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
   * True when an error looks like a Docker engine stall — the kind that
   * resolves itself once the Docker Desktop VM finishes resuming after the
   * host's laptop sleep. We retry on these. Domain errors (e.g. `rm: cannot
   * remove`, non-zero git exit) bubble out unretried.
   */
  function looksLikeEngineStall(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const msg = `${err.message}`.toLowerCase();
    return (
      msg.includes('econnrefused') ||
      msg.includes('econnreset') ||
      msg.includes('epipe') ||
      msg.includes('etimedout') ||
      msg.includes('socket hang up') ||
      msg.includes('connect enoent') || // unix socket missing while VM is paused
      msg.includes('eai_again') ||
      // Dockerode rethrows engine 5xx as plain Error with these substrings.
      msg.includes('server error') ||
      msg.includes('502 bad gateway')
    );
  }

  /**
   * Poll `cm.getStatus(containerId)` until the engine reports `running`, the
   * container is definitively `stopped`, or the budget runs out. Returns
   * `'ready'` when the container is back, `'gone'` if the engine is reachable
   * but the container is gone, `'timeout'` if the budget expired before either
   * outcome. Never throws — engine-unreachable errors are treated as "still
   * stalled, keep polling."
   */
  async function waitForContainerReachable(
    containerId: string,
    cm: ContainerManager,
    maxWaitMs: number,
  ): Promise<'ready' | 'gone' | 'timeout'> {
    const start = Date.now();
    const probeIntervalMs = 2_000;
    while (Date.now() - start < maxWaitMs) {
      try {
        const status = await cm.getStatus(containerId);
        if (status === 'running') return 'ready';
        if (status === 'stopped') return 'gone';
        // 'unknown' → keep polling, engine may still be coming back.
      } catch {
        // Engine still unreachable — that's exactly the case we wait through.
      }
      await new Promise((resolve) => setTimeout(resolve, probeIntervalMs));
    }
    return 'timeout';
  }

  /**
   * Run a sync-back operation, retrying past Docker-engine stalls. Each retry
   * waits for the engine + container to come back before re-issuing the op,
   * up to a hard cap so a wedged engine can't hang the pod cleanup forever.
   *
   * Why retry: laptop sleep → Docker Desktop pauses → in-flight `cm.exec` /
   * `getArchive` calls fail with transient socket errors. Without retry, the
   * one-shot sync command leaves the host worktree partially populated (the
   * `find … rm` half ran, `cp -a` got killed) → next auto-commit trips the
   * deletion guard → operator sees "Worktree out of sync with container."
   * The whole sync is idempotent (rm is no-op on missing, cp re-copies, git
   * push is fast-forward or no-op), so re-running on the same container is
   * safe.
   */
  async function withEngineStallRetry<T>(
    containerId: string,
    cm: ContainerManager,
    op: () => Promise<T>,
    label: string,
  ): Promise<T> {
    const backoffsMs = [5_000, 15_000];
    let lastErr: unknown;
    for (let attempt = 0; attempt <= backoffsMs.length; attempt++) {
      if (attempt > 0) {
        const waitBudget = backoffsMs[attempt - 1] ?? 15_000;
        logger.warn(
          { containerId, attempt, waitBudget, label },
          'Engine stall detected — waiting for container to come back before retry',
        );
        const result = await waitForContainerReachable(containerId, cm, waitBudget);
        if (result === 'gone') {
          // Container is definitively stopped — no point retrying the op.
          throw lastErr ?? new Error(`${label}: container stopped during retry wait`);
        }
        // 'ready' or 'timeout' → either way we try the op once more; if the
        // engine is still wedged, the next throw will end the loop.
      }
      try {
        return await op();
      } catch (err) {
        if (!looksLikeEngineStall(err)) {
          // Domain error — rethrow without retry so callers handle it.
          throw err;
        }
        lastErr = err;
      }
    }
    throw lastErr ?? new Error(`${label}: retries exhausted`);
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
   *  3. Sync files back excluding git/dependency/tooling caches — the host worktree's
   *     gitlink is preserved and platform-native dependency trees stay on their own OS.
   *
   * If the container is already stopped, falls back to Docker's archive API. In that case
   * we extract /workspace (minus .git) then extract /workspace/.git separately and push
   * from the host side.
   *
   * The whole flow is wrapped in `withEngineStallRetry` so a Docker Desktop
   * VM pause (typically: laptop sleep) won't leave the host worktree
   * partially populated — see that helper for the rationale.
   */
  async function syncWorkspaceBack(
    containerId: string,
    worktreePath: string,
    cm: ContainerManager,
    podId: string,
  ): Promise<{ pushed: boolean }> {
    return withEngineStallRetry(
      containerId,
      cm,
      () => syncWorkspaceBackOnce(containerId, worktreePath, cm, podId),
      'syncWorkspaceBack',
    );
  }

  async function syncWorkspaceBackOnce(
    containerId: string,
    worktreePath: string,
    cm: ContainerManager,
    podId: string,
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
          // Push via per-pod staging ref then promote — a direct push to refs/heads/<branch>
          // is refused by the bare's `receive.denyCurrentBranch` because the host worktree
          // (a linked worktree of the bare) has that branch checked out.
          const result = await pushCommitsToBareViaStagingRef(
            async (args) => {
              const r = await cm.execInContainer(
                containerId,
                ['git', '-C', '/workspace', ...args],
                { timeout: 30_000 },
              );
              return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
            },
            bareRepoPath,
            podId,
          );
          if (result.pushed) {
            pushed = true;
          } else {
            // Surface as pushed=false rather than throwing. The caller uses pushed=false
            // to clamp auto-commit's deletion guard so a partially-synced worktree can't
            // get swept into a single bogus chore commit via `git add -A`.
            logger.warn(
              { worktreePath, reason: result.reason },
              'Git push to bare during sync-back failed — agent commits not on host branch',
            );
          }
        }
      }

      // Sync files back, excluding git/dependency/tooling caches. The caches are ignored
      // runtime state and can contain platform-native binaries; mirroring them between a
      // Linux container and a macOS host makes host-side browser facts load the wrong binary.
      //
      // Important: never clear the host worktree before the replacement is complete.
      // Docker Desktop / VirtioFS stalls can kill an exec halfway through. The old
      // clear-then-copy sequence left the host tree partially empty, which `git add -A`
      // interpreted as thousands of deletions. This is copy-first/delete-after:
      //  1. Copy /workspace into a staging dir inside the bind mount.
      //  2. Copy the staged content over the host worktree.
      //  3. Delete host paths that are absent from the complete staged copy.
      const syncStagingPrefix = `.autopod-sync-${podId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
      const syncScript = [
        'set -eu',
        "find /mnt/worktree -mindepth 1 -maxdepth 1 \\( -name '.autopod-sync-*' -o -name '.autopod-extract-*' \\) -exec rm -rf {} +",
        `STAGING="/mnt/worktree/${syncStagingPrefix}-$$"`,
        'STAGING_BASE=$(basename "$STAGING")',
        'trap \'rm -rf "$STAGING"\' EXIT INT TERM',
        'rm -rf "$STAGING"',
        'mkdir -p "$STAGING"',
        `workspace_count=$(cd /workspace && find . -mindepth 1 ${workspaceMirrorPruneExpression(
          WORKSPACE_SYNC_EXCLUDES,
        )} -print | wc -l | tr -d " ")`,
        buildWorkspaceMirrorCopyScript('/workspace', '"$STAGING"', WORKSPACE_SYNC_EXCLUDES),
        'staging_count=$(find "$STAGING" -mindepth 1 | wc -l | tr -d " ")',
        'test "$workspace_count" = "$staging_count"',
        'cp -a "$STAGING/." /mnt/worktree/',
        'cd /mnt/worktree',
        [
          'find . -mindepth 1 -depth',
          ...workspaceMirrorPreservePredicates(WORKSPACE_SYNC_EXCLUDES),
          '! -path "./$STAGING_BASE"',
          '! -path "./$STAGING_BASE/*"',
          '-exec sh -c \'staging=$1; shift; for p do rel=${p#./}; if [ ! -e "$staging/$rel" ] && [ ! -L "$staging/$rel" ]; then rm -rf -- "$p"; fi; done\' sh "$STAGING" {} +',
        ].join(' '),
        'rm -rf "$STAGING"',
      ].join('; ');
      const syncResult = await cm.execInContainer(containerId, ['sh', '-c', syncScript], {
        timeout: 120_000,
      });
      if (syncResult.exitCode !== 0) {
        throw new Error(
          `Workspace sync-back command failed (exit ${syncResult.exitCode}): ${syncResult.stderr.trim() || syncResult.stdout.trim()}`,
        );
      }
      if (pushed) {
        await refreshHostWorktreeIndex(worktreePath, podId);
      }
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
      await cm.extractDirectoryFromContainer(
        containerId,
        '/workspace',
        worktreePath,
        WORKSPACE_SYNC_EXCLUDES,
      );

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
          const result = await pushCommitsToBareViaStagingRef(
            async (args) => {
              try {
                const r = await execFileAsync('git', ['--git-dir', tmpGitDir, ...args]);
                return { stdout: r.stdout, stderr: r.stderr, exitCode: 0 };
              } catch (err) {
                const e = err as { stdout?: string; stderr?: string; code?: number };
                return {
                  stdout: e.stdout ?? '',
                  stderr: e.stderr ?? (err as Error).message,
                  exitCode: typeof e.code === 'number' ? e.code : 1,
                };
              }
            },
            bareRepoPath,
            podId,
          );
          if (result.pushed) {
            pushed = true;
          } else {
            logger.warn(
              { worktreePath, reason: result.reason },
              'Could not push commits from container during sync fallback — new commits may be lost',
            );
          }
        } catch (gitRecoveryErr) {
          logger.warn(
            { err: gitRecoveryErr, worktreePath },
            'Could not push commits from container during sync fallback — new commits may be lost',
          );
        } finally {
          await rm(tmpGitDir, { recursive: true, force: true }).catch(() => {});
        }
      }
      if (pushed) {
        await refreshHostWorktreeIndex(worktreePath, podId);
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
    podId: string,
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
          const result = await pushCommitsToBareViaStagingRef(
            async (args) => {
              const r = await cm.execInContainer(
                containerId,
                ['git', '-C', '/workspace', ...args],
                { timeout: 30_000 },
              );
              return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
            },
            containerBareRepoPath,
            podId,
          );
          if (!result.pushed) {
            logger.warn(
              { worktreePath, reason: result.reason },
              'Git push during worktree recovery failed — commits may not be fully visible on host',
            );
          }
        }
      }

      await cm.extractDirectoryFromContainer(
        containerId,
        '/workspace',
        worktreePath,
        WORKSPACE_SYNC_EXCLUDES,
      );
      await refreshHostWorktreeIndex(worktreePath, podId);
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
    // Status emissions are also liveness signals — bootstrap/recovery progress
    // would otherwise be invisible to the watchdog and trigger a false auto-fail
    // before the agent process has even spawned.
    bumpActivityTimestamp(podId);
  }

  function describeSyncFailure(err: unknown): string {
    if (err instanceof Error && err.message.trim()) {
      return `${err.name}: ${err.message}`;
    }
    return String(err);
  }

  async function tryRecoverAfterWorkspaceSyncFailure(
    pod: Pod,
    err: unknown,
    phase: 'auto-commit' | 'validation',
  ): Promise<boolean> {
    if (!pod.containerId || !pod.worktreePath) return false;

    const detail = describeSyncFailure(err);
    logger.warn(
      { err, podId: pod.id, phase },
      'Workspace sync failed - attempting live container recovery',
    );
    emitActivityStatus(
      pod.id,
      `Workspace sync failed before ${phase} (${detail}). Attempting live container recovery...`,
    );

    const cm = containerManagerFactory.get(pod.executionTarget);
    const recovered = await recoverWorktreeFromContainer(
      pod.containerId,
      pod.worktreePath,
      cm,
      pod.id,
    );
    if (!recovered) return false;

    podRepo.update(pod.id, { worktreeCompromised: false, preSubmitReview: null });
    emitActivityStatus(
      pod.id,
      `Workspace recovered from live container after sync failure; continuing ${phase}.`,
    );
    logger.info({ podId: pod.id, phase }, 'Recovered worktree after workspace sync failure');
    return true;
  }

  async function refreshHostWorktreeIndex(worktreePath: string, podId: string): Promise<void> {
    try {
      await execFileAsync('git', ['reset', '--mixed', 'HEAD'], { cwd: worktreePath });
      logger.info({ podId, worktreePath }, 'Refreshed host worktree index after sync-back');
    } catch (err) {
      logger.warn(
        { err, podId, worktreePath },
        'Failed to refresh host worktree index after sync-back',
      );
      throw err;
    }
  }

  function protectedOperationalPathReason(pathname: string): string | null {
    if (
      pathname === '.mcp.json' ||
      pathname.startsWith('.husky/') ||
      pathname.startsWith('.githooks/') ||
      pathname.startsWith('.git/hooks/') ||
      pathname.startsWith('.claude/') ||
      pathname.startsWith('.codex/')
    ) {
      return 'agent/runtime operational path';
    }
    return null;
  }

  function podExplicitlyScopesOperationalPaths(pod: Pod): boolean {
    const haystack = [
      pod.task,
      pod.taskSummary?.actualSummary,
      pod.taskSummary?.how,
      ...(pod.touches ?? []),
    ]
      .filter(Boolean)
      .join('\n')
      .toLowerCase();
    return [
      '.husky',
      '.githooks',
      '.git/hooks',
      '.claude',
      '.codex',
      '.mcp.json',
      'pre-commit',
      'commit-msg',
      'git hook',
      'agent config',
      'agent tooling',
      'mcp',
    ].some((needle) => haystack.includes(needle));
  }

  function assertProtectedOperationalPathsInScope(pod: Pod, diff: string): void {
    const changed = parseDiffFilePaths(diff).filter((p) => protectedOperationalPathReason(p));
    if (changed.length === 0 || podExplicitlyScopesOperationalPaths(pod)) return;
    throw new AutopodError(
      `Protected operational files changed without explicit task scope: ${changed.join(', ')}. Revert these hook/agent-config changes or disclose explicit scope for them before validation.`,
      'PROTECTED_OPERATIONAL_PATHS_CHANGED',
      422,
    );
  }

  /** Per-phase WebSocket events that drive the desktop Validation tab chips.
   *  Pass to every `validationEngine.validate()` call — the engine no-ops on
   *  missing callbacks, which silently freezes the UI. */
  function buildPhaseEventCallbacks(podId: string) {
    return {
      onPhaseStarted: (phase: ValidationPhase) => {
        eventBus.emit({
          type: 'pod.validation_phase_started',
          timestamp: new Date().toISOString(),
          podId,
          phase,
        });
      },
      onPhaseCompleted: (
        phase: ValidationPhase,
        status: 'pass' | 'fail' | 'skip',
        phaseResult: unknown,
      ) => {
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
        } else if (phase === 'facts') {
          eventBus.emit({ ...base, factResult: phaseResult as FactValidationResult | null });
        } else if (phase === 'review') {
          eventBus.emit({ ...base, reviewResult: phaseResult as TaskReviewResult | null });
        }
      },
    };
  }

  /**
   * If `err` is a DeletionGuardError, mark the pod as worktree-compromised so the desktop
   * disables Create PR / merge actions until a human reconciles the state. Emits an event
   * plus an activity-status line. Returns true if the error was a guard trip so callers can
   * skip redundant warnings about the same condition.
   */
  /**
   * Park a pod in `awaiting_input` after a daemon-side git push failed on
   * credentials. The operator updates the profile PAT and replies/nudges; the
   * resume handler picks up the escalation, retries the push from
   * `validating`, and continues to PR creation — no agent re-run, no lost
   * validation work. Returns true so the call site can `return` cleanly.
   */
  function parkOnCredentialFailure(podId: string, err: GitCredentialError): true {
    const pod = podRepo.getOrThrow(podId);
    const escalation: EscalationRequest = {
      id: generateId(12),
      podId,
      type: 'request_credential',
      timestamp: new Date().toISOString(),
      payload: {
        service: err.service,
        reason: `git ${err.op} was rejected by ${err.service}. Update the profile's ${err.service === 'github' ? 'githubPat' : 'adoPat'} with a token that has write access to the target repo, then resume the pod.`,
        source: 'host_push',
      },
      response: null,
    };
    escalationRepo.insert(escalation);
    podRepo.update(podId, {
      pendingEscalation: escalation,
      escalationCount: pod.escalationCount + 1,
    });
    transition(pod, 'awaiting_input');
    emitActivityStatus(
      podId,
      `Push blocked — ${err.service} credentials missing or unauthorized. Update PAT and resume.`,
    );
    logger.warn(
      { podId, service: err.service, op: err.op, escalationId: escalation.id },
      'Daemon-side git push parked in awaiting_input on credential failure',
    );
    return true;
  }

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

  function parkOnWorktreeSyncFailure(podId: string, reason: string): void {
    try {
      podRepo.update(podId, { worktreeCompromised: true });
    } catch (updateErr) {
      logger.warn({ err: updateErr, podId }, 'Failed to persist worktreeCompromised flag');
    }
    emitActivityStatus(
      podId,
      `${reason} Recover the worktree before retrying validation or PR creation.`,
    );
    const current = podRepo.getOrThrow(podId);
    if (current.status === 'running' || current.status === 'validating') {
      transition(current, 'failed');
    }
  }

  /**
   * Shared push-then-open-PR flow used by both `retryCreatePr` (post-complete) and
   * `resumePod` (post-failure). Caller is responsible for the status preconditions
   * and any post-success state transition; this helper only does the side effects
   * + returns the new PR URL on success.
   */
  async function pushAndCreatePr(pod: Pod, callerLabel: string): Promise<string> {
    const podId = pod.id;
    if (!pod.worktreePath) {
      throw new AutopodError(
        `Pod ${podId} has no worktree — cannot push branch`,
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

    const baseBranch = resolvePrBaseBranch(pod, profile);
    const pat = selectGitPat(profile);
    try {
      await worktreeManager.mergeBranch({
        worktreePath: pod.worktreePath,
        // Push the feature branch up so PR creation can reference it. Using the
        // feature branch (not baseBranch) avoids force-pushing the work onto main.
        targetBranch: pod.branch,
        pat,
        // Block auto-commit deletions: this helper runs post-container with no
        // fresh sync-back, so any "missing files" almost certainly means a sync
        // ghost rather than the operator wanting to ship a mass-delete.
        maxDeletions: 0,
        podTask: pod.task,
        profile,
        podModel: pod.model,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ podId, err, callerLabel }, 'pushAndCreatePr: branch push failed');
      // Bubble GitCredentialError up untouched so the caller can park the pod
      // in awaiting_input instead of failing terminally on a fixable PAT issue.
      if (err instanceof GitCredentialError) {
        throw err;
      }
      if (handleDeletionGuardError(podId, err)) {
        throw new AutopodError(message, 'WORKTREE_COMPROMISED', 409);
      }
      emitActivityStatus(podId, `Branch push failed: ${message}`);
      throw new AutopodError(message, 'BRANCH_PUSH_FAILED', 502);
    }

    try {
      const result = await prManager.createPr({
        worktreePath: pod.worktreePath,
        repoUrl: profile.repoUrl ?? undefined,
        branch: pod.branch,
        baseBranch,
        podId,
        task: pod.task,
        profileName: pod.profileName,
        profile,
        podModel: pod.model,
        handoffInstructions: pod.handoffInstructions ?? undefined,
        validationResult: pod.lastValidationResult ?? null,
        validationWaiver: pod.validationWaiver,
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
      if (result.usedFallback) {
        const which = result.narrativeUsedFallback
          ? result.titleUsedFallback
            ? 'title + body'
            : 'body'
          : 'title';
        const reason = result.fallbackReason ?? 'unknown';
        logger.error(
          {
            podId,
            callerLabel,
            profile: profile.name,
            modelProvider: profile.modelProvider,
            fallbackReason: reason,
            fallbackDetail: result.fallbackDetail,
            titleUsedFallback: result.titleUsedFallback,
            narrativeUsedFallback: result.narrativeUsedFallback,
          },
          'PR description used template fallback — daemon-side LLM helper failed',
        );
        emitActivityStatus(podId, `PR ${which} used template fallback: ${reason}`);
      }
      return result.url;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ podId, err, callerLabel }, 'pushAndCreatePr: PR creation failed');
      emitActivityStatus(podId, `PR creation failed: ${message}`);
      throw new AutopodError(message, 'PR_CREATION_FAILED', 502);
    }
  }

  function transition(pod: Pod, to: PodStatus, extraUpdates?: Partial<PodUpdates>): Pod {
    validateTransition(pod.id, pod.status, to);
    const previousStatus = pod.status;
    const updates: PodUpdates = { status: to, ...extraUpdates };
    // Successful completion implicitly resolves any prior worktree-compromised
    // warning — the pod finished, branch was pushed, no recovery needed. Don't
    // clear on failed/killed/rejected; those are real bad-state terminals where
    // the banner is still actionable.
    if (to === 'complete' && pod.worktreeCompromised && updates.worktreeCompromised === undefined) {
      updates.worktreeCompromised = false;
    }
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
        if (isSinglePrSeriesPod(dep)) {
          return parent.status === 'complete';
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
      // - Single-PR series, even if an older row has the wrong child branch:
      //   keep pointing at the real base so the final PR targets main/default.
      // - Single-branch (shared branch): same real-base rule.
      // - Stacked with waitForMerge: parent branch is deleted post-merge; use parent's
      //   baseBranch (main) so the dependent starts from the freshly-merged main.
      // - Stacked without waitForMerge: stack directly on parent's branch (classic stacking).
      const firstParentId = parentIds[0];
      const firstParent = firstParentId
        ? firstParentId === completedPod.id
          ? completedPod
          : podRepo.getOrThrow(firstParentId)
        : completedPod;
      const isSharedBranch = dep.branch === firstParent.branch;
      let baseBranch: string;
      if (isSinglePrSeriesPod(dep) || isSharedBranch || dep.waitForMerge) {
        baseBranch = firstParent.baseBranch ?? 'main';
      } else {
        baseBranch = firstParent.branch;
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
    createSession(request: CreatePodRequest, userId: string, creator?: PodCreator): Pod {
      const profile = profileStore.get(request.profileName);
      assertNoExpiredPat(profile);
      const runtime = resolvePodRuntime(profile, request.runtime, logger);
      const model = resolvePodModel(profile, request.model, runtime, logger);
      const executionTarget = request.executionTarget ?? profile.executionTarget ?? 'local';
      const skipValidation = request.skipValidation ?? false;
      const normalizedDependsOnPodIds =
        request.dependsOnPodIds && request.dependsOnPodIds.length > 0
          ? request.dependsOnPodIds
          : request.dependsOnPodId
            ? [request.dependsOnPodId]
            : null;
      const singlePrSeriesParent =
        request.prMode === 'single' && request.seriesId && normalizedDependsOnPodIds?.[0]
          ? podRepo.getOrThrow(normalizedDependsOnPodIds[0])
          : null;
      if (
        singlePrSeriesParent &&
        request.branch !== undefined &&
        request.branch !== singlePrSeriesParent.branch
      ) {
        throw new AutopodError(
          `Single-PR series dependent must use parent branch '${singlePrSeriesParent.branch}' (got '${request.branch}')`,
          'INVALID_CONFIGURATION',
          400,
        );
      }
      const effectiveBaseBranch =
        request.baseBranch ?? singlePrSeriesParent?.baseBranch ?? profile.defaultBranch ?? 'main';

      // Resolve the effective PodOptions once, so both branch derivation and
      // DB insertion use the exact same values.
      const profilePodDefaults =
        profile.pod ?? (profile.outputMode ? podOptionsFromOutputMode(profile.outputMode) : null);
      const resolvedPod = resolvePodOptions(
        {
          ...(profilePodDefaults ?? {}),
          advisoryBrowserQaEnabled:
            profilePodDefaults?.advisoryBrowserQaEnabled ??
            profile.advisoryBrowserQaEnabled ??
            false,
        },
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
      //
      // Auto-attach sidecars that the profile has enabled + trusted (currently
      // just Dagger). Profiles can opt out per child via inheritance — sub-
      // profiles set `sidecars.dagger.enabled:false` or `trustedSource:false`.
      // Auto-attach is unioned with the explicit request so CLI/brief-level
      // opt-in still works for sidecars not auto-attached.
      const autoAttached = getAutoAttachedSidecars(profile);
      const requestedSidecars = request.requireSidecars ?? [];
      const requireSidecars = Array.from(new Set([...autoAttached, ...requestedSidecars]));
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

      // Preflight overlap check: does this pod's `touches` scope overlap with
      // any in-flight pod on the same repo + base? Computed BEFORE insert so
      // the `block` policy refuses cleanly without leaving a half-created row.
      // The `warn` path keeps the result and emits an event after the row
      // exists (so it carries the new pod's ID).
      let preflightConflicts: PreflightConflict[] = [];
      const candidateTouches = request.touches ?? [];
      if (candidateTouches.length > 0) {
        try {
          const candidateRepoUrl = profile.repoUrl ?? null;
          const profileRepoUrls = new Map<string, string | null>();
          const resolveRepoUrl = (profileName: string): string | null => {
            const cached = profileRepoUrls.get(profileName);
            if (cached !== undefined) return cached;
            try {
              const url = profileStore.get(profileName).repoUrl ?? null;
              profileRepoUrls.set(profileName, url);
              return url;
            } catch {
              profileRepoUrls.set(profileName, null);
              return null;
            }
          };
          const candidates = podRepo
            .listNonTerminal()
            .map((p) => ({ pod: p, repoUrl: resolveRepoUrl(p.profileName) }));
          preflightConflicts = findPreflightConflicts(
            {
              touches: candidateTouches,
              repoUrl: candidateRepoUrl,
              baseBranch: effectiveBaseBranch,
            },
            candidates,
          );
        } catch (err) {
          // Best-effort: a failure inside the check itself must not block pod
          // creation, so swallow and treat as "no conflicts found".
          logger.debug({ err }, 'Preflight overlap check failed — treating as no conflicts');
          preflightConflicts = [];
        }

        if (preflightConflicts.length > 0 && profile.preflightConflictPolicy === 'block') {
          const ids = preflightConflicts.map((c) => c.conflictingPodId).join(', ');
          throw new AutopodError(
            `Pod creation blocked by profile.preflightConflictPolicy='block': touches scope overlaps in-flight pods [${ids}]`,
            'PREFLIGHT_CONFLICT',
            409,
          );
        }
      }

      let id: string;
      for (let attempt = 0; attempt < 10; attempt++) {
        id = generatePodId();
        const effectiveOutputMode = outputModeFromPodOptions(resolvedPod);
        let branch: string;
        if (request.branch) {
          branch = request.branch;
        } else if (singlePrSeriesParent) {
          branch = singlePrSeriesParent.branch;
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
            creatorEmail: creator?.email ?? null,
            creatorName: creator?.name ?? null,
            maxValidationAttempts: profile.maxValidationAttempts ?? 3,
            skipValidation,
            contract: request.contract ?? null,
            options: resolvedPod,
            outputMode: effectiveOutputMode,
            baseBranch: effectiveBaseBranch,
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
            dependsOnPodIds: normalizedDependsOnPodIds,
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
          branch: pod.branch,
          baseBranch: pod.baseBranch,
          duration: null,
          filesChanged: pod.filesChanged,
          createdAt: pod.createdAt,
        },
      });

      // Emit the preflight overlap warning (computed before insert above) now
      // that the new pod has an ID. The `block` policy already short-circuited
      // earlier; reaching this point means the policy is `warn` or unset.
      if (preflightConflicts.length > 0) {
        eventBus.emit({
          type: 'pod.preflight_overlap',
          timestamp: new Date().toISOString(),
          podId: id,
          conflicts: preflightConflicts.map((c) => ({
            conflictingPodId: c.conflictingPodId,
            conflictingPodTask: c.conflictingPodTask,
            conflictingPodStatus: c.conflictingPodStatus,
            overlappingGlobs: c.overlappingGlobs,
          })),
        });
        logger.warn(
          {
            podId: id,
            conflictingPodIds: preflightConflicts.map((c) => c.conflictingPodId),
          },
          'Pod created with preflight overlap on in-flight pods — possible merge conflict',
        );
      }

      // Dependent pods must not start until their predecessors reach `validated`;
      // maybeTriggerDependents() will enqueue them at that point. A pod counts
      // as dependent if either the new multi-parent array or the legacy single
      // field is populated.
      const hasDeps = (request.dependsOnPodIds?.length ?? 0) > 0 || !!request.dependsOnPodId;
      if (!hasDeps) {
        enqueueSession(id);
      }
      logger.info(
        { podId: id, profile: request.profileName, branch: pod.branch, baseBranch: pod.baseBranch },
        'Pod created',
      );
      return pod;
    },

    createHistoryWorkspace(
      profileName: string,
      userId: string,
      historyQuery: HistoryQuery,
      creator?: PodCreator,
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
        creator,
      );
    },

    createMemoryWorkspace(profileName: string, userId: string, creator?: PodCreator): Pod {
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
        creator,
      );
    },

    async processPod(podId: string): Promise<void> {
      let pod = podRepo.getOrThrow(podId);
      const startingAttempt = deriveAgentAttempt(pod.phaseTokenUsage);

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

      function emitStatus(message: string): void {
        emitActivityStatus(podId, message);
      }

      try {
        // Fetched inside the try so a missing profile (or broken extends chain) is caught
        // and transitions the pod to 'failed' instead of orphaning it as 'queued' forever —
        // the queue's finally block frees activeIds, and without a status update nothing
        // ever re-enqueues the pod.
        const profile = profileStore.get(pod.profileName);

        // For handoff pods the interactive container is still running — sync the
        // human's work back to the host worktree and stop the container here so
        // the promote HTTP endpoint can return immediately without timing out.
        if (pod.status === 'handoff' && pod.containerId && pod.worktreePath) {
          const cm = containerManagerFactory.get(pod.executionTarget);
          try {
            await syncWorkspaceBack(pod.containerId, pod.worktreePath, cm, pod.id);
          } catch (err) {
            logger.warn(
              { err, podId },
              'Failed to sync workspace back during handoff — agent may miss in-flight changes',
            );
          }
          // Recover MAX/PRO OAuth tokens before tearing down the workspace
          // container. Claude CLI rotates refresh tokens during the human's
          // interactive session; if we stop the container without persisting,
          // the auto-pod resume will hit invalid_grant on its first refresh.
          if (profile.modelProvider === 'max') {
            try {
              await persistRefreshedCredentials(
                pod.containerId,
                cm,
                profileStore,
                pod.profileName,
                logger,
              );
            } catch (err) {
              logger.warn(
                { err, podId },
                'Failed to persist rotated credentials before handoff stop — refresh may fail',
              );
            }
          }
          try {
            await cm.stop(pod.containerId);
          } catch (err) {
            logger.warn({ err, podId }, 'Failed to stop interactive container during handoff');
          }
          podRepo.update(podId, { containerId: null });
          pod = podRepo.getOrThrow(podId);

          // Commit any file-level changes the human left in the worktree.
          // syncWorkspaceBack copies files at the FS level; even when the in-container
          // git push succeeded (pushed=true), uncommitted edits remain unstaged on the
          // host. Committing here while the sync is fresh guarantees the branch has at
          // least one new commit before PR creation, avoiding GitHub 422s.
          // Human work is unconditionally trusted — no deletion guard needed.
          if (pod.worktreePath) {
            try {
              const committed = await worktreeManager.commitPendingChanges(
                pod.worktreePath,
                'chore: sync human session',
                { maxDeletions: 100 },
              );
              if (committed) {
                logger.info({ podId }, 'Auto-committed human session changes during handoff');
              }
            } catch (err) {
              logger.warn({ err, podId }, 'Failed to auto-commit during handoff — proceeding');
            }
          }

          // Compose the agent-facing handoff context now that the worktree
          // reflects the human's in-flight work. Reads the human's typed
          // instructions (captured by promoteToAuto) plus the live commit log
          // and diff stats; the system-instructions-generator renders this as
          // the `## Handoff` section in the agent's CLAUDE.md.
          //
          // Skip when `skipAgent` is set — the agent will never read this.
          if (!pod.skipAgent) {
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
        }

        // Detect recovery mode before any provisioning work
        const isRecovery = !!pod.recoveryWorktreePath;
        const isRework = isRecovery && !!pod.reworkReason;

        // Fresh provisioning gets a fresh worktree, so any prior deletion-guard
        // trip is moot. (Recovery reuses the existing worktree — leave the flag
        // intact; recoverWorktree() owns clearing it on that path.)
        const provisioningUpdates: Partial<PodUpdates> = {
          startedAt: new Date().toISOString(),
        };
        if (!isRecovery && pod.worktreeCompromised) {
          provisioningUpdates.worktreeCompromised = false;
        }

        // Transition to provisioning
        pod = transition(pod, 'provisioning', provisioningUpdates);

        // Snapshot the resolved profile at pod start time for auditability
        podRepo.update(podId, { profileSnapshot: profile });

        // Snapshot the resolved network policy once at first provisioning (ADR-020).
        // Guard prevents overwriting on recovery/resume — the original policy is the snapshot.
        if (!pod.networkPolicyResolved) {
          const resolvedNetworkPolicy = profile.networkPolicy?.enabled
            ? (profile.networkPolicy.mode ?? 'restricted')
            : 'allow-all';
          podRepo.update(podId, { networkPolicyResolved: resolvedNetworkPolicy });
        }

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

            if (profile.deployment?.enabled && bareRepoPath) {
              const baseRef = pod.baseBranch ?? profile.defaultBranch ?? 'main';
              const baselineHashes = await captureDeployBaselineHashes(
                bareRepoPath,
                baseRef,
                profile.deployment.allowedScripts,
                logger,
              );
              if (baselineHashes !== null) {
                podRepo.update(podId, { deployBaselineHashes: baselineHashes });
                pod = podRepo.getOrThrow(podId);
                logger.info(
                  { podId, count: Object.keys(baselineHashes).length, baseRef },
                  'deploy baseline hashes captured',
                );
              }
            }
          }
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
          const finalConfig = await networkManager.buildNetworkConfig(
            profile.networkPolicy,
            initialMergedMcpServers,
            daemonGatewayIp,
            profile.privateRegistries,
            podId,
            sidecarIps,
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
          // Host-side preview URL — same value the daemon writes to pod.previewUrl.
          // Surfaced inside the container so workspace users (and `claude`) know
          // which port to open from their host browser; container-local fetches
          // should still hit http://localhost:3000.
          PREVIEW_URL: `http://127.0.0.1:${hostPort}`,
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

        // Per-pod conversation-history directories. Bind-mounted into the container
        // so session state survives container respawns (sleep/wake, crash recovery).
        // Wired for Claude and Codex; Copilot still respawns fresh.
        let claudeStateDir: string | null = null;
        if (pod.runtime === 'claude') {
          try {
            claudeStateDir = await ensureClaudeStateDir(podId);
          } catch (err) {
            logger.warn(
              { err, podId },
              'Failed to create Claude state dir — resume across container respawns will fail',
            );
          }
        }

        let codexStateDir: string | null = null;
        if (pod.runtime === 'codex') {
          try {
            codexStateDir = await ensureCodexStateDir(podId);
          } catch (err) {
            logger.warn(
              { err, podId },
              'Failed to create Codex state dir — resume across container respawns will fail',
            );
          }
        }

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
              ...(claudeStateDir
                ? [{ host: claudeStateDir, container: `${CONTAINER_HOME_DIR}/.claude/projects` }]
                : []),
              ...(codexStateDir
                ? [{ host: codexStateDir, container: `${CONTAINER_HOME_DIR}/.codex/sessions` }]
                : []),
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

        // Restricted-mode pods run HAProxy as their egress allowlist; start
        // the denial receiver so blocked SNIs surface as pod events. Best
        // effort — failure here doesn't gate the pod.
        if (profile.networkPolicy?.enabled && profile.networkPolicy.mode === 'restricted') {
          await startHaproxyDenyReceiver(pod, containerId);
        }

        // Copy worktree content from bind mount to container's native filesystem.
        // VirtioFS bind mounts break getcwd() on Docker Desktop for Mac — overlayfs does not.
        // Dependency/tooling caches are intentionally skipped: they contain native binaries
        // for the filesystem they were created on and must not cross the host/container boundary.
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
            [
              'sh',
              '-c',
              buildWorkspaceMirrorCopyScript(
                '/mnt/worktree',
                "'/workspace'",
                WORKSPACE_RUNTIME_CACHE_EXCLUDES,
              ),
            ],
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

          // Strip untracked files left behind by the warm image. The image is built with
          // `RUN git clone --depth 1` of the base branch at image-build time, then runs
          // pre-warm install + build, then `rm -rf /workspace/.git`. Source files from
          // that older clone stay in `/workspace/` as plain files. The earlier
          // The worktree mirror copy is additive — it never deletes — so any file that the
          // host worktree's branch has dropped (e.g. deleted in a later PR on main) survives
          // in `/workspace` as an untracked file. `git restore .` only touches tracked paths,
          // so it doesn't help.
          //
          // For workspace pods the leak is severe: on promote/handoff, syncWorkspaceBack's
          // mirror copy and the subsequent `git add -A` in commitPendingChanges sweep stale
          // files into a commit on the branch. For auto pods it shows up as build noise
          // (native build tools discover sources via filesystem walk) and reviewer scope creep.
          //
          // `-fd` (no `-x`): preserves gitignored caches like node_modules, bin/, obj/,
          // dist/, .next/ so subsequent build phases keep their incremental state.
          // Combined with the prior `cp -a` + `git restore .`, the worktree now contains
          // exactly what the branch tip has, plus the warm-image dependency caches —
          // and nothing else.
          const clean = await containerManager.execInContainer(
            containerId,
            ['git', '-C', '/workspace', 'clean', '-fd'],
            { timeout: 30_000 },
          );
          if (clean.exitCode !== 0) {
            // Non-fatal: a failure here means the agent may see stale untracked files,
            // which is the bug we are fixing — but it's still better than aborting
            // pod start. Log loudly so operators can correlate with downstream
            // contamination reports.
            logger.warn(
              {
                podId,
                exitCode: clean.exitCode,
                stderr: clean.stderr.slice(0, 500),
              },
              'git clean -fd failed in /workspace — image-baked untracked files may leak into the worktree',
            );
          }

          // Hide daemon-injected code-intel state (`.serena/`, `.roslyn-codelens/`, …)
          // from the agent's `git add -A`. The system instructions tell the agent to run
          // `git add -A && git commit` for normal commits — without this, those caches get
          // swept into the feature branch on pod A, then pod B's fresh container has no
          // such files, and host-side `git add -A` perceives the absence as a mass-deletion
          // and trips DeletionGuardError. We've seen this fire repeatedly in practice.
          //
          // Two-step protection inside the container:
          //   1. Add the paths to `.git/info/exclude` (repo-local, never tracked).
          //   2. `git rm --cached -r --ignore-unmatch` to detrack any entries a previous
          //      pod already committed (idempotent; no-op when nothing is tracked).
          // The .git/info/exclude write is idempotent via a `grep -qF` guard so re-runs
          // don't duplicate lines.
          const cachePaths = agentToolingCachePaths(profile.codeIntelligence);
          if (cachePaths.length > 0) {
            const marker = '# autopod: code-intel cache exclusions';
            const excludeLines = [marker, ...cachePaths.map((p) => `/${p}/`)].join('\n');
            const detrackArgs = cachePaths.flatMap((p) => [p]);
            const script = [
              'set -e',
              'mkdir -p /workspace/.git/info',
              'touch /workspace/.git/info/exclude',
              `if ! grep -qF ${shellQuote(marker)} /workspace/.git/info/exclude; then`,
              `  printf '\\n%s\\n' ${shellQuote(excludeLines)} >> /workspace/.git/info/exclude`,
              'fi',
              `git -C /workspace rm --cached -r --ignore-unmatch -- ${detrackArgs
                .map(shellQuote)
                .join(' ')} >/dev/null 2>&1 || true`,
            ].join('\n');
            const cacheGuard = await containerManager.execInContainer(
              containerId,
              ['sh', '-c', script],
              { timeout: 10_000 },
            );
            if (cacheGuard.exitCode !== 0) {
              // Non-fatal: worst case is the historical deletion-guard loop returns. Log
              // loudly so we can correlate if it ever fires after this lands.
              logger.warn(
                {
                  podId,
                  exitCode: cacheGuard.exitCode,
                  stderr: cacheGuard.stderr.slice(0, 500),
                  cachePaths,
                },
                'Failed to install code-intel cache exclusions in /workspace/.git/info/exclude',
              );
            }
          }
        }

        // Pre-fill global git author identity so the user (or agent) doesn't hit
        // "Author identity unknown" the first time they `git commit`. Sourced
        // from the JWT claims captured at pod creation; falls back to a generic
        // identity for legacy pods or pre-auth code paths so commits never fail.
        {
          const email = normalizeCommitEmail(pod.creatorEmail) ?? 'autopod@autopod.local';
          const name = pod.creatorName?.trim() || 'Autopod User';
          const gitIdentity = await containerManager.execInContainer(
            containerId,
            [
              'sh',
              '-c',
              `git config --global user.email ${shellQuote(email)} && git config --global user.name ${shellQuote(name)}`,
            ],
            { timeout: 5_000 },
          );
          if (gitIdentity.exitCode !== 0) {
            // Non-fatal: the worst case is the user re-runs the two commands manually.
            logger.warn(
              { podId, exitCode: gitIdentity.exitCode, stderr: gitIdentity.stderr.slice(0, 200) },
              'Failed to set global git author identity in container',
            );
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
          runningAt: new Date().toISOString(),
        });

        // Fix pods: drain any queued reviewer/CI feedback into the task before
        // the agent stream starts. `drain()` runs *after* the `running`
        // transition is committed — a crash between `provisioning` and
        // `running` leaves the queue intact for the next iteration to drain.
        if (pod.linkedPodId) {
          const queued = fixFeedbackRepo.drain(pod.linkedPodId);
          if (queued.length > 0) {
            const userMessage = queued.map((m) => m.message).join('\n\n---\n\n');
            // The queued summaries already carry the CI/review content, so a
            // minimal status is sufficient — buildPrFixTask folds `userMessage`
            // into the task body.
            const minimalStatus: PrMergeStatus = {
              merged: false,
              open: true,
              blockReason: 'PR needs fixes',
              ciFailures: [],
              reviewComments: [],
            };
            const fixTask = buildPrFixTask(pod, minimalStatus, podRepo, profile, userMessage);
            podRepo.update(pod.id, { task: fixTask });
            pod = podRepo.getOrThrow(pod.id);
          }
        }

        // Resolve and write skills for all pod types (including workspace)
        const mergedSkills = mergeSkills(daemonConfig.skills ?? [], profile.skills ?? []);
        let resolvedSkillNames: string[] = [];
        let resolvedSkillInjections: typeof mergedSkills = [];
        if (mergedSkills.length > 0) {
          emitStatus('Resolving skills…');
          const resolvedSkills = await resolveSkills(mergedSkills, logger, podId, safetyEventsRepo);
          const mergedSkillByName = new Map(mergedSkills.map((skill) => [skill.name, skill]));
          const skillsDir = `${CONTAINER_HOME_DIR}/.claude/skills`;
          for (const skill of resolvedSkills) {
            await containerManager.writeFile(
              containerId,
              `${skillsDir}/${skill.name}/SKILL.md`,
              skill.content,
            );
          }
          resolvedSkillNames = resolvedSkills.map((s) => s.name);
          resolvedSkillInjections = resolvedSkills
            .map((resolved) => {
              const original = mergedSkillByName.get(resolved.name);
              if (!original) return null;
              return {
                ...original,
                description: resolved.description ?? original.description,
              };
            })
            .filter((skill): skill is (typeof mergedSkills)[number] => skill !== null);
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

              const instructionTarget = getHistoryInstructionTarget(pod.runtime);
              if (instructionTarget.path.includes('/.github/')) {
                await containerManager.execInContainer(
                  containerId,
                  ['mkdir', '-p', '/workspace/.github'],
                  { timeout: 5_000 },
                );
              }
              const instructions = generateHistoryInstructions(stats, instructionTarget);
              await containerManager.writeFile(containerId, instructionTarget.path, instructions);

              logger.info(
                {
                  podId,
                  exportedSessions: stats.totalSessions,
                  instructionPath: instructionTarget.path,
                },
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
          emitStatus('⚠️ 0-byte .bin stubs detected — running npm rebuild to restore them…');
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

        // Resolve runtime-fetched sections (fetches URLs, respects token budgets)
        if (mergedSections.some((s) => s.fetch)) {
          emitStatus('Fetching runtime CLAUDE.md sections…');
        }
        const resolvedSections = await resolveSections(mergedSections, logger, {
          podId,
          safetyEventsRepo,
        });

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
          injectedSkills: resolvedSkillInjections,
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
        const providerResult = await buildProviderEnv(profile, podId, logger, { profileStore });
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

        // skipAgent escape hatch: operator promoted an interactive pod with
        // `--skip-agent` — the human's work is final. Container is up so
        // validation/artifact extraction inside `handleCompletion` can run;
        // we just bypass the runtime spawn entirely.
        // Clear the one-shot flag *before* handing off so a future failed →
        // resume cycle re-runs the agent normally.
        if (pod.skipAgent) {
          podRepo.update(podId, { skipAgent: false });
          emitStatus('Skipping agent — going straight to completion…');
          logger.info(
            { podId, output: pod.options.output },
            'skipAgent: bypassing runtime spawn, proceeding to handleCompletion',
          );
          await this.handleCompletion(podId);
          return;
        }

        if (
          isRecovery &&
          !isRework &&
          hasLatestPersistedAgentTerminalEventComplete(deps.eventRepo, podId)
        ) {
          emitStatus('Agent already finished before recovery — resuming completion…');
          logger.info(
            { podId, worktreePath },
            'Recovery found persisted agent complete event — skipping agent spawn',
          );
          await this.handleCompletion(podId);
          return;
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
          // biome-ignore lint/style/noNonNullAssertion: worktreePath is non-null for recovery pods
          const safeWorktreePath = worktreePath!;

          // The resume call returns the iterator synchronously — the failure
          // (Claude printing "No conversation found with session ID" and exiting)
          // surfaces mid-iteration as a thrown ResumeSessionNotFoundError. Wrap
          // in a generator so we can catch the throw, clear the stale session
          // ID, and fall through to a fresh spawn in the same container without
          // dying silently. (The container is still alive after Claude's exit.)
          const podRepoRef = podRepo;
          const runtimeRef = runtime;
          const containerIdRef = containerId;
          const podModel = pod.model;
          const podRef = pod;
          const mcpServersRef = mcpServers;
          const customInstructionsRef = copilotInstructions;
          const secretEnvRef = secretEnv;
          const loggerRef = logger;
          events = (async function* resumeWithFallback() {
            try {
              yield* runtimeRef.resume(podId, continuationPrompt, containerIdRef, secretEnvRef);
            } catch (err) {
              if (!(err instanceof ResumeSessionNotFoundError)) throw err;
              loggerRef.warn(
                { podId, claudeSessionId: err.claudeSessionId },
                'Claude --resume found no conversation on disk — falling back to fresh spawn',
              );
              // Clear the stale ID so any future recovery on this pod doesn't
              // loop trying to resume the same nonexistent conversation.
              podRepoRef.update(podId, { claudeSessionId: null });
              const recoveryTask = await buildRecoveryTask(podRef, safeWorktreePath);
              yield* runtimeRef.spawn({
                podId,
                task: recoveryTask,
                model: podModel,
                workDir: '/workspace',
                containerId: containerIdRef,
                customInstructions: customInstructionsRef,
                env: secretEnvRef,
                mcpServers: mcpServersRef,
              });
            }
          })();
        } else if (isRecovery && pod.runtime === 'codex' && pod.codexSessionId) {
          // Codex crash recovery: continue the existing session
          emitStatus('Resuming Codex pod…');
          // biome-ignore lint/style/noNonNullAssertion: worktreePath is non-null for recovery pods
          const codexContinuationPrompt = await buildContinuationPrompt(pod, worktreePath!);
          events = runtime.resume(podId, codexContinuationPrompt, containerId, secretEnv);
        } else if (isRecovery) {
          // Non-Claude/Codex runtime or no session ID — fresh spawn with recovery context
          // biome-ignore lint/style/noNonNullAssertion: worktreePath is non-null for recovery pods
          let recoveryTask = await buildRecoveryTask(pod, worktreePath!);
          // For non-Claude runtimes recovering after host wake, append a postscript so the
          // agent checks git history before redoing work already on disk.
          if (pod.runtime !== 'claude' && pod.lastRecoveryTrigger === 'wake') {
            recoveryTask +=
              '\n\nNote: this run was interrupted by a host sleep and restarted. Some' +
              ' work may already be on disk — check `git log` and `git diff main`' +
              ' before continuing.';
          }
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

        await this.consumeAgentEvents(podId, events, startingAttempt);

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
        // Best-effort: recover rotated MAX/PRO tokens before the failure path
        // tears the container down. The happy-path persist at the end of the
        // try block was bypassed, so without this the latest refresh token
        // dies with the container.
        try {
          const failingPod = podRepo.getOrThrow(podId);
          if (failingPod.containerId) {
            const failingProfile = profileStore.get(failingPod.profileName);
            if (failingProfile.modelProvider === 'max') {
              await persistRefreshedCredentials(
                failingPod.containerId,
                containerManagerFactory.get(failingPod.executionTarget),
                profileStore,
                failingPod.profileName,
                logger,
              );
            }
          }
        } catch (persistErr) {
          logger.warn(
            { err: persistErr, podId },
            'Failed to persist rotated credentials after pod error — proceeding',
          );
        }
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

    async consumeAgentEvents(
      podId: string,
      events: AsyncIterable<AgentEvent>,
      attempt = 0,
    ): Promise<void> {
      startCommitPolling(podId);
      try {
        for await (const event of events) {
          eventBus.emit({
            type: 'pod.agent_activity',
            timestamp: event.timestamp,
            podId,
            event,
          });

          bumpActivityTimestamp(podId);

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
          } else if (event.type === 'status' && event.sessionId) {
            // Persist session ID to DB for pause/resume survival across daemon restarts
            const sessionPod = podRepo.getOrThrow(podId);
            const sessionUpdate: PodUpdates = {};
            if (sessionPod.runtime === 'claude') sessionUpdate.claudeSessionId = event.sessionId;
            else if (sessionPod.runtime === 'codex') sessionUpdate.codexSessionId = event.sessionId;
            if (Object.keys(sessionUpdate).length > 0) podRepo.update(podId, sessionUpdate);
          } else if (event.type === 'complete') {
            // Accumulate token counts and cost cumulatively across all runs in this pod
            const currentSession = podRepo.getOrThrow(podId);
            const newInputTokens = currentSession.inputTokens + (event.totalInputTokens ?? 0);
            const newOutputTokens = currentSession.outputTokens + (event.totalOutputTokens ?? 0);
            const tokenUpdates: PodUpdates = {};
            if (event.totalInputTokens !== undefined || event.totalOutputTokens !== undefined) {
              tokenUpdates.inputTokens = newInputTokens;
              tokenUpdates.outputTokens = newOutputTokens;
              const bucketKey =
                attempt === 0
                  ? ('agent_initial' as const)
                  : (`agent_rework_${attempt}` as `agent_rework_${number}`);
              const existing = currentSession.phaseTokenUsage ?? {};
              const prev = existing[bucketKey] ?? { inputTokens: 0, outputTokens: 0 };
              tokenUpdates.phaseTokenUsage = {
                ...existing,
                [bucketKey]: {
                  inputTokens: prev.inputTokens + (event.totalInputTokens ?? 0),
                  outputTokens: prev.outputTokens + (event.totalOutputTokens ?? 0),
                },
              };
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
        lastEventWriteAt.delete(podId);
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
        await cleanupContainer(pod, 'artifact-complete');
        transition(pod, 'complete');
        return;
      }

      // Sync workspace back to host worktree before any host-side git reads
      let syncSucceeded = true;
      let agentCommitsPushed = true;
      if (pod.containerId && pod.worktreePath) {
        try {
          const cm = containerManagerFactory.get(pod.executionTarget);
          const result = await syncWorkspaceBack(pod.containerId, pod.worktreePath, cm, pod.id);
          agentCommitsPushed = result.pushed;
          if (!agentCommitsPushed) {
            logger.warn(
              { podId },
              'Sync-back completed but push to bare did not — auto-commit will run with strict deletion guard',
            );
          }
        } catch (err) {
          logger.warn({ err, podId }, 'Failed to sync workspace back to host');
          const recovered = await tryRecoverAfterWorkspaceSyncFailure(pod, err, 'auto-commit');
          syncSucceeded = recovered;
          agentCommitsPushed = recovered;
        }
      }

      // Auto-commit any uncommitted changes the agent left behind, then get diff stats.
      // When sync failed OR the in-container push didn't land on the bare, clamp deletions
      // to 0 so a `git add -A` over a partially-synced or stale-base worktree can't masquerade
      // as agent work. Push failure here is the canary for /workspace/.git diverging from
      // the host bare's branch tip — see syncWorkspaceBack for context.
      const safeAutoCommit = syncSucceeded && agentCommitsPushed;
      if (!syncSucceeded) {
        parkOnWorktreeSyncFailure(
          podId,
          'Workspace sync failed before auto-commit — validation blocked.',
        );
        return;
      }
      if (pod.worktreePath) {
        const profileForCommit = profileStore.get(pod.profileName);
        try {
          const committed = await worktreeManager.commitPendingChangesWithGeneratedMessage(
            pod.worktreePath,
            pod.task,
            profileForCommit,
            pod.model,
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
              pod.id,
            );
            if (recovered) {
              try {
                await worktreeManager.commitPendingChangesWithGeneratedMessage(
                  pod.worktreePath,
                  pod.task,
                  profileForCommit,
                  pod.model,
                  { maxDeletions: 100 },
                );
                logger.info({ podId }, 'Auto-committed after live container recovery');
              } catch (retryErr) {
                logger.error(
                  { err: retryErr, podId },
                  'Commit after worktree recovery also failed',
                );
                if (handleDeletionGuardError(podId, retryErr)) {
                  const compromised = podRepo.getOrThrow(podId);
                  if (compromised.status === 'running') {
                    transition(compromised, 'failed');
                  }
                  return;
                }
              }
            } else {
              logger.error({ err, podId }, 'Auto-commit blocked by deletion safety guard');
              if (handleDeletionGuardError(podId, err)) {
                const compromised = podRepo.getOrThrow(podId);
                if (compromised.status === 'running') {
                  transition(compromised, 'failed');
                }
                return;
              }
            }
          } else {
            logger.error({ err, podId }, 'Auto-commit blocked by deletion safety guard');
            if (handleDeletionGuardError(podId, err)) {
              const compromised = podRepo.getOrThrow(podId);
              if (compromised.status === 'running') {
                transition(compromised, 'failed');
              }
              return;
            }
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

        // Daemon-side push failure: skip container injection (no agent waiting)
        // and retry the post-validation push from the host with the freshly
        // updated profile PAT.
        if (payload.source === 'host_push') {
          const profile = profileStore.get(pod.profileName);
          const pat = selectGitPat(profile);
          if (!pat) {
            throw new AutopodError(
              `Profile '${pod.profileName}' still has no PAT for ${payload.service}. Add the ${payload.service === 'github' ? 'githubPat' : 'adoPat'} to the profile (must have write access to the target repo) and try again.`,
              'MISSING_CREDENTIAL',
              400,
            );
          }

          if (!pod.worktreePath) {
            throw new AutopodError(
              `Pod ${podId} has no worktree — cannot retry push`,
              'INVALID_STATE',
              409,
            );
          }

          escalationRepo.update(pod.pendingEscalation.id, {
            respondedAt: new Date().toISOString(),
            respondedBy: 'human',
            response: 'pat_updated',
          });
          // awaiting_input → validating: park-then-retry without re-running the
          // agent. The validation result we already passed is still authoritative.
          const validatingPod = transition(pod, 'validating', { pendingEscalation: null });
          const carryForwardPrUrl = validatingPod.prUrl;
          emitActivityStatus(
            podId,
            carryForwardPrUrl
              ? `${payload.service} PAT updated — retrying push to existing PR…`
              : `${payload.service} PAT updated — retrying branch push and PR creation…`,
          );

          try {
            // Always push first — same shape as the original post-validation
            // path. maxDeletions=0 mirrors `pushAndCreatePr`: the container is
            // already stopped/gone so a phantom mass-delete must not slip in.
            await worktreeManager.mergeBranch({
              worktreePath: validatingPod.worktreePath ?? '',
              targetBranch: validatingPod.branch,
              pat,
              maxDeletions: 0,
              podTask: validatingPod.task,
              profile,
              podModel: validatingPod.model,
            });

            // Only open a new PR if this isn't a fix pod carrying one forward.
            let newPrUrl = carryForwardPrUrl;
            if (!newPrUrl) {
              const prManager = prManagerFactory ? prManagerFactory(profile) : null;
              if (prManager) {
                emitActivityStatus(podId, 'Creating PR…');
                const refreshed = podRepo.getOrThrow(podId);
                const baseBranch = resolvePrBaseBranch(refreshed, profile);
                const createResult = await prManager.createPr({
                  // biome-ignore lint/style/noNonNullAssertion: validated above
                  worktreePath: refreshed.worktreePath!,
                  repoUrl: profile.repoUrl ?? undefined,
                  branch: refreshed.branch,
                  baseBranch,
                  podId,
                  task: refreshed.task,
                  profileName: refreshed.profileName,
                  profile,
                  podModel: refreshed.model,
                  handoffInstructions: refreshed.handoffInstructions ?? undefined,
                  validationResult: refreshed.lastValidationResult ?? null,
                  validationWaiver: refreshed.validationWaiver,
                  filesChanged: refreshed.filesChanged,
                  linesAdded: refreshed.linesAdded,
                  linesRemoved: refreshed.linesRemoved,
                  previewUrl: refreshed.previewUrl,
                  screenshots: [],
                  taskSummary: refreshed.taskSummary ?? undefined,
                  seriesDescription: refreshed.seriesDescription ?? undefined,
                  seriesName: refreshed.seriesName ?? undefined,
                  securityFindings: getLatestPushFindings(podId),
                });
                newPrUrl = createResult.url ?? null;
                if (newPrUrl) {
                  emitActivityStatus(podId, `PR created: ${newPrUrl}`);
                }
              }
            } else {
              emitActivityStatus(podId, `Carrying forward existing PR: ${carryForwardPrUrl}`);
            }

            const validatedPod = transition(podRepo.getOrThrow(podId), 'validated', {
              prUrl: newPrUrl,
              lastCorrectionMessage: null,
            });
            maybeTriggerDependents(validatedPod);

            // Stop the container post-validation (mirrors the original push path).
            if (validatedPod.containerId) {
              try {
                const cm = containerManagerFactory.get(validatedPod.executionTarget);
                await cm.stop(validatedPod.containerId);
              } catch (stopErr) {
                logger.warn(
                  { err: stopErr, podId },
                  'Failed to stop container after host_push retry',
                );
              }
            }

            if (validatedPod.autoApprove) {
              logger.info({ podId }, 'Auto-approving pod after host_push retry');
              setImmediate(() => {
                this.approveSession(podId).catch((err) =>
                  logger.warn({ err, podId }, 'Auto-approve after host_push retry failed'),
                );
              });
            }
          } catch (err) {
            // Fresh PAT is still bad — re-park rather than fail terminally.
            if (err instanceof GitCredentialError) {
              parkOnCredentialFailure(podId, err);
              return;
            }
            logger.error({ err, podId }, 'host_push retry failed after credential fix');
            const s = podRepo.getOrThrow(podId);
            if (!isTerminalState(s.status)) {
              transition(s, 'failed');
            }
            throw err;
          }
          return;
        }

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
            await this.consumeAgentEvents(podId, events, pod.validationAttempts);
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
        await this.consumeAgentEvents(podId, events, pod.validationAttempts);
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
      const isWorkspacePod = pod.options?.agentMode === 'interactive';

      // No-change fast-path: skip PR creation and complete directly.
      // Workspace pods are excluded — their human edits live in the container until
      // mergeBranch() runs container→host sync-back, so they MUST take the normal
      // merge path. Re-check stats from the worktree (cached pod.filesChanged is
      // stale after force-approve / human-fix) and still push the branch so the
      // user has a recoverable handle on origin if the "no changes" call is wrong.
      if (!isWorkspacePod && pod.worktreePath && !pod.prUrl) {
        let trulyNoChanges = false;
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
          if (
            stats.filesChanged !== pod.filesChanged ||
            stats.linesAdded !== pod.linesAdded ||
            stats.linesRemoved !== pod.linesRemoved
          ) {
            podRepo.update(podId, {
              filesChanged: stats.filesChanged,
              linesAdded: stats.linesAdded,
              linesRemoved: stats.linesRemoved,
            });
          }
          trulyNoChanges = stats.filesChanged === 0;
        } catch (err) {
          logger.warn(
            { err, podId },
            'getDiffStats failed in approveSession; falling back to normal merge path',
          );
          trulyNoChanges = false;
        }

        if (trulyNoChanges) {
          emitActivityStatus(podId, 'No changes to merge — pushing branch and completing pod');
          if (pod.branch) {
            try {
              const useForce = forceWithLeaseAllowances.has(podId);
              if (useForce) {
                await worktreeManager.pushBranch(pod.worktreePath, pod.branch, { force: true });
              } else {
                await worktreeManager.pushBranch(pod.worktreePath, pod.branch);
              }
              forceWithLeaseAllowances.delete(podId);
            } catch (err) {
              logger.warn(
                { err, podId },
                'Branch push failed in no-changes fast-path; continuing to complete',
              );
            }
          }
          const s1 = transition(pod, 'approved');
          const s2 = transition(s1, 'merging');
          await cleanupContainer(pod, 'approve-no-changes');
          const noChangePod = transition(s2, 'complete', {
            completedAt: new Date().toISOString(),
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
              filesChanged: 0,
              createdAt: pod.createdAt,
            },
          });
          logger.info(
            { podId },
            'Pod approved with no changes — branch pushed, completed without PR',
          );
          maybeTriggerDependents(noChangePod);
          return;
        }
      }

      emitActivityStatus(podId, 'Approved — merging changes…');
      const s1 = transition(pod, 'approved');
      const s2 = transition(s1, 'merging');

      // Merge the PR if one was created, otherwise fall back to branch push
      const approveProfile = profileStore.get(pod.profileName);
      const prManager = prManagerFactory ? prManagerFactory(approveProfile) : null;
      if (pod.prUrl && prManager && pod.worktreePath) {
        const mergeBaseBranch = pod.baseBranch ?? approveProfile.defaultBranch ?? 'main';
        const queueKey = MergeQueue.keyFor(approveProfile.repoUrl, mergeBaseBranch);
        const worktreePath = pod.worktreePath;
        const prUrl = pod.prUrl;
        const branch = pod.branch ?? '';

        // Outcome of the queued critical section. We do state transitions outside
        // the queue so the lock is released as quickly as possible.
        type MergeOutcome =
          | { kind: 'merged' }
          | { kind: 'merge_pending'; blockReason: string }
          | { kind: 'merge_failed' };

        const outcome = await mergeQueue.run<MergeOutcome>(queueKey, async () => {
          // Fix pods make commits in the container but rely on the agent to push.
          // Push explicitly here before attempting to complete the PR so any local
          // commits the agent forgot (or failed) to push are flushed to the remote.
          // Pass the PAT so we don't depend on the in-memory cache, which is
          // evicted whenever any sibling worktree on the same bare repo is
          // cleaned up (local-worktree-manager.ts cleanup()).
          const useForce = forceWithLeaseAllowances.has(podId);
          try {
            await worktreeManager.pushBranch(worktreePath, branch, {
              pat: selectGitPat(approveProfile),
              ...(useForce ? { force: true } : {}),
            });
            forceWithLeaseAllowances.delete(podId);
            emitActivityStatus(podId, 'Branch pushed');
          } catch (pushErr) {
            const reason = pushErr instanceof Error ? pushErr.message : String(pushErr);
            const blockReason = `Push to origin failed: ${reason}`;
            logger.warn(
              { err: pushErr, podId },
              'Pre-merge push failed — entering merge_pending instead of merging stale origin',
            );
            return { kind: 'merge_pending', blockReason };
          }

          // Pre-merge rebase onto latest origin/<base>. Catches conflicts
          // *before* the PR merge attempt so an agent (or fix pod) gets to
          // resolve them while it still has full task context, instead of
          // discovering the conflict via GitHub's merge gate after the fact.
          // Runs inside the merge queue so the rebase always sees the freshly
          // merged state of any preceding pod on the same base.
          emitActivityStatus(podId, `Rebasing onto origin/${mergeBaseBranch}…`);
          const rebaseResult = await worktreeManager.rebaseOntoBase({
            worktreePath,
            baseBranch: mergeBaseBranch,
            pat: selectGitPat(approveProfile),
          });

          if (!rebaseResult.rebased) {
            const blockReason = formatRebaseConflictReason(mergeBaseBranch, rebaseResult.conflicts);
            logger.info(
              {
                podId,
                prUrl,
                baseBranch: mergeBaseBranch,
                conflicts: rebaseResult.conflicts,
              },
              'Pre-merge rebase produced conflicts — entering merge_pending for manual resolution',
            );
            return { kind: 'merge_pending', blockReason };
          }

          // Rebase rewrote history → force-push so origin/<branch> matches our
          // new HEAD. Skip the push when the rebase was a no-op (already up to
          // date) since we already pushed above.
          if (!rebaseResult.alreadyUpToDate) {
            try {
              await worktreeManager.pushBranch(worktreePath, branch, {
                force: true,
                pat: selectGitPat(approveProfile),
              });
              emitActivityStatus(podId, 'Rebased branch pushed');
            } catch (pushErr) {
              const reason = pushErr instanceof Error ? pushErr.message : String(pushErr);
              const blockReason = `Force-push after rebase failed: ${reason}`;
              logger.warn(
                { err: pushErr, podId },
                'Force-push after rebase failed — entering merge_pending instead of merging stale origin',
              );
              return { kind: 'merge_pending', blockReason };
            }
          }

          // Daemon-side approval gate: check the PR's review decision before attempting
          // to merge. If the platform reports that a review is still required or changes
          // were requested, enter merge_pending and let the poller wait for approval.
          // This ensures the daemon never bypasses required review gates even when
          // GitHub auto-merge is enabled.
          try {
            const prStatus = await prManager.getPrStatus({ prUrl, worktreePath });
            if (prStatus.reviewDecision && prStatus.reviewDecision !== 'APPROVED') {
              const blockReason = `Waiting for PR review approval (current decision: ${prStatus.reviewDecision})`;
              logger.info(
                { podId, prUrl, reviewDecision: prStatus.reviewDecision },
                'Merge deferred — PR requires explicit approval before daemon will merge',
              );
              return { kind: 'merge_pending', blockReason };
            }
          } catch (statusErr) {
            // Non-fatal: if we can't determine review status, proceed with the merge attempt
            logger.warn(
              { err: statusErr, podId, prUrl },
              'Failed to check PR review decision before merge — proceeding anyway',
            );
          }

          emitActivityStatus(podId, `Merging PR: ${prUrl}`);
          try {
            const mergeResult = await prManager.mergePr({
              worktreePath,
              prUrl,
              squash: options?.squash,
            });

            if (mergeResult.merged) {
              return { kind: 'merged' };
            }
            // Merge didn't complete immediately — enter merge_pending state
            const initialStatus = await prManager.getPrStatus({ prUrl, worktreePath });
            const blockReason = initialStatus.blockReason ?? 'Waiting for merge conditions';
            logger.info(
              {
                podId,
                prUrl,
                blockReason,
                autoMerge: mergeResult.autoMergeScheduled,
              },
              'Pod approved — merge pending',
            );
            return { kind: 'merge_pending', blockReason };
          } catch (err) {
            logger.error({ err, podId, prUrl }, 'Failed to merge PR');
            // Merge command failed — check if the PR is blocked by checks/reviews
            try {
              const fallbackStatus = await prManager.getPrStatus({ prUrl, worktreePath });
              if (fallbackStatus.open && !fallbackStatus.merged) {
                const blockReason =
                  fallbackStatus.blockReason ?? 'Merge failed — waiting for conditions';
                logger.info(
                  { podId, prUrl, blockReason },
                  'Merge failed but PR is open — entering merge_pending',
                );
                return { kind: 'merge_pending', blockReason };
              }
            } catch (statusErr) {
              logger.warn(
                { err: statusErr, podId },
                'Failed to check PR status after merge failure',
              );
            }
            return { kind: 'merge_failed' };
          }
        });

        if (outcome.kind === 'merged') {
          emitActivityStatus(podId, 'PR merged successfully');
        } else if (outcome.kind === 'merge_pending') {
          emitActivityStatus(podId, `Merge pending: ${outcome.blockReason}`);
          transition(s2, 'merge_pending', { mergeBlockReason: outcome.blockReason });
          startMergePolling(podId);
          return;
        } else {
          emitActivityStatus(podId, 'PR merge failed — pod still completing');
        }
      } else if (!pod.prUrl && prManager && pod.worktreePath && pod.options?.output !== 'branch') {
        // PR creation failed during validation — retry it now
        emitActivityStatus(podId, 'No PR found — creating PR before merging…');
        let retryPrUrl: string | null = null;
        try {
          const retryProfile = profileStore.get(pod.profileName);
          await worktreeManager.mergeBranch({
            worktreePath: pod.worktreePath,
            // Push the feature branch up so the PR can be opened against the resolved base.
            targetBranch: pod.branch,
            // Pass the PAT explicitly — approval retry runs post-container, so the
            // in-memory PAT cache may be cold after a daemon restart.
            pat: selectGitPat(retryProfile),
            // Post-container retry: sync-back already happened (or failed silently) upstream;
            // belt-and-suspenders autocommit here must not commit a phantom mass-deletion.
            maxDeletions: 0,
            // Provide pod task as context for any auto-generated commit message.
            podTask: pod.task,
            profile: retryProfile,
            podModel: pod.model,
          });
          const createResult = await prManager.createPr({
            // biome-ignore lint/style/noNonNullAssertion: worktreePath is non-null in approval retry — pods reach approved only after successful validation which requires a worktree
            worktreePath: pod.worktreePath!,
            repoUrl: retryProfile.repoUrl ?? undefined,
            branch: pod.branch,
            baseBranch: resolvePrBaseBranch(pod, retryProfile),
            podId,
            task: pod.task,
            profileName: pod.profileName,
            profile: retryProfile,
            podModel: pod.model,
            handoffInstructions: pod.handoffInstructions ?? undefined,
            validationResult: null,
            validationWaiver: pod.validationWaiver,
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
          const newPrUrl = createResult.url;
          retryPrUrl = newPrUrl;
          if (createResult.usedFallback) {
            const which = createResult.narrativeUsedFallback
              ? createResult.titleUsedFallback
                ? 'title + body'
                : 'body'
              : 'title';
            const reason = createResult.fallbackReason ?? 'unknown';
            logger.error(
              {
                podId,
                profile: retryProfile.name,
                modelProvider: retryProfile.modelProvider,
                fallbackReason: reason,
                fallbackDetail: createResult.fallbackDetail,
              },
              'PR description used template fallback during approval retry',
            );
            emitActivityStatus(podId, `PR ${which} used template fallback: ${reason}`);
          }
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
          if (handleDeletionGuardError(podId, err)) {
            transition(s2, 'validated');
            return;
          }
          const message = err instanceof Error ? err.message : String(err);
          if (retryPrUrl) {
            const blockReason = `Merge after PR creation failed: ${message}`;
            emitActivityStatus(podId, `Merge pending: ${blockReason}`);
            transition(s2, 'merge_pending', { mergeBlockReason: blockReason });
            startMergePolling(podId);
            return;
          }
          emitActivityStatus(podId, 'PR creation failed — pod returned to validated');
          transition(s2, 'validated');
          return;
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
            profile,
            podModel: pod.model,
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
      await cleanupContainer(pod, 'approve-complete');
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

      const rejectableStates = ['validated', 'failed', 'review_required'] as const;
      if (!(rejectableStates as readonly string[]).includes(pod.status)) {
        throw new AutopodError(
          `Cannot reject pod ${podId} in status ${pod.status}`,
          'INVALID_STATE',
          409,
        );
      }

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
        await this.consumeAgentEvents(podId, events, deriveAgentAttempt(pod.phaseTokenUsage));
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
          const cm = containerManagerFactory.get(pod.executionTarget);
          // Best-effort: recover rotated MAX/PRO tokens before the container
          // dies. Otherwise a kill mid-session strands the latest refresh
          // token in the doomed container, and the next pod hits invalid_grant.
          try {
            const profile = profileStore.get(pod.profileName);
            if (profile.modelProvider === 'max') {
              await persistRefreshedCredentials(
                pod.containerId,
                cm,
                profileStore,
                pod.profileName,
                logger,
              );
            }
          } catch (err) {
            logger.warn(
              { err, podId },
              'Failed to persist rotated credentials during kill — proceeding',
            );
          }
          try {
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

        // Cleanup per-pod conversation-history dirs on the host. Best
        // effort — if they linger they just waste a few KB of disk per pod.
        const runtimeStateDirs: Partial<Record<string, (id: string) => Promise<void>>> = {
          claude: cleanupClaudeState,
          codex: cleanupCodexState,
        };
        await runtimeStateDirs[pod.runtime]?.(podId)?.catch((err) => {
          logger.warn({ err, podId }, `Failed to cleanup ${pod.runtime} state dir`);
        });
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
      options?: { instructions?: string; skipAgent?: boolean },
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

      const skipAgent = !!options?.skipAgent;
      if (skipAgent && targetOutput === 'none') {
        // No PR, no push, no artifact, no agent — pod would just die. Refuse
        // explicitly so the caller picks a real promotion target.
        throw new AutopodError(
          "--skip-agent requires a promotion target ('--pr' or '--artifact')",
          'INVALID_OUTPUT_MODE',
          400,
        );
      }

      // Capture the human's handoff instructions BEFORE the transition so they
      // survive the recovery restart. The recovery path inside processPod reads
      // them after `syncWorkspaceBack()` completes and composes `handoffContext`.
      // (When skipAgent is set the agent never sees these — the field stays on
      // the pod for audit/UI purposes only.)
      const trimmedInstructions = options?.instructions?.trim();
      if (trimmedInstructions && trimmedInstructions.length > 0) {
        podRepo.update(podId, { handoffInstructions: trimmedInstructions });
      }

      if (skipAgent) {
        podRepo.update(podId, { skipAgent: true });
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
        skipAgent?: boolean;
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
          skipAgent: options.skipAgent,
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
            await syncWorkspaceBack(pod.containerId, pod.worktreePath, cm, podId);
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
      await cleanupContainer(pod, 'workspace-complete');
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

    async syncWorkspaceBranch(
      podId: string,
    ): Promise<{ committed: boolean; pushed: boolean; error?: string }> {
      const pod = podRepo.getOrThrow(podId);

      if (pod.options.agentMode !== 'interactive') {
        throw new AutopodError(
          'sync-branch is only valid for interactive workspace pods',
          'INVALID_OUTPUT_MODE',
          400,
        );
      }
      if (pod.status !== 'running') {
        throw new AutopodError(
          `Cannot sync workspace branch in status '${pod.status}' — pod must be running`,
          'INVALID_STATE',
          409,
        );
      }
      if (!pod.worktreePath || !pod.branch) {
        throw new AutopodError(
          'Pod has no worktree or branch — nothing to sync',
          'INVALID_STATE',
          409,
        );
      }

      // Pull container changes back to the host worktree so any uncommitted
      // briefs the user just wrote land on disk. Mirrors the first step of
      // completeSession but stops short of pushing + cleaning up.
      if (pod.containerId) {
        try {
          const cm = containerManagerFactory.get(pod.executionTarget);
          await syncWorkspaceBack(pod.containerId, pod.worktreePath, cm, podId);
        } catch (err) {
          logger.warn({ err, podId }, 'syncWorkspaceBranch: sync-back failed — continuing');
        }
      }

      // Stage ONLY .md files. Workspace pods can have unrelated content sitting
      // staged-or-untracked in the worktree (e.g. files copied from a stale
      // container snapshot, or in-progress code work the user hasn't decided
      // to commit yet). A blanket `git add -A` would sweep all of that into
      // the handoff commit and trigger repo-local pre-commit hooks (build/lint
      // checks) that have nothing to do with brief authoring. Scoping to .md
      // keeps the snapshot tight: briefs, design.md, purpose.md, skill docs.
      const profile = profileStore.get(pod.profileName);
      const headBefore = await worktreeManager
        .getCommitLog(pod.worktreePath, pod.branch, 1)
        .catch(() => '');
      try {
        // List every .md path that differs from HEAD or is untracked. Using
        // `git ls-files` with the `--others`/`--modified` flags catches both
        // existing-but-edited briefs and brand-new ones in one pass.
        const { stdout: mdListed } = await execFileAsync(
          'git',
          ['ls-files', '--modified', '--others', '--exclude-standard', '--', '*.md'],
          { cwd: pod.worktreePath, maxBuffer: 10 * 1024 * 1024 },
        );
        const mdPaths = mdListed
          .split('\n')
          .map((p) => p.trim())
          .filter((p) => p.length > 0);

        if (mdPaths.length === 0) {
          logger.info(
            { podId, branch: pod.branch },
            'syncWorkspaceBranch: no .md changes to commit',
          );
          return { committed: false, pushed: false };
        }

        await worktreeManager.commitFiles(
          pod.worktreePath,
          mdPaths,
          'chore: sync workspace for series handoff',
        );

        await worktreeManager.pushBranch(pod.worktreePath, pod.branch, {
          pat: selectGitPat(profile),
        });

        const headAfter = await worktreeManager
          .getCommitLog(pod.worktreePath, pod.branch, 1)
          .catch(() => '');
        const committed = headBefore !== headAfter;
        logger.info(
          { podId, branch: pod.branch, committed, mdFiles: mdPaths.length },
          'syncWorkspaceBranch: briefs synced + pushed to origin',
        );
        return { committed, pushed: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({ err, podId }, 'syncWorkspaceBranch: commit/push failed');
        return { committed: false, pushed: false, error: message };
      }
    },

    async triggerValidation(podId: string, options?: { force?: boolean }): Promise<void> {
      const pod = podRepo.getOrThrow(podId);
      const force = options?.force ?? false;

      const triggerValidationFromUpdateIntent = () => {
        setImmediate(() =>
          this.triggerValidation(podId).catch((e: unknown) =>
            logger.error({ err: e, podId }, 'update-from-base follow-up validation failed'),
          ),
        );
      };
      // Must be checked before sending correction feedback to the agent.
      const tryConsumeUpdateIntent = (): boolean => {
        if (!pendingUpdateFromBaseIntents.has(podId)) return false;
        pendingUpdateFromBaseIntents.delete(podId);
        runUpdateFromBaseAfterAbort(podId, triggerValidationFromUpdateIntent).catch((e: unknown) =>
          logger.error({ err: e, podId }, 'update-from-base after abort failed'),
        );
        return true;
      };

      if (pod.worktreeCompromised) {
        emitActivityStatus(
          podId,
          'Validation blocked — recover the worktree before retrying validation.',
        );
        throw new AutopodError(
          `Pod ${podId} worktree is compromised — recover it before validation`,
          'WORKTREE_COMPROMISED',
          409,
        );
      }

      const profile = profileStore.get(pod.profileName);

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
        const runtime = resolvePodRuntime(profile, pod.runtime, logger);
        const model = resolvePodModel(profile, pod.model, runtime, logger);
        podRepo.update(podId, {
          runtime,
          model,
          validationAttempts: 0,
          lastValidationResult: null,
          containerId: null,
          claudeSessionId: null,
          codexSessionId: null,
          recoveryWorktreePath: pod.worktreePath ?? null,
          reworkReason,
          reworkCount: (pod.reworkCount ?? 0) + 1,
          recoveryCount: 0,
          preSubmitReview: null,
        });
        transition(pod, 'queued');
        enqueueSession(podId);

        logger.info(
          {
            podId,
            worktreePath: pod.worktreePath,
            reworkReason,
            isInteractive,
            previousRuntime: pod.runtime,
            runtime,
            previousModel: pod.model,
            model,
          },
          'Rework: re-queued with fresh container provisioning',
        );
        return;
      }

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

      // Wake-recovery: don't burn a validation attempt for the involuntary restart.
      // The flag is one-shot — clear it so subsequent attempts in the same run increment normally.
      const isWakeRecovery = s1.lastRecoveryTrigger === 'wake';
      const attempt = isWakeRecovery
        ? s1.validationAttempts
        : (fromTerminal ? 0 : s1.validationAttempts) + 1;
      podRepo.update(podId, {
        ...(isWakeRecovery ? { lastRecoveryTrigger: null } : { validationAttempts: attempt }),
      });

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
            await syncWorkspaceBack(pod.containerId, pod.worktreePath, cm, podId);
          } catch (err) {
            logger.warn({ err, podId }, 'Failed to sync workspace before validation');
            validationSyncOk = await tryRecoverAfterWorkspaceSyncFailure(pod, err, 'validation');
          }
        }
        if (!validationSyncOk) {
          parkOnWorktreeSyncFailure(
            podId,
            'Workspace sync failed before validation — validation blocked.',
          );
          return;
        }

        // Get the actual diff and commit log for AI task review.
        // Always scope to the agent's own commits via startCommitSha. The reviewer
        // should only evaluate what this agent changed — pre-existing code on a
        // parent branch is not the agent's responsibility. Stats/file counts still
        // use the full branch diff (computed earlier) for accurate PR sizing.
        emitActivityStatus(podId, 'Computing diff…');
        const diffSinceCommit = pod.startCommitSha ?? undefined;
        const validationDefaultBranch = pod.baseBranch ?? profile.defaultBranch ?? 'main';
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
        assertProtectedOperationalPathsInScope(pod, diff);

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
          contract: pod.contract ?? undefined,
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
          advisoryBrowserQaEnabled: pod.options.advisoryBrowserQaEnabled ?? false,
          reviewerApiKey: process.env.ANTHROPIC_API_KEY,
          extraExecEnv: buildValidationExecEnv(
            profile.privateRegistries,
            profile.registryPat ?? profile.adoPat ?? null,
            profile.buildEnv,
          ),
          preSubmitReview: pod.preSubmitReview ?? undefined,
          skipPhases: profile.skipValidationPhases ?? undefined,
        };

        let result: Awaited<ReturnType<typeof validationEngine.validate>>;
        const validationController = new AbortController();
        validationAbortControllers.set(podId, validationController);
        try {
          result = await validationEngine.validate(
            validationConfig,
            (phase) => emitActivityStatus(podId, phase),
            validationController.signal,
            buildPhaseEventCallbacks(podId),
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
            ? 'Container exited before validation could run — check agent logs for errors'
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

        // Host browser facts write evidence directly to the host worktree. Collect
        // those screenshots before syncWorkspaceBack mirrors /workspace over it.
        if (pod.worktreePath && result.factValidation?.results.length && screenshotStore) {
          try {
            const screenshots = await collectFactScreenshots(
              pod.worktreePath,
              result.factValidation,
              screenshotStore,
              pod.id,
            );
            logger.info({ podId, count: screenshots.length }, 'Collected host fact screenshots');
          } catch (err) {
            logger.warn({ err, podId }, 'Failed to collect host fact screenshots');
          }
        }

        // Sync workspace after validation — screenshots and build artifacts are now in /workspace
        if (pod.containerId && pod.worktreePath) {
          try {
            const cm = containerManagerFactory.get(pod.executionTarget);
            await syncWorkspaceBack(pod.containerId, pod.worktreePath, cm, podId);
          } catch (err) {
            validationSyncOk = false;
            logger.warn({ err, podId }, 'Failed to sync workspace after validation');
          }
        }

        // Collect screenshots from the host worktree and write to the on-disk store
        if (pod.worktreePath && result.smoke.pages.length > 0 && screenshotStore) {
          try {
            const screenshots = await collectScreenshots(
              pod.worktreePath,
              result.smoke.pages,
              screenshotStore,
              pod.id,
              { allowedHostScreenshotDir: hostScreenshotDir?.(pod.id) },
            );
            for (const ss of screenshots) {
              const page = result.smoke.pages.find((p) => p.path === ss.pagePath);
              if (page) {
                page.screenshot = ss.ref;
              }
            }
            const missingCount = result.smoke.pages.filter(
              (p) => p.screenshotPath && !p.screenshot,
            ).length;
            if (missingCount > 0) {
              logger.warn(
                { podId, missingCount, collectedCount: screenshots.length },
                'Validation page screenshots were reported but not collected',
              );
            }
            logger.info({ podId, count: screenshots.length }, 'Collected validation screenshots');
          } catch (err) {
            logger.warn({ err, podId }, 'Failed to collect screenshots');
          }
        }

        if (pod.worktreePath && result.factValidation?.results.length && screenshotStore) {
          try {
            const screenshots = await collectFactScreenshots(
              pod.worktreePath,
              result.factValidation,
              screenshotStore,
              pod.id,
            );
            logger.info({ podId, count: screenshots.length }, 'Collected fact screenshots');
          } catch (err) {
            logger.warn({ err, podId }, 'Failed to collect fact screenshots');
          }
        }

        podRepo.update(podId, { lastValidationResult: result });

        // Accumulate phase-level token usage for harness cost attribution
        if (result.taskReview?.tokenUsage) {
          const currentPod = podRepo.getOrThrow(podId);
          const existing = currentPod.phaseTokenUsage ?? {};
          const prev = existing.review ?? { inputTokens: 0, outputTokens: 0 };
          podRepo.update(podId, {
            phaseTokenUsage: {
              ...existing,
              review: {
                inputTokens: prev.inputTokens + result.taskReview.tokenUsage.inputTokens,
                outputTokens: prev.outputTokens + result.taskReview.tokenUsage.outputTokens,
              },
            },
          });
        }

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
        emitActivityStatus(
          podId,
          `Validation ${result.overall} — ${summarizeValidationPhases(result)}`,
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
                  buildPhaseEventCallbacks(podId),
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
          const validationWaiver =
            result.overall === 'fail'
              ? buildValidationWaiver(result, 'Validation skipped by human toggle')
              : null;
          emitActivityStatus(
            podId,
            validationWaiver
              ? `Validation waived by human toggle — failed phases: ${validationWaiver.failedPhases.join(', ') || 'unknown'}`
              : 'Validation skipped by human toggle — marking as validated',
          );
          logger.info(
            { podId, attempt, validationWaiver },
            'skip_validation set mid-run — bypassing result',
          );
          pendingUpdateFromBaseIntents.delete(podId);
          const validatedPod = transition(
            s2,
            'validated',
            validationWaiver ? { validationWaiver } : undefined,
          );
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
                profile,
                podModel: pod.model,
              });
            } catch (err) {
              logger.warn({ err, podId }, 'Failed to push branch for PR');
              // Credential-class failures are recoverable: park the pod in
              // awaiting_input so the operator can update the PAT and resume,
              // instead of burning the validated work on a fixable error.
              if (err instanceof GitCredentialError) {
                parkOnCredentialFailure(podId, err);
                return;
              }
              if (handleDeletionGuardError(podId, err)) {
                const compromised = podRepo.getOrThrow(podId);
                if (compromised.status === 'validating') {
                  transition(compromised, 'failed');
                }
                return;
              }
              throw err;
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

            // Build screenshot refs for the PR body, provider-aware.
            // GitHub: embed raw GitHub URLs (committed screenshots on the branch).
            // ADO: pass stored on-disk refs so AdoPrManager can upload them as
            //      PR attachments and embed the returned attachment URLs instead
            //      of GitHub URLs that would 404 on ADO reviewers.
            const isAdoPod = profile.prProvider === 'ado';
            const repoUrlForScreenshots = profile.repoUrl;
            const screenshotRefs =
              !isAdoPod && repoUrlForScreenshots
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
            // Raw refs for ADO: page.screenshot is set by collectScreenshots above.
            const rawScreenshots = isAdoPod
              ? result.smoke.pages.flatMap((p) =>
                  p.screenshot != null ? [{ pagePath: p.path, ref: p.screenshot }] : [],
                )
              : undefined;

            if (!prUrl) {
              try {
                emitActivityStatus(podId, 'Creating PR…');
                const s3 = podRepo.getOrThrow(podId);
                warnIfSinglePrSeriesMissingSeriesMeta(s2, logger);
                const createResult = await prManager.createPr({
                  // biome-ignore lint/style/noNonNullAssertion: worktreePath is non-null here — PR creation only occurs for non-artifact pods which always have a worktree
                  worktreePath: s2.worktreePath!,
                  repoUrl: profile.repoUrl ?? undefined,
                  branch: s2.branch,
                  baseBranch: resolvePrBaseBranch(s2, profile),
                  podId,
                  task: s2.task,
                  profileName: s2.profileName,
                  profile,
                  podModel: s2.model,
                  handoffInstructions: s2.handoffInstructions ?? undefined,
                  validationResult: result,
                  validationWaiver: s3.validationWaiver,
                  filesChanged: s3.filesChanged,
                  linesAdded: s3.linesAdded,
                  linesRemoved: s3.linesRemoved,
                  previewUrl: s2.previewUrl,
                  screenshots: screenshotRefs,
                  rawScreenshots,
                  taskSummary: s3.taskSummary ?? undefined,
                  seriesDescription: s2.seriesDescription ?? undefined,
                  seriesName: s2.seriesName ?? undefined,
                  securityFindings: getLatestPushFindings(podId),
                });
                prUrl = createResult.url;
                if (createResult.usedFallback) {
                  const which = createResult.narrativeUsedFallback
                    ? createResult.titleUsedFallback
                      ? 'title + body'
                      : 'body'
                    : 'title';
                  const reason = createResult.fallbackReason ?? 'unknown';
                  logger.error(
                    {
                      podId,
                      profile: profile.name,
                      modelProvider: profile.modelProvider,
                      fallbackReason: reason,
                      fallbackDetail: createResult.fallbackDetail,
                    },
                    'PR description used template fallback during validation',
                  );
                  emitActivityStatus(podId, `PR ${which} used template fallback: ${reason}`);
                }
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
          // Validation completed before the abort signal landed — stale update-from-base
          // intent must not fire on a later revalidation for this pod.
          pendingUpdateFromBaseIntents.delete(podId);
          const validatedPod = transition(s2, 'validated', { prUrl });
          maybeTriggerDependents(validatedPod);

          // Fix pods don't own the PR — their parent does. Once a fix pod
          // validates, it rebases + pushes its branch and completes; the
          // parent's merge poller re-attempts the merge with the new commits.
          // This must run before the autoApprove check below: a fix pod must
          // never walk the normal approve/merge path.
          if (validatedPod.linkedPodId) {
            await completeFixPodAfterPush(validatedPod);
            return;
          }

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
          if (tryConsumeUpdateIntent()) return;

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
          await this.consumeAgentEvents(podId, events, attempt);
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
          if (tryConsumeUpdateIntent()) return;

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

        // Pod is still `validating`; runUpdateFromBaseAfterAbort handles status transitions.
        if (tryConsumeUpdateIntent()) return;

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
      options?: { force?: boolean },
    ): Promise<{ newCommits: boolean; result: 'pass' | 'fail' }> {
      const pod = podRepo.getOrThrow(podId);
      const force = options?.force ?? false;
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
      const revalidationWorktreePath = pod.worktreePath;
      let newCommits = false;
      const requeueValidationOnly = (message: string): { newCommits: boolean; result: 'fail' } => {
        emitActivityStatus(podId, message);
        podRepo.update(podId, {
          validationAttempts: 0,
          containerId: null,
          recoveryWorktreePath: revalidationWorktreePath,
          skipAgent: true,
          lastValidationResult: null,
        });
        transition(podRepo.getOrThrow(podId), 'queued');
        enqueueSession(podId);
        logger.info({ podId }, 'Revalidation queued with fresh container and skipAgent');
        return { newCommits, result: 'fail' };
      };

      const profile = profileStore.get(pod.profileName);
      // Pull latest from remote branch (human may have pushed fixes). Failures are
      // tolerated when force=true so a resume with no remote access (e.g. revoked
      // PAT) still reaches the validation engine on the existing worktree.
      emitActivityStatus(podId, 'Pulling latest changes from remote branch…');
      try {
        const pullResult = await worktreeManager.pullBranch(
          pod.worktreePath,
          selectGitPat(profile),
        );
        newCommits = pullResult.newCommits;
      } catch (err) {
        if (!force) throw err;
        logger.warn({ err, podId }, 'pullBranch failed — proceeding (force=true)');
        emitActivityStatus(podId, 'Could not pull from remote — revalidating local worktree');
      }

      // Without `force`, no-new-commits is a fast-fail: the only legitimate caller is
      // a human-fix workspace flow, where the human just pushed. With `force` (Resume),
      // the operator is asserting that the prior failure was infra/transient and wants
      // a fresh validation run against the same code.
      if (!newCommits && !force) {
        logger.info({ podId }, 'No new commits on branch — skipping revalidation');
        emitActivityStatus(podId, 'No new commits found — nothing to revalidate');
        return { newCommits: false, result: 'fail' };
      }
      if (!newCommits && force) {
        logger.info({ podId }, 'Resume: revalidating without new commits (force=true)');
        emitActivityStatus(podId, 'Resuming — revalidating with existing worktree');
      }

      logger.info({ podId }, 'New commits found — running revalidation');
      emitActivityStatus(podId, 'New commits detected — starting revalidation…');

      // Reset validation attempts for the fresh human-driven validation
      podRepo.update(podId, { validationAttempts: 0 });

      // Pre-push security scan: human-pushed fixes also need to clear the gate.
      await runPushCheckpointScan(pod, profile);

      // Transition to validating
      if (!pod.containerId && force) {
        return requeueValidationOnly(
          'Resume: container missing — re-provisioning for validation only',
        );
      }
      transition(pod, 'validating');

      // Re-run validation (force=true restarts container, but we don't want agent retry on failure)
      const attempt = 1;
      podRepo.update(podId, { validationAttempts: attempt });

      // Reset the desktop Validation tab chips for this fresh attempt — without this,
      // the UI keeps the previous run's stale ValidationProgress.
      eventBus.emit({
        type: 'pod.validation_started',
        timestamp: new Date().toISOString(),
        podId,
        attempt,
      });

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
            if (force) {
              transition(podRepo.getOrThrow(podId), 'failed');
              return requeueValidationOnly(
                'Resume: container no longer exists — re-provisioning for validation only',
              );
            }
            throw new AutopodError(
              `Container for pod ${podId} no longer exists — use "Retry" to re-provision`,
              'CONTAINER_NOT_FOUND',
              409,
            );
          }
          throw err;
        }

        const revalDefaultBranch = pod.baseBranch ?? profile.defaultBranch ?? 'main';
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
        assertProtectedOperationalPathsInScope(pod, diff);

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
              contract: pod.contract ?? undefined,
              codeReviewSkill,
              commitLog: commitLog || undefined,
              plan: pod.plan ?? undefined,
              taskSummary: pod.taskSummary ?? undefined,
              worktreePath: pod.worktreePath ?? undefined,
              startCommitSha: pod.startCommitSha ?? undefined,
              hasWebUi: profile.hasWebUi ?? true,
              advisoryBrowserQaEnabled: pod.options.advisoryBrowserQaEnabled ?? false,
              preSubmitReview: pod.preSubmitReview ?? undefined,
              skipPhases: profile.skipValidationPhases ?? undefined,
            },
            (phase) => emitActivityStatus(podId, phase),
            revalidateController.signal,
            buildPhaseEventCallbacks(podId),
          );
        } catch (validateErr) {
          logger.error({ err: validateErr, podId }, 'Revalidation engine threw unexpectedly');
          const isContainerStopped =
            validateErr instanceof Error &&
            (validateErr.message.includes('container stopped/paused') ||
              (validateErr as NodeJS.ErrnoException & { statusCode?: number }).statusCode === 409);
          const buildOutput = isContainerStopped
            ? 'Container exited before validation could run — check agent logs for errors'
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

        // Accumulate phase-level token usage for harness cost attribution
        if (result.taskReview?.tokenUsage) {
          const currentPod = podRepo.getOrThrow(podId);
          const existingUsage = currentPod.phaseTokenUsage ?? {};
          const prevReview = existingUsage.review ?? { inputTokens: 0, outputTokens: 0 };
          podRepo.update(podId, {
            phaseTokenUsage: {
              ...existingUsage,
              review: {
                inputTokens: prevReview.inputTokens + result.taskReview.tokenUsage.inputTokens,
                outputTokens: prevReview.outputTokens + result.taskReview.tokenUsage.outputTokens,
              },
            },
          });
        }

        validationRepo?.insert(podId, attempt, result);

        eventBus.emit({
          type: 'pod.validation_completed',
          timestamp: new Date().toISOString(),
          podId,
          result,
        });

        const s2 = podRepo.getOrThrow(podId);

        if (isTerminalState(s2.status) || s2.status === 'killing') {
          return { newCommits, result: 'fail' };
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
                profile,
                podModel: pod.model,
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
                const createResult = await prManager.createPr({
                  // biome-ignore lint/style/noNonNullAssertion: worktreePath is non-null here — PR creation only occurs for non-artifact pods which always have a worktree
                  worktreePath: s2.worktreePath!,
                  repoUrl: profile.repoUrl ?? undefined,
                  branch: s2.branch,
                  baseBranch: resolvePrBaseBranch(s2, profile),
                  podId,
                  task: s2.task,
                  profileName: s2.profileName,
                  profile,
                  podModel: s2.model,
                  handoffInstructions: s2.handoffInstructions ?? undefined,
                  validationResult: result,
                  validationWaiver: s3.validationWaiver,
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
                prUrl = createResult.url;
                if (createResult.usedFallback) {
                  const which = createResult.narrativeUsedFallback
                    ? createResult.titleUsedFallback
                      ? 'title + body'
                      : 'body'
                    : 'title';
                  const reason = createResult.fallbackReason ?? 'unknown';
                  logger.error(
                    {
                      podId,
                      profile: profile.name,
                      modelProvider: profile.modelProvider,
                      fallbackReason: reason,
                      fallbackDetail: createResult.fallbackDetail,
                    },
                    'PR description used template fallback during revalidation',
                  );
                  emitActivityStatus(podId, `PR ${which} used template fallback: ${reason}`);
                }
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

          return { newCommits, result: 'pass' };
        }

        // Validation failed — stay in failed state, no agent rework
        emitActivityStatus(podId, `Revalidation fail — ${summarizeValidationPhases(result)}`);
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

        return { newCommits, result: 'fail' };
      } catch (err) {
        logger.error({ err, podId }, 'Revalidation error');
        const s2 = podRepo.getOrThrow(podId);
        transition(s2, 'failed');
        return { newCommits, result: 'fail' };
      }
    },

    fixManually(podId: string, userId: string, creator?: PodCreator): Pod {
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
        creator,
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

      // Cap cleanup so a hung Docker stop or slow worktree rm-rf can't blow
      // past the desktop's 30s URLSession timeout and leave the pod undeletable.
      // Mirror killSession's pattern: best-effort cleanup, always finalize the row.
      const DELETE_TIMEOUT_MS = 25_000;
      const cleanup = async () => {
        try {
          await killSidecarsForPod(podId);
        } catch (err) {
          logger.warn({ err, podId }, 'Failed to kill sidecars during delete');
        }
        try {
          await cleanupTestRunBranches(podId);
        } catch (err) {
          logger.warn({ err, podId }, 'Failed to cleanup test branches during delete');
        }
        if (pod.containerId) {
          try {
            const cm = containerManagerFactory.get(pod.executionTarget);
            await cm.kill(pod.containerId);
          } catch (err) {
            logger.warn({ err, podId }, 'Failed to kill container during delete');
          }
        }
        try {
          await destroyPodNetwork(podId);
        } catch (err) {
          logger.warn({ err, podId }, 'Failed to destroy network during delete');
        }
        if (pod.worktreePath) {
          try {
            await worktreeManager.cleanup(pod.worktreePath);
          } catch (err) {
            logger.warn({ err, podId }, 'Failed to cleanup worktree during delete');
          }
        }
        const runtimeStateDirs: Partial<Record<string, (id: string) => Promise<void>>> = {
          claude: cleanupClaudeState,
          codex: cleanupCodexState,
        };
        await runtimeStateDirs[pod.runtime]?.(podId)?.catch((err) => {
          logger.warn({ err, podId }, `Failed to cleanup ${pod.runtime} state dir during delete`);
        });
      };

      await Promise.race([
        cleanup(),
        new Promise<void>((resolve) =>
          setTimeout(() => {
            logger.warn({ podId }, 'Delete cleanup timed out — finalizing');
            resolve();
          }, DELETE_TIMEOUT_MS),
        ),
      ]);

      pendingUpdateFromBaseIntents.delete(podId);
      forceWithLeaseAllowances.delete(podId);
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

      if (status === 'unknown') {
        throw new AutopodError(
          `Container for pod ${podId} has been removed — cannot start preview`,
          'INVALID_STATE',
          409,
        );
      }

      const profile = profileStore.get(pod.profileName);

      if (status === 'running') {
        // Container is running. Check if the supervisor is already alive — if so
        // return immediately without re-spawning (idempotent against a second
        // startPreview call while validation is running the supervisor).
        if (profile.startCommand) {
          const supervisorAlive = await (async () => {
            try {
              const pidResult = await cm.execInContainer(
                pod.containerId,
                ['sh', '-c', 'cat /tmp/autopod-supervisor.pid 2>/dev/null'],
                {},
              );
              const pid = pidResult.stdout.trim();
              if (!pid) return false;
              const liveness = await cm.execInContainer(
                pod.containerId,
                ['sh', '-c', `kill -0 ${pid} 2>/dev/null && echo 1 || echo 0`],
                {},
              );
              return liveness.stdout.trim() === '1';
            } catch {
              return false;
            }
          })();

          if (supervisorAlive) {
            schedulePreviewAutoStop(podId, pod.containerId, pod.executionTarget);
            logger.info({ podId }, 'Supervisor already running — reusing existing preview');
            return { previewUrl: pod.previewUrl };
          }

          // Supervisor is dead — (re)spawn it
          cm.execInContainer(
            pod.containerId,
            ['sh', '-c', buildSupervisorCommand(profile.startCommand)],
            { cwd: '/workspace' },
          ).catch((err) => {
            logger.warn({ err, podId }, 'Preview supervisor start errored');
          });
        }

        schedulePreviewAutoStop(podId, pod.containerId, pod.executionTarget);
        logger.info({ podId, previewUrl: pod.previewUrl }, 'Preview started');
        return { previewUrl: pod.previewUrl };
      }

      // Container is stopped — start it
      await cm.start(pod.containerId);

      // Re-run the start command under the supervisor and wait for health check
      if (profile.startCommand) {
        cm.execInContainer(
          pod.containerId,
          ['sh', '-c', buildSupervisorCommand(profile.startCommand)],
          { cwd: '/workspace' },
        ).catch((err) => {
          logger.warn(
            { err, podId },
            'Preview supervisor start command errored (may be expected for long-running processes)',
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

    async previewStatus(podId: string): Promise<{
      running: boolean;
      reachable: boolean;
      restartCount: number;
      lastError: string | null;
      previewUrl: string | null;
    }> {
      const pod = podRepo.getOrThrow(podId);
      const safeDefaults = {
        running: false,
        reachable: false,
        restartCount: 0,
        lastError: null,
        previewUrl: pod.previewUrl,
      };

      if (!pod.containerId || !pod.previewUrl) return safeDefaults;

      const cm = containerManagerFactory.get(pod.executionTarget);

      // If the container is not running, the supervisor is definitely not alive.
      try {
        const containerStatus = await cm.getStatus(pod.containerId);
        if (containerStatus !== 'running') return safeDefaults;
      } catch {
        return safeDefaults;
      }

      // Exec four parallel reads inside the container + HTTP probe from the host.
      const [pidResult, restartCountResult, logTailResult, httpProbeResult] = await Promise.all([
        cm
          .execInContainer(
            pod.containerId,
            ['sh', '-c', 'cat /tmp/autopod-supervisor.pid 2>/dev/null'],
            {},
          )
          .catch(() => null),
        cm
          .execInContainer(
            pod.containerId,
            ['sh', '-c', 'cat /tmp/autopod-restart-count 2>/dev/null'],
            {},
          )
          .catch(() => null),
        cm
          .execInContainer(
            pod.containerId,
            ['sh', '-c', 'tail -c 200 /tmp/autopod-start.log 2>/dev/null'],
            {},
          )
          .catch(() => null),
        fetch(pod.previewUrl, { signal: AbortSignal.timeout(3_000) })
          .then((r) => r.status)
          .catch(() => null),
      ]);

      // Check PID liveness: if we got a PID string, verify the process is still alive.
      const rawPid = pidResult?.stdout?.trim() ?? null;
      let alivePid: string | null = null;
      if (rawPid) {
        try {
          const check = await cm.execInContainer(
            pod.containerId,
            ['sh', '-c', `kill -0 ${rawPid} 2>/dev/null && echo 1 || echo 0`],
            {},
          );
          alivePid = check.stdout.trim() === '1' ? rawPid : null;
        } catch {
          alivePid = null;
        }
      }

      const status = parseStatus({
        pid: alivePid,
        restartCount: restartCountResult?.stdout ?? null,
        startLogTail: logTailResult?.stdout ?? null,
        reachableHttp: typeof httpProbeResult === 'number' ? httpProbeResult : null,
      });

      return { ...status, previewUrl: pod.previewUrl };
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
            if (isSinglePrSeriesPod(dep)) {
              return parent.status === 'complete';
            }
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
          const baseBranch =
            isSinglePrSeriesPod(dep) || dep.waitForMerge || dep.branch === firstParent.branch
              ? (firstParent.baseBranch ?? 'main')
              : firstParent.branch;
          podRepo.update(dep.id, {
            baseBranch,
            dependencyStartedAt: new Date().toISOString(),
          });
          enqueueSession(dep.id);
          logger.info(
            { podId: dep.id, firstParentId, baseBranch },
            'Series: rehydrated stuck dependent pod',
          );
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
      const allowed =
        pod.status === 'failed' ||
        pod.status === 'review_required' ||
        pod.status === 'awaiting_input';
      if (!allowed) {
        throw new AutopodError(
          `Cannot force-approve pod ${podId} in status ${pod.status} — only failed, review_required, or awaiting_input pods`,
          'INVALID_STATE',
          409,
        );
      }
      const note = reason
        ? `[FORCE APPROVED] ${reason}`
        : '[FORCE APPROVED] Human overrode validation — no further agent run needed';
      const validationWaiver =
        pod.lastValidationResult?.overall === 'fail'
          ? buildValidationWaiver(pod.lastValidationResult, reason)
          : null;
      podRepo.update(podId, {
        lastCorrectionMessage: note,
        ...(validationWaiver ? { validationWaiver } : {}),
      });

      // Resolve any pending escalation so it doesn't dangle in the audit trail
      // and pendingEscalation gets cleared on the transition.
      const updates: Partial<PodUpdates> = {};
      if (pod.pendingEscalation) {
        escalationRepo.update(pod.pendingEscalation.id, {
          respondedAt: new Date().toISOString(),
          respondedBy: 'human',
          response: `[force-approve] ${reason ?? 'human override'}`,
        });
        updates.pendingEscalation = null;
      }
      const approvedPod = transition(pod, 'validated', updates);
      emitActivityStatus(
        podId,
        validationWaiver
          ? `Force approved with validation waiver — failed phases: ${validationWaiver.failedPhases.join(', ') || 'unknown'}`
          : 'Force approved — validation bypassed by human',
      );
      logger.info(
        { podId, reason, validationWaiver },
        'Pod force-approved, transitioning to validated',
      );
      maybeTriggerDependents(approvedPod);
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
      // Clear stale fixPodId so the next poll can spawn freely.
      // Skip the clear when `reuseFixPod` is enabled — that path INTENTIONALLY
      // wants to find the previous (terminal-state) fix pod and re-enqueue it
      // instead of spawning a new child, preserving the one-fix-pod-per-PR
      // invariant the user sees in the UI.
      const profile = profileStore.get(pod.profileName);
      const updates: PodUpdates = { maxPrFixAttempts: newMax };
      if (profile.reuseFixPod !== true) {
        updates.fixPodId = null;
      }
      podRepo.update(podId, updates);
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

    async updateFromBase(podId: string): Promise<UpdateFromBaseResponse> {
      const pod = podRepo.getOrThrow(podId);

      const eligibleStatuses = ['validating', 'failed', 'review_required'] as const;
      if (!(eligibleStatuses as readonly string[]).includes(pod.status)) {
        throw new AutopodError(
          `Cannot run update-from-base on pod ${podId} in status '${pod.status}'`,
          'INVALID_STATE',
          409,
        );
      }

      if (!pod.worktreePath) {
        throw new AutopodError(
          `Pod ${podId} has no worktree — cannot update from base`,
          'INVALID_STATE',
          400,
        );
      }

      if (pod.worktreeCompromised) {
        throw new AutopodError(
          `Pod ${podId} worktree is compromised — recover it before updating from base`,
          'WORKTREE_COMPROMISED',
          409,
        );
      }

      // For validating pods: store the intent, abort current validation, return immediately.
      // The validation unwind (retry or catch path) consumes the intent and runs the rebase.
      if (pod.status === 'validating') {
        pendingUpdateFromBaseIntents.add(podId);
        validationAbortControllers.get(podId)?.abort();
        return { ok: true, action: 'queued_after_abort' };
      }

      // For failed / review_required pods: run the rebase directly.
      const profile = profileStore.get(pod.profileName);
      const baseBranch = pod.baseBranch ?? profile.defaultBranch ?? 'main';

      emitActivityStatus(podId, `Update from base: rebasing onto '${baseBranch}'…`);

      const rebaseResult = await worktreeManager.rebaseOntoBase({
        worktreePath: pod.worktreePath,
        baseBranch,
        pat: selectGitPat(profile),
      });

      if (rebaseResult.alreadyUpToDate) {
        emitActivityStatus(podId, `Branch already up to date with '${baseBranch}'`);
        return { ok: true, action: 'already_up_to_date', baseBranch };
      }

      if (!rebaseResult.rebased) {
        emitActivityStatus(
          podId,
          `Rebase conflict with '${baseBranch}': ${rebaseResult.conflicts.join(', ')}`,
        );
        return { ok: false, action: 'conflict', baseBranch, conflicts: rebaseResult.conflicts };
      }

      // Clean rebase: mark for force-with-lease, reset attempts, start validation async.
      emitActivityStatus(podId, `Rebased onto '${baseBranch}' — starting validation…`);
      forceWithLeaseAllowances.add(podId);
      podRepo.update(podId, { validationAttempts: 0 });
      setImmediate(() => {
        this.triggerValidation(podId).catch((e: unknown) =>
          logger.error({ err: e, podId }, 'update-from-base follow-up validation failed'),
        );
      });

      return { ok: true, action: 'rebased', baseBranch, validation: 'started' };
    },

    setSkipValidation(podId: string, skip: boolean): void {
      const pod = podRepo.getOrThrow(podId);
      podRepo.update(podId, { skipValidation: skip });
      const msg = skip
        ? 'Skip-validation toggled on — next validation result will be bypassed'
        : 'Skip-validation toggled off — validation will run normally';
      emitActivityStatus(podId, msg);
      logger.info({ podId, skip }, 'skip_validation updated by user');

      // Pods parked in awaiting_input on a validation_override escalation never
      // re-enter the validation flow on their own — the flag alone leaves them
      // hung. Treat skip=true as "I don't care about validation, just approve":
      // resolve the escalation and transition straight to validated.
      if (
        skip &&
        pod.status === 'awaiting_input' &&
        pod.pendingEscalation?.type === 'validation_override'
      ) {
        const escalationId = pod.pendingEscalation.id;
        escalationRepo.update(escalationId, {
          respondedAt: new Date().toISOString(),
          respondedBy: 'human',
          response: '[skip-validation] dismissed by human',
        });
        const validationWaiver =
          pod.lastValidationResult?.overall === 'fail'
            ? buildValidationWaiver(
                pod.lastValidationResult,
                'Validation skipped — recurring findings dismissed by human',
              )
            : null;
        const updated = transition(pod, 'validated', {
          pendingEscalation: null,
          ...(validationWaiver ? { validationWaiver } : {}),
        });
        emitActivityStatus(
          podId,
          validationWaiver
            ? 'Validation waived — recurring findings dismissed by human'
            : 'Validation skipped — recurring findings dismissed by human',
        );
        logger.info(
          { podId, escalationId },
          'skip_validation resolved validation_override escalation',
        );
        maybeTriggerDependents(updated);
      }
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
            const netConfig = await networkManager.buildNetworkConfig(
              profile.networkPolicy,
              mergedServers,
              gatewayIp,
              profile.privateRegistries,
              pod.id,
              sidecarIps,
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

    /**
     * Thin wrapper over the queue-driven fix-pod model: validate the parent is
     * eligible, enqueue the feedback message, and let `maybeSpawnFixSession`
     * decide whether to spawn/recycle. The task itself is built from the
     * drained queue when the fix pod transitions to `running`.
     */
    async spawnFixSession(podId: string, userMessage?: string): Promise<void> {
      const pod = podRepo.getOrThrow(podId);
      // Fix pods are tied to a `merge_pending` parent whose poller owns the
      // actual PR merge. A terminal parent (complete/failed/killed) has a
      // stopped poller — there is nothing left to drive the merge, so spawning
      // a fix pod for it would strand the fix pod's commits.
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

      const message = userMessage?.trim() || 'Manual fix pod spawn — address the PR feedback.';
      fixFeedbackRepo.enqueue(podId, message);

      const status: PrMergeStatus = {
        merged: false,
        open: true,
        blockReason: pod.mergeBlockReason ?? 'PR needs fixes',
        ciFailures: [],
        reviewComments: [],
      };
      await maybeSpawnFixSession(podId, status);
      logger.info(
        { podId, hasUserMessage: Boolean(userMessage) },
        'Manual fix pod spawn triggered',
      );
    },

    async requestFixSession(podId: string, message: string): Promise<SpawnFixResponse> {
      // getOrThrow surfaces PodNotFoundError → 404 at the route layer.
      const pod = podRepo.getOrThrow(podId);
      if (pod.linkedPodId) {
        throw new AutopodError(
          `Pod ${podId} is a fix pod — only root pods can spawn fixers`,
          'INVALID_STATE',
          409,
        );
      }
      // A terminal parent has nothing left to fix — report it as a structured
      // result, not an exception, so the API can return a clean 409 body.
      if (isFixCycleTerminal(pod.status)) {
        return { ok: false, reason: 'parent_terminal' };
      }

      fixFeedbackRepo.enqueue(podId, message);

      const status: PrMergeStatus = {
        merged: false,
        open: true,
        blockReason: pod.mergeBlockReason ?? 'PR needs fixes',
        ciFailures: [],
        reviewComments: [],
      };
      await maybeSpawnFixSession(podId, status);

      const updated = podRepo.getOrThrow(podId);
      // maybeSpawnFixSession fails the parent when the PR-fix attempt cap is
      // exhausted. A now-terminal parent is reported the same way as one that
      // was already terminal on entry — there is nothing left to fix.
      if (isFixCycleTerminal(updated.status)) {
        return { ok: false, reason: 'parent_terminal' };
      }
      const queueLength = fixFeedbackRepo.count(podId);
      return {
        ok: true,
        queued: queueLength > 0,
        queueLength,
        fixPodId: updated.fixPodId ?? null,
      };
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
      emitActivityStatus(podId, 'Retrying PR creation…');
      const newPrUrl = await pushAndCreatePr(pod, 'retryCreatePr');
      podRepo.update(podId, { prUrl: newPrUrl });
      emitActivityStatus(podId, `PR created: ${newPrUrl}`);
      logger.info({ podId, prUrl: newPrUrl }, 'PR created via retryCreatePr');
    },

    async resumePod(podId: string): Promise<{ action: 'retry-pr' | 'revalidate' }> {
      const pod = podRepo.getOrThrow(podId);
      if (pod.status !== 'failed') {
        throw new AutopodError(
          `Cannot resume pod ${podId} in status ${pod.status} — only failed pods can be resumed`,
          'INVALID_STATE',
          409,
        );
      }
      if (!pod.worktreePath) {
        throw new AutopodError(
          `Pod ${podId} has no worktree — cannot resume`,
          'INVALID_STATE',
          409,
        );
      }
      if (pod.worktreeCompromised) {
        throw new AutopodError(
          `Pod ${podId} worktree is marked compromised — recover the worktree before resuming`,
          'WORKTREE_COMPROMISED',
          409,
        );
      }

      // Path 1: validation already passed, downstream step (push / PR) blew up.
      // Push + open PR, no agent rework, no validation rerun. Cheapest possible recovery.
      if (pod.lastValidationResult?.overall === 'pass' && !pod.prUrl) {
        emitActivityStatus(podId, 'Resume: pushing branch + opening PR…');
        const newPrUrl = await pushAndCreatePr(pod, 'resume');
        // Transition the pod from `failed → validated` so it rejoins the normal
        // approval flow. The validation result on the pod is already the passing
        // one captured pre-push; no need to overwrite it.
        const refreshed = podRepo.getOrThrow(podId);
        const validated = transition(refreshed, 'validated', { prUrl: newPrUrl });
        emitActivityStatus(podId, `Resume succeeded — PR ready: ${newPrUrl}`);
        logger.info({ podId, prUrl: newPrUrl }, 'Pod resumed via push + PR');
        if (validated.autoApprove) {
          setImmediate(() => {
            this.approveSession(podId).catch((err) =>
              logger.warn({ err, podId }, 'Auto-approve failed after resume'),
            );
          });
        }
        return { action: 'retry-pr' };
      }

      // Path 2: validation didn't pass (or never ran). Re-run validation only —
      // no agent rework. force=true skips the no-new-commits gate so a Resume
      // works even when the worktree wasn't touched between attempts.
      if (pod.prUrl) {
        emitActivityStatus(podId, 'Resume: PR already exists — re-running validation only');
      } else {
        emitActivityStatus(podId, 'Resume: re-running validation (no agent rework)');
      }
      await this.revalidateSession(podId, { force: true });
      return { action: 'revalidate' };
    },

    async forceComplete(podId: string, reason?: string): Promise<void> {
      const pod = podRepo.getOrThrow(podId);
      if (pod.status === 'complete') {
        throw new AutopodError(`Pod ${podId} is already complete`, 'INVALID_STATE', 409);
      }
      if (pod.status !== 'failed') {
        throw new AutopodError(
          `Cannot force-complete pod ${podId} in status ${pod.status} — only failed pods are eligible`,
          'INVALID_STATE',
          409,
        );
      }

      // Force-complete is terminal — kill+remove the container so it doesn't
      // linger as a stopped record in Docker. Bounded so a wedged engine can't
      // hang the operator endpoint.
      await cleanupContainer(pod, 'force-complete');

      const trimmedReason = reason?.trim() || null;
      const now = new Date().toISOString();
      podRepo.update(podId, {
        forceCompletedAt: now,
        forceCompletedReason: trimmedReason,
      });
      transition(pod, 'complete');
      emitActivityStatus(
        podId,
        trimmedReason
          ? `Force-completed by operator: ${trimmedReason}`
          : 'Force-completed by operator',
      );
      logger.warn(
        { podId, reason: trimmedReason },
        'Pod force-completed by operator (admin override — push/PR/merge skipped)',
      );

      // Series children that were waiting on this pod must be triggered just
      // like a normal completion — otherwise the entire downstream series
      // stalls in `queued` forever and the operator has to manually `kick`
      // each dependent. The whole point of force-complete is to unstick a
      // series, so silently failing to advance it is a footgun.
      const completedPod = podRepo.getOrThrow(podId);
      maybeTriggerDependents(completedPod);
    },

    async kickPod(podId: string, reason?: string): Promise<{ action: 'requeued' | 'failed' }> {
      const pod = podRepo.getOrThrow(podId);
      const trimmedReason = reason?.trim() || null;
      const nowIso = new Date().toISOString();

      if (pod.status === 'queued') {
        // A pod that has been in `queued` long enough for an operator to kick is
        // past any live processPod (status would have moved to provisioning). If the
        // queue still tracks it as active, that's a stale entry from a previous run
        // whose finally never ran — clear it so the upcoming enqueue isn't silently
        // dedup'd. Without this, the kick endpoint reports success but the pod sits
        // forever because `enqueue`'s `activeIds.has(podId)` check returns true.
        const cleared = clearStuckQueueEntry?.(podId) ?? false;
        podRepo.update(podId, { kickedAt: nowIso, kickedReason: trimmedReason });
        enqueueSession(podId);
        emitActivityStatus(
          podId,
          trimmedReason ? `Re-enqueued by operator: ${trimmedReason}` : 'Re-enqueued by operator',
        );
        logger.warn(
          { podId, reason: trimmedReason, clearedStuckEntry: cleared },
          'Pod kicked by operator — re-enqueued from queued',
        );
        return { action: 'requeued' };
      }

      if (pod.status === 'running' || pod.status === 'provisioning') {
        // Bounded — the whole point of kick is to free a slot when something
        // upstream (often Docker itself) is wedged. The transition to `failed`
        // must not depend on Docker cooperating. Mode='stop' so a subsequent
        // `resume` can still restart the same container if Docker recovers.
        await cleanupContainer(pod, 'kick', 'stop');
        podRepo.update(podId, { kickedAt: nowIso, kickedReason: trimmedReason });
        transition(pod, 'failed', { completedAt: nowIso });
        emitActivityStatus(
          podId,
          trimmedReason
            ? `Kicked by operator (force-failed): ${trimmedReason}`
            : 'Kicked by operator (force-failed)',
        );
        logger.warn(
          { podId, previousStatus: pod.status, reason: trimmedReason },
          'Pod kicked by operator — transitioned to failed',
        );
        return { action: 'failed' };
      }

      throw new AutopodError(
        `Cannot kick pod ${podId} in status ${pod.status} — only queued/running/provisioning are eligible`,
        'INVALID_STATE',
        409,
      );
    },

    startStuckPodWatchdog(options?: { intervalMs?: number; thresholdMs?: number }): void {
      if (stuckPodWatchdog) return; // idempotent
      const intervalMs = options?.intervalMs ?? 60_000;
      const thresholdMs =
        options?.thresholdMs ??
        (process.env.AUTOPOD_STUCK_RUNNING_THRESHOLD_MS
          ? Number(process.env.AUTOPOD_STUCK_RUNNING_THRESHOLD_MS)
          : 30 * 60 * 1_000);

      const WAKE_GRACE_MS = 60_000;
      let lastWakeAt: number | null = null;

      const tick = async (): Promise<void> => {
        try {
          const sinceWakeMs = lastWakeAt !== null ? Date.now() - lastWakeAt : null;
          if (sinceWakeMs !== null && sinceWakeMs < WAKE_GRACE_MS) {
            logger.debug({ sinceWakeMs }, 'Watchdog: skipping tick during wake grace window');
            return;
          }
          const running = podRepo.list({ status: 'running' as PodStatus });
          const now = Date.now();
          for (const pod of running) {
            // Workspace (interactive) pods have no agent by design — the human
            // drives the container directly. They will never emit agent events,
            // so silence-based timeout cannot apply.
            if (pod.options?.agentMode === 'interactive') continue;
            // Reference is the most recent of (lastAgentEventAt, startedAt) —
            // both are real liveness signals scoped to the current run.
            // `startedAt` is reset on every transition into provisioning, so it
            // acts as a freshness floor that prevents a stale `lastAgentEventAt`
            // (from a prior life of the same pod, e.g. across recovery) from
            // dragging the reference back across the threshold.
            // Fall back to updatedAt/createdAt only when both primary signals
            // are missing (pods predating the migration that added these fields).
            const primary = [pod.lastAgentEventAt, pod.startedAt]
              .filter((t): t is string => typeof t === 'string')
              .map((t) => new Date(t).getTime())
              .filter((ms) => !Number.isNaN(ms));
            let refMs: number;
            if (primary.length > 0) {
              refMs = Math.max(...primary);
            } else {
              const fallback = pod.updatedAt ?? pod.createdAt;
              refMs = new Date(fallback).getTime();
              if (Number.isNaN(refMs)) continue;
            }
            const ageMs = now - refMs;
            if (ageMs < thresholdMs) continue;

            logger.warn(
              { podId: pod.id, ageMs, thresholdMs },
              'Watchdog: running pod has gone silent — transitioning to failed',
            );
            if (pod.containerId) {
              try {
                const cm = containerManagerFactory.get(pod.executionTarget);
                await cm.stop(pod.containerId);
              } catch (err) {
                logger.warn({ err, podId: pod.id }, 'Watchdog: failed to stop container');
              }
            }
            try {
              const fresh = podRepo.getOrThrow(pod.id);
              if (fresh.status !== 'running') continue; // raced with another transition
              transition(fresh, 'failed', { completedAt: new Date(now).toISOString() });
              emitActivityStatus(pod.id, 'Watchdog: no agent activity — pod auto-failed');
            } catch (err) {
              logger.warn({ err, podId: pod.id }, 'Watchdog: transition to failed failed');
            }
          }
        } catch (err) {
          logger.warn({ err }, 'Stuck-pod watchdog tick failed');
        }
      };

      stuckPodWatchdog = setInterval(() => {
        void tick();
      }, intervalMs);
      logger.info({ intervalMs, thresholdMs }, 'Stuck-pod watchdog started');

      // Wake-recovery: subscribe to host.resumed, reconcile local pods, then re-publish
      // a richer event (with reconciledPodIds) for the desktop banner.
      // De-dupe by source timestamp so the re-published event doesn't trigger a second
      // reconcile (even when 0 pods are recovered and reconciledPodIds:[] is ambiguous).
      // Bounded at 256 entries — one per wake event — resets on overflow.
      const processedWakeTimestamps = new Set<string>();
      unsubscribeWakeRecovery = eventBus.subscribe((event) => {
        if (event.type !== 'host.resumed') return;
        // Update before the dedupe check so every host.resumed (including the
        // re-published completed event) refreshes the grace window.
        lastWakeAt = Date.now();
        if (processedWakeTimestamps.has(event.timestamp)) return;
        if (processedWakeTimestamps.size >= 256) processedWakeTimestamps.clear();
        processedWakeTimestamps.add(event.timestamp);

        const { sleptMs, detector, timestamp } = event;
        logger.info({ sleptMs, detector }, 'Host wake detected — reconciling local sessions');

        void (async () => {
          try {
            const result = await reconcileLocalSessions({
              podRepo,
              eventBus,
              containerManager: containerManagerFactory.get('local'),
              enqueueSession,
              validationRepo,
              logger,
              trigger: 'wake',
            });
            logger.info(
              { recovered: result.recovered, killed: result.killed, sleptMs },
              'Wake reconcile complete',
            );
            // Re-publish with reconciledPodIds populated so the desktop banner shows counts.
            // Use the original timestamp so the processedWakeTimestamps guard suppresses the
            // subscriber from firing again (handles the 0-recovered edge case).
            eventBus.emit({
              type: 'host.resumed',
              timestamp,
              sleptMs,
              detector,
              reconciledPodIds: result.recovered,
            });
          } catch (err) {
            logger.error({ err, sleptMs }, 'Wake reconcile failed');
          }
        })();
      });
    },

    stopStuckPodWatchdog(): void {
      if (stuckPodWatchdog) {
        clearInterval(stuckPodWatchdog);
        stuckPodWatchdog = null;
      }
      if (unsubscribeWakeRecovery) {
        unsubscribeWakeRecovery();
        unsubscribeWakeRecovery = null;
      }
    },

    async recoverWorktree(podId: string): Promise<{
      recovered: boolean;
      message: string;
      blockers?: Array<{ status: string; path: string }>;
    }> {
      const pod = podRepo.getOrThrow(podId);
      if (!pod.worktreeCompromised) {
        throw new AutopodError(
          `Pod ${podId} worktree is not compromised — nothing to recover`,
          'INVALID_STATE',
          409,
        );
      }
      if (!pod.worktreePath) {
        return {
          recovered: false,
          message: 'Pod has no worktree — manual extraction needed',
        };
      }

      // Path A — container is alive: pull /workspace from the live container,
      // overwrite the partial host worktree, then auto-commit. Most powerful
      // recovery because it captures any uncommitted state still inside the
      // container's overlayfs.
      if (pod.containerId) {
        const cm = containerManagerFactory.get(pod.executionTarget);
        const recovered = await recoverWorktreeFromContainer(
          pod.containerId,
          pod.worktreePath,
          cm,
          pod.id,
        );
        if (recovered) {
          try {
            const profileForRecovery = profileStore.get(pod.profileName);
            await worktreeManager.commitPendingChangesWithGeneratedMessage(
              pod.worktreePath,
              pod.task,
              profileForRecovery,
              pod.model,
              { maxDeletions: 100 },
            );
            podRepo.update(podId, { worktreeCompromised: false });
            emitActivityStatus(
              podId,
              'Worktree recovered from container and committed successfully',
            );
            return { recovered: true, message: 'Worktree recovered and committed' };
          } catch (err) {
            return {
              recovered: false,
              message: `Recovery failed at commit stage: ${err instanceof Error ? err.message : String(err)}`,
            };
          }
        }
        // Live recovery failed — fall through to the bare-repo path. The
        // agent's commits may still be on the bare from a successful
        // in-container push during the original sync-back attempt.
        logger.info(
          { podId },
          'Live container recovery failed — trying bare-repo restore fallback',
        );
      }

      // Path B — no container (or live recovery failed): the agent's commits
      // are typically already on the bare via the in-container `git push` step
      // of syncWorkspaceBack, even when the file-copy half timed out. The host
      // worktree's HEAD/index point at those commits — only working-tree files
      // are stale on disk. `restoreFromHead` is gated on recoverable tracked-file
      // damage so it can fix stale index/deletion/corruption states without
      // sweeping unrelated untracked work.
      const restored = await worktreeManager.restoreFromHead(pod.worktreePath, {
        allowTrackedModifications: true,
      });
      if (!restored.restored) {
        return {
          recovered: false,
          message: pod.containerId
            ? `Container not reachable and bare-repo restore refused: ${restored.reason}`
            : `No container to recover from; bare-repo restore refused: ${restored.reason}`,
          blockers: restored.blockers,
        };
      }
      podRepo.update(podId, { worktreeCompromised: false });
      emitActivityStatus(podId, `Worktree recovered from HEAD — ${restored.reason}`);
      return { recovered: true, message: restored.reason };
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
