import type { StackTemplate } from '@autopod/shared';

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

  // Repo URL
  const repoUrl = input.repoUrl;
  // The pod axes determine whether a repoUrl is needed:
  //  - output='artifact' | 'none' → ephemeral, no push target required
  //  - output='pr' | 'branch'     → must have somewhere to push
  // Legacy outputMode='artifact' is still honored as a fallback.
  const pod = (input.pod ?? null) as { output?: string } | null;
  const outputTarget = pod?.output ?? (input.outputMode as string | undefined);
  const repoUrlRequired = outputTarget !== 'artifact' && outputTarget !== 'none';
  if (repoUrlRequired && (typeof repoUrl !== 'string' || repoUrl.length === 0)) {
    errors.push('repoUrl is required');
  } else if (typeof repoUrl === 'string' && repoUrl.length > 0) {
    try {
      const url = new URL(repoUrl);
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

  // Build command
  const buildCommand = input.buildCommand;
  if (typeof buildCommand !== 'string' || buildCommand.length === 0) {
    errors.push('buildCommand is required');
  } else {
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(buildCommand)) {
        errors.push(`buildCommand contains dangerous pattern: ${pattern.source}`);
        break;
      }
    }
  }

  // Start command
  const startCommand = input.startCommand;
  if (typeof startCommand !== 'string' || startCommand.length === 0) {
    errors.push('startCommand is required');
  } else if (!startCommand.includes('$PORT')) {
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

  return { valid: errors.length === 0, errors };
}
