import type { StackTemplate } from '@autopod/shared';
import { isPrivateUrl } from '../api/ssrf-guard.js';

export interface ProfileValidationResult {
  valid: boolean;
  errors: string[];
}

const KNOWN_RUNTIMES = ['claude', 'codex'];
const VALID_TEMPLATES: StackTemplate[] = [
  'node22',
  'node22-pw',
  'dotnet9',
  'dotnet10',
  'dotnet10-go',
  'python312',
  'python-node',
  'go124',
  'go124-pw',
  'custom',
];

const DANGEROUS_PATTERNS = [/rm\s+-rf\s+\//, /\bsudo\b/, /curl\s.*\|\s*bash/, /wget\s.*\|\s*bash/];

export function validateProfile(input: Record<string, unknown>): ProfileValidationResult {
  const errors: string[] = [];

  // Name
  const name = input.name;
  if (typeof name !== 'string' || name.length === 0) {
    errors.push('name is required');
  } else if (name.length > 50) {
    errors.push('name must be 50 characters or fewer');
  } else if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name)) {
    errors.push(
      'name must be lowercase alphanumeric with hyphens, cannot start or end with a hyphen',
    );
  }

  // Repo URL — optional; repo-less profiles are valid for ephemeral/red-team use or as
  // inheritance anchors where derived profiles supply the repoUrl. Runtime enforcement
  // (e.g. "you need a repo to create PRs") lives in pod-manager.
  const repoUrl = input.repoUrl;
  const hasRepoUrl = typeof repoUrl === 'string' && repoUrl.length > 0;
  if (hasRepoUrl) {
    try {
      const url = new URL(repoUrl as string);
      if (url.protocol !== 'https:') {
        errors.push('repoUrl must use https://');
      } else if (!url.hostname.includes('github.com') && !url.hostname.includes('dev.azure.com')) {
        errors.push('repoUrl must be a github.com or dev.azure.com URL');
      }
    } catch {
      errors.push('repoUrl must be a valid URL');
    }
  }

  // Template
  const template = input.template;
  if (template !== undefined && !VALID_TEMPLATES.includes(template as StackTemplate)) {
    errors.push(`template must be one of: ${VALID_TEMPLATES.join(', ')}`);
  }

  // Build command — required only when repoUrl is set; repo-less profiles have nothing to build
  const buildCommand = input.buildCommand;
  if (hasRepoUrl && (typeof buildCommand !== 'string' || buildCommand.length === 0)) {
    errors.push('buildCommand is required when repoUrl is set');
  } else if (typeof buildCommand === 'string' && buildCommand.length > 0) {
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(buildCommand)) {
        errors.push(`buildCommand contains dangerous pattern: ${pattern.source}`);
        break;
      }
    }
  }

  // Start command — required only when repoUrl is set
  const startCommand = input.startCommand;
  if (hasRepoUrl && (typeof startCommand !== 'string' || startCommand.length === 0)) {
    errors.push('startCommand is required when repoUrl is set');
  } else if (hasRepoUrl && typeof startCommand === 'string' && startCommand.length > 0 && !startCommand.includes('$PORT')) {
    errors.push('startCommand must contain $PORT placeholder');
  }

  // Build work dir — optional, must be a relative path without traversal
  const buildWorkDir = (input as Record<string, unknown>).buildWorkDir;
  if (buildWorkDir !== null && buildWorkDir !== undefined) {
    if (typeof buildWorkDir !== 'string') {
      errors.push('buildWorkDir must be a string');
    } else if (buildWorkDir.includes('..') || buildWorkDir.startsWith('/')) {
      errors.push(
        'buildWorkDir must be a relative path without traversal (no ".." or leading "/")',
      );
    }
  }

  // Health path
  const healthPath = input.healthPath;
  if (healthPath !== undefined && typeof healthPath === 'string' && !healthPath.startsWith('/')) {
    errors.push('healthPath must start with /');
  }

  // Health timeout
  const healthTimeout = input.healthTimeout;
  if (healthTimeout !== undefined) {
    if (typeof healthTimeout !== 'number' || healthTimeout < 10 || healthTimeout > 600) {
      errors.push('healthTimeout must be between 10 and 600');
    }
  }

  // Default model — free-form string; runtimes resolve aliases at spawn time
  const defaultModel = input.defaultModel;
  if (defaultModel !== undefined && typeof defaultModel !== 'string') {
    errors.push('defaultModel must be a string');
  } else if (typeof defaultModel === 'string' && defaultModel.trim().length === 0) {
    errors.push('defaultModel must not be empty');
  }

  // Reviewer model — used for AC validation and task review; defaults to defaultModel at runtime
  const reviewerModel = input.reviewerModel;
  if (reviewerModel !== undefined && reviewerModel !== null && typeof reviewerModel !== 'string') {
    errors.push('reviewerModel must be a string');
  } else if (typeof reviewerModel === 'string' && reviewerModel.trim().length === 0) {
    errors.push('reviewerModel must not be empty');
  }

  // Default runtime
  const defaultRuntime = input.defaultRuntime;
  if (defaultRuntime !== undefined && !KNOWN_RUNTIMES.includes(defaultRuntime as string)) {
    errors.push(`defaultRuntime must be one of: ${KNOWN_RUNTIMES.join(', ')}`);
  }

  // Max validation attempts
  const maxValidationAttempts = input.maxValidationAttempts;
  if (maxValidationAttempts !== undefined) {
    if (
      typeof maxValidationAttempts !== 'number' ||
      maxValidationAttempts < 1 ||
      maxValidationAttempts > 10
    ) {
      errors.push('maxValidationAttempts must be between 1 and 10');
    }
  }

  // Token budget
  const tokenBudget = input.tokenBudget;
  if (tokenBudget !== undefined && tokenBudget !== null) {
    if (typeof tokenBudget !== 'number' || !Number.isInteger(tokenBudget) || tokenBudget < 1000) {
      errors.push('tokenBudget must be a positive integer >= 1000, or null');
    }
  }

  // Token budget warn threshold
  const tokenBudgetWarnAt = input.tokenBudgetWarnAt;
  if (tokenBudgetWarnAt !== undefined) {
    if (
      typeof tokenBudgetWarnAt !== 'number' ||
      tokenBudgetWarnAt < 0.1 ||
      tokenBudgetWarnAt >= 1
    ) {
      errors.push('tokenBudgetWarnAt must be a number between 0.1 and 0.99');
    }
  }

  // Max budget extensions
  const maxBudgetExtensions = input.maxBudgetExtensions;
  if (maxBudgetExtensions !== undefined && maxBudgetExtensions !== null) {
    if (
      typeof maxBudgetExtensions !== 'number' ||
      !Number.isInteger(maxBudgetExtensions) ||
      maxBudgetExtensions < 0
    ) {
      errors.push('maxBudgetExtensions must be a non-negative integer, or null');
    }
  }

  // hasWebUi
  if (input.hasWebUi !== undefined && typeof input.hasWebUi !== 'boolean') {
    errors.push('hasWebUi must be a boolean');
  }

  // Lint command
  const lintCommand = input.lintCommand;
  if (lintCommand !== null && lintCommand !== undefined && typeof lintCommand !== 'string') {
    errors.push('lintCommand must be a string or null');
  } else if (typeof lintCommand === 'string') {
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(lintCommand)) {
        errors.push(`lintCommand contains dangerous pattern: ${pattern.source}`);
        break;
      }
    }
  }

  // Lint timeout
  const lintTimeout = input.lintTimeout;
  if (lintTimeout !== undefined && lintTimeout !== null) {
    if (typeof lintTimeout !== 'number' || lintTimeout < 10 || lintTimeout > 600) {
      errors.push('lintTimeout must be between 10 and 600');
    }
  }

  // SAST command
  const sastCommand = input.sastCommand;
  if (sastCommand !== null && sastCommand !== undefined && typeof sastCommand !== 'string') {
    errors.push('sastCommand must be a string or null');
  } else if (typeof sastCommand === 'string') {
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(sastCommand)) {
        errors.push(`sastCommand contains dangerous pattern: ${pattern.source}`);
        break;
      }
    }
  }

  // SAST timeout
  const sastTimeout = input.sastTimeout;
  if (sastTimeout !== undefined && sastTimeout !== null) {
    if (typeof sastTimeout !== 'number' || sastTimeout < 10 || sastTimeout > 1800) {
      errors.push('sastTimeout must be between 10 and 1800');
    }
  }

  // ACI backend does not support iptables-based network isolation.
  // Reject restricted/deny-all network policies for ACI profiles at write time
  // so operators get a clear error instead of a silently open container.
  const executionTarget = input.executionTarget;
  const networkPolicy = input.networkPolicy as
    | { mode?: string; enabled?: boolean }
    | null
    | undefined;
  if (
    executionTarget === 'aci' &&
    networkPolicy?.enabled === true &&
    (networkPolicy.mode === 'restricted' || networkPolicy.mode === 'deny-all')
  ) {
    errors.push(
      `network_policy mode '${networkPolicy.mode}' is not supported on the ACI execution target — iptables-based isolation requires the Docker backend`,
    );
  }

  // Code intelligence config
  const codeIntelligence = input.codeIntelligence;
  if (codeIntelligence !== null && codeIntelligence !== undefined) {
    if (typeof codeIntelligence !== 'object' || Array.isArray(codeIntelligence)) {
      errors.push('codeIntelligence must be an object or null');
    } else {
      const ci = codeIntelligence as Record<string, unknown>;
      if (ci.serena !== undefined && typeof ci.serena !== 'boolean') {
        errors.push('codeIntelligence.serena must be a boolean');
      }
      if (ci.roslynCodeLens !== undefined && typeof ci.roslynCodeLens !== 'boolean') {
        errors.push('codeIntelligence.roslynCodeLens must be a boolean');
      }
      const tmpl = input.template as string | undefined;
      const isDotnet = tmpl === 'dotnet9' || tmpl === 'dotnet10' || tmpl === 'dotnet10-go';
      if (ci.roslynCodeLens === true && !isDotnet) {
        errors.push(
          'codeIntelligence.roslynCodeLens requires a dotnet template (dotnet9, dotnet10, or dotnet10-go)',
        );
      }
    }
  }

  // Reject private registry URLs that resolve to loopback/private/metadata addresses.
  // Prevents an attacker with profile-write access from pointing a registry at the cloud
  // metadata endpoint (169.254.169.254) to exfiltrate credentials at image-build time.
  const privateRegistries = input.privateRegistries;
  if (Array.isArray(privateRegistries)) {
    for (const reg of privateRegistries) {
      const regUrl = (reg as Record<string, unknown>).url;
      if (typeof regUrl === 'string' && regUrl.length > 0) {
        if (isPrivateUrl(regUrl)) {
          errors.push(
            `privateRegistries[].url '${regUrl}' resolves to a private/loopback/metadata address — SSRF not allowed`,
          );
        }
      }
    }
  }

  // Deployment config
  const deployment = input.deployment;
  if (deployment !== null && deployment !== undefined) {
    if (typeof deployment !== 'object' || Array.isArray(deployment)) {
      errors.push('deployment must be an object or null');
    } else {
      const d = deployment as Record<string, unknown>;
      if (typeof d.enabled !== 'boolean') {
        errors.push('deployment.enabled must be a boolean');
      }
      if (d.env !== null && d.env !== undefined) {
        if (typeof d.env !== 'object' || Array.isArray(d.env)) {
          errors.push('deployment.env must be a string record');
        } else {
          for (const [k, v] of Object.entries(d.env as Record<string, unknown>)) {
            if (typeof v !== 'string') {
              errors.push(`deployment.env["${k}"] must be a string`);
            }
          }
        }
      }
      if (d.allowedScripts !== undefined) {
        if (!Array.isArray(d.allowedScripts)) {
          errors.push('deployment.allowedScripts must be an array');
        } else {
          for (const s of d.allowedScripts as unknown[]) {
            if (typeof s !== 'string' || s.length === 0) {
              errors.push('deployment.allowedScripts entries must be non-empty strings');
              break;
            }
            if ((s as string).startsWith('/')) {
              errors.push(`deployment.allowedScripts entry "${s}" must be relative (no leading /)`);
              break;
            }
            if ((s as string).includes('..')) {
              errors.push(
                `deployment.allowedScripts entry "${s}" must not contain path traversal (..)`,
              );
              break;
            }
          }
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
