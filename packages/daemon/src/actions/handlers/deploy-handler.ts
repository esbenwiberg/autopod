import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ActionDefinition } from '@autopod/shared';
import type { PodRepository } from '../../pods/pod-repository.js';
import type { ProfileStore } from '../../profiles/index.js';
import type { ActionHandlerContext } from './handler.js';

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const STDOUT_LIMIT = 50_000;
const STDERR_LIMIT = 10_000;

/**
 * Host env vars passed through to deploy scripts. We do NOT inherit the
 * full daemon process.env — that would leak unrelated daemon secrets to
 * user-authored scripts. Only this minimal set is forwarded so that tools
 * like `az`, `kubectl`, etc. resolve via PATH and find their config in HOME.
 */
const HOST_ENV_PASSTHROUGH = ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TERM'] as const;

export interface DeployScriptRunner {
  readScript(absolutePath: string): Promise<string>;
  runScript(opts: {
    scriptPath: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
    timeoutMs: number;
  }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export interface DeployHandlerDeps {
  podRepo: PodRepository;
  profileStore: ProfileStore;
  daemonEnv: NodeJS.ProcessEnv;
  /** Defaults to a runner backed by node:fs/promises + node:child_process. */
  runner?: DeployScriptRunner;
}

function sha256hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Minimal glob matching for allowedScripts patterns.
 * Supports `*` as a wildcard within a path segment.
 * Does NOT support `**` (no cross-directory wildcards by design).
 */
function matchesPattern(scriptPath: string, pattern: string): boolean {
  if (pattern === scriptPath) return true;
  if (!pattern.includes('*')) return false;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regexStr = escaped.replace(/\*/g, '[^/]*');
  return new RegExp(`^${regexStr}$`).test(scriptPath);
}

/**
 * Resolve a single env var value: expand `$DAEMON:<NAME>` refs from daemon process.env.
 * Returns the resolved value, or throws if a required daemon env var is not set.
 */
function resolveEnvValue(key: string, value: string, daemonEnv: NodeJS.ProcessEnv): string {
  if (!value.startsWith('$DAEMON:')) return value;
  const daemonKey = value.slice('$DAEMON:'.length);
  const resolved = daemonEnv[daemonKey];
  if (resolved === undefined) {
    throw new Error(
      `deployment.env["${key}"] references daemon env var "${daemonKey}" which is not set`,
    );
  }
  return resolved;
}

function buildHostEnv(
  daemonEnv: NodeJS.ProcessEnv,
  scriptEnv: Record<string, string>,
): Record<string, string> {
  const hostBase: Record<string, string> = {};
  for (const key of HOST_ENV_PASSTHROUGH) {
    const v = daemonEnv[key];
    if (v !== undefined) hostBase[key] = v;
  }
  // Profile-defined env vars take precedence over passthrough.
  return { ...hostBase, ...scriptEnv };
}

/**
 * Resolve scriptPath against the worktree root and assert the resolved path
 * stays under it. Defense-in-depth on top of `validateScriptPath`, which
 * already blocks `..` and absolute paths.
 */
function resolveHostScriptPath(worktreePath: string, scriptPath: string): string {
  const resolvedRoot = path.resolve(worktreePath);
  const resolved = path.resolve(resolvedRoot, scriptPath);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('script_path resolves outside the workspace root');
  }
  return resolved;
}

function defaultRunner(): DeployScriptRunner {
  return {
    async readScript(absolutePath: string) {
      return readFile(absolutePath, 'utf8');
    },
    async runScript({ scriptPath, args, cwd, env, timeoutMs }) {
      return new Promise((resolve, reject) => {
        const child = spawn('bash', [scriptPath, ...args], {
          cwd,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';
        let timedOut = false;

        const timer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, timeoutMs);

        child.stdout.on('data', (chunk) => {
          if (stdout.length < STDOUT_LIMIT * 2) stdout += chunk.toString('utf8');
        });
        child.stderr.on('data', (chunk) => {
          if (stderr.length < STDERR_LIMIT * 2) stderr += chunk.toString('utf8');
        });

        child.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });

        child.on('close', (code, signal) => {
          clearTimeout(timer);
          if (timedOut) {
            stderr += `\n[deploy] script killed after ${timeoutMs}ms timeout`;
          }
          const exitCode = code ?? (signal ? 128 + 1 : 1);
          resolve({ exitCode, stdout, stderr });
        });
      });
    },
  };
}

export function createDeployHandler(deps: DeployHandlerDeps) {
  const { podRepo, profileStore, daemonEnv } = deps;
  const runner = deps.runner ?? defaultRunner();

  /**
   * Called by the MCP approval layer BEFORE creating the human-approval escalation.
   * Reads the deploy script from the daemon host's worktree path so the human
   * reviewer can see its content. Returns { scriptContent, scriptHash } which
   * the MCP layer includes in the escalation payload.
   */
  async function getApprovalContext(
    podId: string,
    params: Record<string, unknown>,
  ): Promise<{ scriptContent: string; scriptHash: string }> {
    const scriptPath = params.script_path as string;
    validateScriptPath(scriptPath);

    const pod = podRepo.getOrThrow(podId);
    if (!pod.worktreePath) throw new Error(`Pod ${podId} has no worktree`);

    const absolutePath = resolveHostScriptPath(pod.worktreePath, scriptPath);
    const scriptContent = await runner.readScript(absolutePath);
    return { scriptContent, scriptHash: sha256hex(scriptContent) };
  }

  return {
    handlerType: 'deploy' as const,

    getApprovalContext,

    async execute(
      _action: ActionDefinition,
      params: Record<string, unknown>,
      context?: ActionHandlerContext,
    ): Promise<{ exit_code: number; stdout: string; stderr: string }> {
      if (!context?.podId) throw new Error('deploy handler requires podId in context');
      const { podId, approvalContext } = context;

      const pod = podRepo.getOrThrow(podId);
      if (!pod.worktreePath) throw new Error(`Pod ${podId} has no worktree`);

      const profile = profileStore.get(pod.profileName);
      const deployConfig = profile.deployment;
      if (!deployConfig?.enabled) {
        throw new Error('Deployment is not enabled for this profile');
      }

      const scriptPath = params.script_path as string;
      validateScriptPath(scriptPath);

      // Allowlist check
      if (deployConfig.allowedScripts?.length) {
        const allowed = deployConfig.allowedScripts.some((p) => matchesPattern(scriptPath, p));
        if (!allowed) {
          throw new Error(`Script "${scriptPath}" is not in the deployment allowedScripts list`);
        }
      }

      const absolutePath = resolveHostScriptPath(pod.worktreePath, scriptPath);

      // Baseline integrity check — refuse to execute when the script's content
      // differs from the SHA-256 captured at pod provision time from the base
      // branch (see captureDeployBaselineHashes in pod-manager). This blocks
      // the original gap: an agent editing a deploy script and then invoking
      // it. Only fires for profiles that declare an allowedScripts list (the
      // intended security posture); profiles without one get the legacy
      // unrestricted behaviour.
      if (deployConfig.allowedScripts?.length) {
        const baselines = pod.deployBaselineHashes;
        if (!baselines) {
          throw new Error(
            `Deploy script "${scriptPath}" cannot run: no trusted baseline was captured for this pod. The pod likely predates baseline tracking — kill and recreate it, or land deploy script changes on the base branch.`,
          );
        }
        const baseline = baselines[scriptPath];
        if (!baseline) {
          throw new Error(
            `Deploy script "${scriptPath}" has no trusted baseline at the base ref. Add a matching pattern to profile.deployment.allowedScripts and ensure the script is committed to the base branch before re-running.`,
          );
        }
        const currentContent = await runner.readScript(absolutePath);
        const currentHash = sha256hex(currentContent);
        if (currentHash !== baseline) {
          throw new Error(
            `Deploy script "${scriptPath}" does not match its trusted baseline (captured at pod provision from the base branch). The script was modified during the pod session — execution aborted for security. Land legitimate changes on the base branch and rerun the pod.`,
          );
        }
      }

      // Resolve env vars — expand $DAEMON: refs server-side
      const resolvedEnv: Record<string, string> = {};
      for (const [key, value] of Object.entries(deployConfig.env)) {
        resolvedEnv[key] = resolveEnvValue(key, value, daemonEnv);
      }

      // Parse optional args string into array
      const argsStr = params.args as string | undefined;
      const args = argsStr ? argsStr.trim().split(/\s+/).filter(Boolean) : [];

      const result = await runner.runScript({
        scriptPath: absolutePath,
        args,
        cwd: path.resolve(pod.worktreePath),
        env: buildHostEnv(daemonEnv, resolvedEnv),
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });

      return {
        exit_code: result.exitCode,
        stdout: result.stdout.slice(0, STDOUT_LIMIT),
        stderr: result.stderr.slice(0, STDERR_LIMIT),
      };
    },
  };
}

function validateScriptPath(scriptPath: unknown): asserts scriptPath is string {
  if (typeof scriptPath !== 'string' || scriptPath.length === 0) {
    throw new Error('script_path must be a non-empty string');
  }
  if (scriptPath.startsWith('/')) {
    throw new Error('script_path must be relative to the workspace root (no leading /)');
  }
  if (scriptPath.includes('..')) {
    throw new Error('script_path must not contain path traversal (..)');
  }
}
