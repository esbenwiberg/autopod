import { createHash } from 'node:crypto';
import type { ActionDefinition } from '@autopod/shared';
import type { ContainerManager } from '../../interfaces/container-manager.js';
import type { PodRepository } from '../../pods/pod-repository.js';
import type { ProfileStore } from '../../profiles/index.js';
import type { ActionHandlerContext } from './handler.js';

const WORKSPACE_DIR = '/workspace';

export interface DeployHandlerDeps {
  podRepo: PodRepository;
  containerManager: ContainerManager;
  profileStore: ProfileStore;
  daemonEnv: NodeJS.ProcessEnv;
}

/** SHA-256 hex digest of a string. */
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

export function createDeployHandler(deps: DeployHandlerDeps) {
  const { podRepo, containerManager, profileStore, daemonEnv } = deps;

  /**
   * Called by the MCP approval layer BEFORE creating the human-approval escalation.
   * Reads the deploy script from the container so the human reviewer can see its content.
   * Returns { scriptContent, scriptHash } which the MCP layer includes in the escalation payload.
   */
  async function getApprovalContext(
    podId: string,
    params: Record<string, unknown>,
  ): Promise<{ scriptContent: string; scriptHash: string }> {
    const scriptPath = params.script_path as string;
    validateScriptPath(scriptPath);

    const pod = podRepo.getSession(podId);
    if (!pod.containerId) throw new Error(`Pod ${podId} has no running container`);

    const absolutePath = `${WORKSPACE_DIR}/${scriptPath}`;
    const scriptContent = await containerManager.readFile(pod.containerId, absolutePath);
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

      const pod = podRepo.getSession(podId);
      if (!pod.containerId) throw new Error(`Pod ${podId} has no running container`);

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

      const absolutePath = `${WORKSPACE_DIR}/${scriptPath}`;

      // Hash verification — prevent timing attack where agent swaps script after approval
      if (approvalContext?.scriptHash) {
        const currentContent = await containerManager.readFile(pod.containerId, absolutePath);
        const currentHash = sha256hex(currentContent);
        if (currentHash !== approvalContext.scriptHash) {
          throw new Error(
            'Deploy script content changed after approval. Execution aborted for security. ' +
              'Submit a new deploy request if you need to use the updated script.',
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

      const result = await containerManager.execInContainer(
        pod.containerId,
        ['bash', absolutePath, ...args],
        { cwd: WORKSPACE_DIR, env: resolvedEnv },
      );

      return {
        exit_code: result.exitCode,
        stdout: result.stdout.slice(0, 50_000),
        stderr: result.stderr.slice(0, 10_000),
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
