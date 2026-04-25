import type {
  ActionPolicy,
  AgentMode,
  EscalationConfig,
  InjectedClaudeMdSection,
  InjectedMcpServer,
  InjectedSkill,
  MergeStrategy,
  NetworkPolicy,
  OutputTarget,
  PimActivationConfig,
  PodOptions,
  PrivateRegistry,
  Profile,
  ProviderCredentials,
  SecurityScanPolicy,
  SidecarsConfig,
  SmokePage,
  TestPipelineConfig,
} from '@autopod/shared';
import {
  AutopodError,
  ProfileExistsError,
  ProfileNotFoundError,
  createProfileSchema,
  escalationConfigSchema,
  outputModeFromPodOptions,
  updateProfileSchema,
} from '@autopod/shared';
import type Database from 'better-sqlite3';
import pino from 'pino';
import type { CredentialsCipher } from '../crypto/credentials-cipher.js';
import { resolveInheritance, validateInheritanceChain } from './inheritance.js';

const logger = pino({ name: 'autopod' }).child({ component: 'profiles' });

export interface ProfileStore {
  create(input: Record<string, unknown>): Profile;
  get(name: string): Profile;
  getRaw(name: string): Profile;
  list(): Profile[];
  update(name: string, changes: Record<string, unknown>): Profile;
  delete(name: string): void;
  exists(name: string): boolean;
  /**
   * Walk the `extends` chain starting at `name` and return the name of the
   * first profile that holds a non-null `providerCredentials`. This is the
   * profile that actually "owns" the authentication state — credential
   * rotations during pod runs are persisted there, not on the descendant.
   * Returns `null` if no profile in the chain has credentials set.
   */
  resolveCredentialOwner(name: string): string | null;
}

/**
 * Reconstruct the profile-level PodOptions override from row columns.
 * Returns null when no new-style columns are set (i.e. the profile has no
 * pod default — pod creation will fall back to built-in defaults).
 */
function readProfilePodFromRow(row: Record<string, unknown>): PodOptions | null {
  const agentMode = row.agent_mode as AgentMode | null | undefined;
  const output = row.output_target as OutputTarget | null | undefined;
  if (!agentMode && !output) return null;
  if (!agentMode || !output) return null;
  return {
    agentMode,
    output,
    validate:
      row.validate !== null && row.validate !== undefined ? Boolean(row.validate) : undefined,
    promotable:
      row.promotable !== null && row.promotable !== undefined ? Boolean(row.promotable) : undefined,
  };
}

/** Map a SQLite row (snake_case) to a Profile (camelCase). Defined outside factory for test-utils. */
export function rowToProfile(
  row: Record<string, unknown>,
  decryptCreds: (raw: unknown) => ProviderCredentials | null = (raw) =>
    raw ? (JSON.parse(raw as string) as ProviderCredentials) : null,
  decryptPat: (raw: unknown) => string | null = (raw) => (raw ? (raw as string) : null),
): Profile {
  // Helpers: keep null as null (signals "inherit from parent" on derived
  // profiles). Only coerce undefined → null; do NOT substitute schema defaults
  // here or buildSourceMap can't tell inherited from own.
  const nullableStr = (v: unknown): string | null =>
    v === null || v === undefined ? null : (v as string);
  const nullableNum = (v: unknown): number | null =>
    v === null || v === undefined ? null : (v as number);
  const nullableBool = (v: unknown): boolean | null =>
    v === null || v === undefined ? null : Boolean(v);

  return {
    name: row.name as string,
    repoUrl: nullableStr(row.repo_url),
    defaultBranch: nullableStr(row.default_branch),
    template: nullableStr(row.template) as Profile['template'],
    buildCommand: nullableStr(row.build_command),
    startCommand: nullableStr(row.start_command),
    buildWorkDir: nullableStr(row.build_work_dir),
    healthPath: nullableStr(row.health_path),
    healthTimeout: nullableNum(row.health_timeout),
    smokePages: JSON.parse((row.validation_pages as string) ?? '[]') as SmokePage[],
    maxValidationAttempts: nullableNum(row.max_validation_attempts),
    defaultModel: nullableStr(row.default_model),
    reviewerModel: nullableStr(row.reviewer_model),
    defaultRuntime: nullableStr(row.default_runtime) as Profile['defaultRuntime'],
    executionTarget: nullableStr(row.execution_target) as Profile['executionTarget'],
    customInstructions: nullableStr(row.custom_instructions),
    escalation:
      row.escalation_config === null || row.escalation_config === undefined
        ? null
        : (escalationConfigSchema.parse(
            JSON.parse(row.escalation_config as string),
          ) as EscalationConfig),
    extends: nullableStr(row.extends),
    workerProfile: nullableStr(row.worker_profile),
    warmImageTag: nullableStr(row.warm_image_tag),
    warmImageBuiltAt: nullableStr(row.warm_image_built_at),
    mcpServers: JSON.parse((row.mcp_servers as string) ?? '[]') as InjectedMcpServer[],
    claudeMdSections: JSON.parse(
      (row.claude_md_sections as string) ?? '[]',
    ) as InjectedClaudeMdSection[],
    skills: JSON.parse((row.skills as string) ?? '[]') as InjectedSkill[],
    networkPolicy: row.network_policy
      ? (JSON.parse(row.network_policy as string) as NetworkPolicy)
      : null,
    actionPolicy: row.action_policy
      ? (JSON.parse(row.action_policy as string) as ActionPolicy)
      : null,
    pod: readProfilePodFromRow(row),
    outputMode: nullableStr(row.output_mode) as Profile['outputMode'],
    modelProvider: nullableStr(row.model_provider) as Profile['modelProvider'],
    providerCredentials: decryptCreds(row.provider_credentials),
    testCommand: nullableStr(row.test_command),
    lintCommand: nullableStr(row.lint_command),
    lintTimeout: nullableNum(row.lint_timeout),
    sastCommand: nullableStr(row.sast_command),
    sastTimeout: nullableNum(row.sast_timeout),
    prProvider: nullableStr(row.pr_provider) as Profile['prProvider'],
    adoPat: decryptPat(row.ado_pat),
    githubPat: decryptPat(row.github_pat),
    privateRegistries: JSON.parse((row.private_registries as string) ?? '[]') as PrivateRegistry[],
    registryPat: decryptPat(row.registry_pat),
    branchPrefix: nullableStr(row.branch_prefix),
    containerMemoryGb: nullableNum(row.container_memory_gb),
    buildTimeout: nullableNum(row.build_timeout),
    testTimeout: nullableNum(row.test_timeout),
    version: (row.version as number | null) ?? 1,
    tokenBudget: nullableNum(row.token_budget),
    tokenBudgetWarnAt: nullableNum(row.token_budget_warn_at),
    tokenBudgetPolicy: nullableStr(row.token_budget_policy) as 'soft' | 'hard' | null,
    maxBudgetExtensions: nullableNum(row.max_budget_extensions),
    hasWebUi: nullableBool(row.has_web_ui),
    issueWatcherEnabled: nullableBool(row.issue_watcher_enabled),
    issueWatcherLabelPrefix: nullableStr(row.issue_watcher_label_prefix),
    pimActivations: row.pim_activations
      ? (JSON.parse(row.pim_activations as string) as PimActivationConfig[])
      : null,
    mergeStrategy: row.merge_strategy
      ? (JSON.parse(row.merge_strategy as string) as MergeStrategy)
      : {},
    sidecars: row.sidecars ? (JSON.parse(row.sidecars as string) as SidecarsConfig) : null,
    trustedSource: nullableBool(row.trusted_source),
    testPipeline: row.test_pipeline
      ? (JSON.parse(row.test_pipeline as string) as TestPipelineConfig)
      : null,
    securityScan: row.security_scan
      ? (JSON.parse(row.security_scan as string) as SecurityScanPolicy)
      : null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function createProfileStore(
  db: Database.Database,
  cipher?: CredentialsCipher,
): ProfileStore {
  function encryptCreds(creds: ProviderCredentials | null | undefined): string | null {
    if (!creds) return null;
    const json = JSON.stringify(creds);
    return cipher ? cipher.encrypt(json) : json;
  }

  function decryptCreds(raw: unknown): ProviderCredentials | null {
    if (!raw) return null;
    const str = raw as string;
    try {
      const json = cipher ? cipher.decrypt(str) : str;
      return JSON.parse(json) as ProviderCredentials;
    } catch {
      // Fallback: try plain JSON (e.g. rows written before encryption was enabled)
      try {
        return JSON.parse(str) as ProviderCredentials;
      } catch {
        return null;
      }
    }
  }

  function encryptPat(pat: string | null | undefined): string | null {
    if (!pat) return null;
    return cipher ? cipher.encrypt(pat) : pat;
  }

  function decryptPat(raw: unknown): string | null {
    if (!raw) return null;
    const str = raw as string;
    try {
      return cipher ? cipher.decrypt(str) : str;
    } catch {
      return str; // Fallback: treat as plain text
    }
  }

  /** Fetch a raw profile row from DB, throw if not found. */
  function fetchRaw(name: string): Profile {
    const row = db.prepare('SELECT * FROM profiles WHERE name = ?').get(name) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new ProfileNotFoundError(name);
    return rowToProfile(row, decryptCreds, decryptPat);
  }

  /** Recursively resolve inheritance for a profile. */
  function resolve(profile: Profile, depth = 0): Profile {
    if (!profile.extends) return profile;

    if (depth >= 5) {
      throw new AutopodError(
        'Inheritance chain too deep (max 5 levels)',
        'INHERITANCE_TOO_DEEP',
        400,
      );
    }

    const parent = fetchRaw(profile.extends);
    const resolvedParent = resolve(parent, depth + 1);
    return resolveInheritance(profile, resolvedParent);
  }

  /** Get the `extends` value for a profile name (used for chain validation). */
  function getExtends(name: string): string | null {
    const row = db.prepare('SELECT extends FROM profiles WHERE name = ?').get(name) as
      | { extends: string | null }
      | undefined;
    return row?.extends ?? null;
  }

  return {
    create(input: Record<string, unknown>): Profile {
      const parsed = createProfileSchema.parse(input);

      // Check for duplicate name
      const existing = db.prepare('SELECT 1 FROM profiles WHERE name = ?').get(parsed.name);
      if (existing) throw new ProfileExistsError(parsed.name);

      // If extends is set, verify parent exists
      if (parsed.extends) {
        const parentExists = db
          .prepare('SELECT 1 FROM profiles WHERE name = ?')
          .get(parsed.extends);
        if (!parentExists) throw new ProfileNotFoundError(parsed.extends);
      }

      const now = new Date().toISOString();

      // When a pod config is provided, prefer it; otherwise fall back to
      // legacy outputMode. We always write both so legacy readers keep working.
      const legacyOutputMode = parsed.pod
        ? outputModeFromPodOptions(parsed.pod)
        : parsed.outputMode;

      db.prepare(`
        INSERT INTO profiles (
          name, repo_url, default_branch, template, build_command, start_command, build_work_dir,
          health_path, health_timeout, validation_pages, max_validation_attempts,
          default_model, reviewer_model, default_runtime, execution_target, custom_instructions, escalation_config,
          extends, worker_profile, mcp_servers, claude_md_sections, skills, network_policy, action_policy, output_mode,
          agent_mode, output_target, validate, promotable,
          model_provider, provider_credentials, test_command, pr_provider, ado_pat, github_pat,
          private_registries, registry_pat, branch_prefix, container_memory_gb,
          build_timeout, test_timeout,
          lint_command, lint_timeout, sast_command, sast_timeout,
          token_budget, token_budget_warn_at, token_budget_policy, max_budget_extensions,
          has_web_ui,
          issue_watcher_enabled, issue_watcher_label_prefix,
          pim_activations,
          merge_strategy,
          sidecars, trusted_source, test_pipeline, security_scan,
          created_at, updated_at
        ) VALUES (
          @name, @repoUrl, @defaultBranch, @template, @buildCommand, @startCommand, @buildWorkDir,
          @healthPath, @healthTimeout, @validationPages, @maxValidationAttempts,
          @defaultModel, @reviewerModel, @defaultRuntime, @executionTarget, @customInstructions, @escalationConfig,
          @extends, @workerProfile, @mcpServers, @claudeMdSections, @skills, @networkPolicy, @actionPolicy, @outputMode,
          @agentMode, @outputTarget, @validate, @promotable,
          @modelProvider, @providerCredentials, @testCommand, @prProvider, @adoPat, @githubPat,
          @privateRegistries, @registryPat, @branchPrefix, @containerMemoryGb,
          @buildTimeout, @testTimeout,
          @lintCommand, @lintTimeout, @sastCommand, @sastTimeout,
          @tokenBudget, @tokenBudgetWarnAt, @tokenBudgetPolicy, @maxBudgetExtensions,
          @hasWebUi,
          @issueWatcherEnabled, @issueWatcherLabelPrefix,
          @pimActivations,
          @mergeStrategy,
          @sidecars, @trustedSource, @testPipeline, @securityScan,
          @createdAt, @updatedAt
        )
      `).run({
        name: parsed.name,
        repoUrl: parsed.repoUrl,
        defaultBranch: parsed.defaultBranch,
        template: parsed.template,
        buildCommand: parsed.buildCommand,
        startCommand: parsed.startCommand,
        buildWorkDir: parsed.buildWorkDir ?? null,
        healthPath: parsed.healthPath,
        healthTimeout: parsed.healthTimeout,
        validationPages: JSON.stringify(parsed.smokePages ?? []),
        maxValidationAttempts: parsed.maxValidationAttempts,
        defaultModel: parsed.defaultModel,
        reviewerModel: parsed.reviewerModel ?? null,
        defaultRuntime: parsed.defaultRuntime,
        executionTarget: parsed.executionTarget,
        customInstructions: parsed.customInstructions,
        escalationConfig: parsed.escalation === null ? null : JSON.stringify(parsed.escalation),
        extends: parsed.extends,
        workerProfile: parsed.workerProfile ?? null,
        mcpServers: JSON.stringify(parsed.mcpServers ?? []),
        claudeMdSections: JSON.stringify(parsed.claudeMdSections ?? []),
        skills: JSON.stringify(parsed.skills ?? []),
        networkPolicy: parsed.networkPolicy ? JSON.stringify(parsed.networkPolicy) : null,
        actionPolicy: parsed.actionPolicy ? JSON.stringify(parsed.actionPolicy) : null,
        outputMode: legacyOutputMode,
        agentMode: parsed.pod?.agentMode ?? null,
        outputTarget: parsed.pod?.output ?? null,
        validate: parsed.pod?.validate === undefined ? null : parsed.pod.validate ? 1 : 0,
        promotable: parsed.pod?.promotable === undefined ? null : parsed.pod.promotable ? 1 : 0,
        modelProvider: parsed.modelProvider,
        providerCredentials: encryptCreds(parsed.providerCredentials),
        testCommand: parsed.testCommand ?? null,
        lintCommand: parsed.lintCommand ?? null,
        lintTimeout: parsed.lintTimeout ?? null,
        sastCommand: parsed.sastCommand ?? null,
        sastTimeout: parsed.sastTimeout ?? null,
        prProvider: parsed.prProvider,
        adoPat: encryptPat(parsed.adoPat),
        githubPat: encryptPat(parsed.githubPat),
        privateRegistries: JSON.stringify(parsed.privateRegistries ?? []),
        registryPat: encryptPat(parsed.registryPat),
        branchPrefix: parsed.branchPrefix,
        containerMemoryGb: parsed.containerMemoryGb ?? null,
        buildTimeout: parsed.buildTimeout,
        testTimeout: parsed.testTimeout,
        tokenBudget: parsed.tokenBudget ?? null,
        tokenBudgetWarnAt: parsed.tokenBudgetWarnAt,
        tokenBudgetPolicy: parsed.tokenBudgetPolicy,
        maxBudgetExtensions: parsed.maxBudgetExtensions ?? null,
        hasWebUi: parsed.hasWebUi === null ? null : parsed.hasWebUi ? 1 : 0,
        issueWatcherEnabled:
          parsed.issueWatcherEnabled === null ? null : parsed.issueWatcherEnabled ? 1 : 0,
        issueWatcherLabelPrefix: parsed.issueWatcherLabelPrefix,
        pimActivations: parsed.pimActivations ? JSON.stringify(parsed.pimActivations) : null,
        mergeStrategy: JSON.stringify(parsed.mergeStrategy ?? {}),
        sidecars: parsed.sidecars ? JSON.stringify(parsed.sidecars) : null,
        trustedSource:
          parsed.trustedSource === null || parsed.trustedSource === undefined
            ? null
            : parsed.trustedSource
              ? 1
              : 0,
        testPipeline: parsed.testPipeline ? JSON.stringify(parsed.testPipeline) : null,
        securityScan: parsed.securityScan ? JSON.stringify(parsed.securityScan) : null,
        createdAt: now,
        updatedAt: now,
      });

      logger.info({ name: parsed.name }, 'Profile created');
      return this.get(parsed.name);
    },

    get(name: string): Profile {
      const raw = fetchRaw(name);

      if (raw.extends) {
        validateInheritanceChain(name, getExtends);
      }

      return resolve(raw);
    },

    getRaw(name: string): Profile {
      return fetchRaw(name);
    },

    list(): Profile[] {
      const rows = db.prepare('SELECT * FROM profiles ORDER BY name').all() as Record<
        string,
        unknown
      >[];
      return rows.map((row) => {
        const profile = rowToProfile(row, decryptCreds, decryptPat);
        return profile.extends ? resolve(profile) : profile;
      });
    },

    update(name: string, changes: Record<string, unknown>): Profile {
      // Verify profile exists
      const existing = fetchRaw(name);

      const parsed = updateProfileSchema.parse(changes);

      // If extends is being changed, verify new parent exists
      if (parsed.extends !== undefined && parsed.extends !== null) {
        const parentExists = db
          .prepare('SELECT 1 FROM profiles WHERE name = ?')
          .get(parsed.extends);
        if (!parentExists) throw new ProfileNotFoundError(parsed.extends);
      }

      // Enforce: base profiles (extends == null after this update) must have
      // non-null buildCommand and startCommand. Null is only meaningful on
      // derived profiles as "inherit from parent".
      const resultExtends = parsed.extends === undefined ? existing.extends : parsed.extends;
      if (resultExtends === null) {
        if (parsed.buildCommand === null) {
          throw new AutopodError(
            'buildCommand cannot be null on a base profile (extends is null)',
            'INVALID_BASE_PROFILE',
            400,
          );
        }
        if (parsed.startCommand === null) {
          throw new AutopodError(
            'startCommand cannot be null on a base profile (extends is null)',
            'INVALID_BASE_PROFILE',
            400,
          );
        }
      }

      // Build dynamic UPDATE — only touch changed fields
      const fieldMap: Record<string, unknown> = {};
      const setClauses: string[] = [];

      if (parsed.repoUrl !== undefined) {
        setClauses.push('repo_url = @repoUrl');
        fieldMap.repoUrl = parsed.repoUrl;
      }
      if (parsed.defaultBranch !== undefined) {
        setClauses.push('default_branch = @defaultBranch');
        fieldMap.defaultBranch = parsed.defaultBranch;
      }
      if (parsed.template !== undefined) {
        setClauses.push('template = @template');
        fieldMap.template = parsed.template;
      }
      if (parsed.buildCommand !== undefined) {
        setClauses.push('build_command = @buildCommand');
        fieldMap.buildCommand = parsed.buildCommand;
      }
      if (parsed.startCommand !== undefined) {
        setClauses.push('start_command = @startCommand');
        fieldMap.startCommand = parsed.startCommand;
      }
      if (parsed.healthPath !== undefined) {
        setClauses.push('health_path = @healthPath');
        fieldMap.healthPath = parsed.healthPath;
      }
      if (parsed.healthTimeout !== undefined) {
        setClauses.push('health_timeout = @healthTimeout');
        fieldMap.healthTimeout = parsed.healthTimeout;
      }
      if (parsed.smokePages !== undefined) {
        setClauses.push('validation_pages = @validationPages');
        fieldMap.validationPages = JSON.stringify(parsed.smokePages ?? []);
      }
      if (parsed.maxValidationAttempts !== undefined) {
        setClauses.push('max_validation_attempts = @maxValidationAttempts');
        fieldMap.maxValidationAttempts = parsed.maxValidationAttempts;
      }
      if (parsed.defaultModel !== undefined) {
        setClauses.push('default_model = @defaultModel');
        fieldMap.defaultModel = parsed.defaultModel;
      }
      if (parsed.reviewerModel !== undefined) {
        setClauses.push('reviewer_model = @reviewerModel');
        fieldMap.reviewerModel = parsed.reviewerModel;
      }
      if (parsed.defaultRuntime !== undefined) {
        setClauses.push('default_runtime = @defaultRuntime');
        fieldMap.defaultRuntime = parsed.defaultRuntime;
      }
      if (parsed.executionTarget !== undefined) {
        setClauses.push('execution_target = @executionTarget');
        fieldMap.executionTarget = parsed.executionTarget;
      }
      if (parsed.customInstructions !== undefined) {
        setClauses.push('custom_instructions = @customInstructions');
        fieldMap.customInstructions = parsed.customInstructions;
      }
      if (parsed.escalation !== undefined) {
        setClauses.push('escalation_config = @escalationConfig');
        fieldMap.escalationConfig =
          parsed.escalation === null ? null : JSON.stringify(parsed.escalation);
      }
      if (parsed.extends !== undefined) {
        setClauses.push('extends = @extends');
        fieldMap.extends = parsed.extends;
      }
      if (parsed.workerProfile !== undefined) {
        setClauses.push('worker_profile = @workerProfile');
        fieldMap.workerProfile = parsed.workerProfile;
      }
      if (parsed.mcpServers !== undefined) {
        setClauses.push('mcp_servers = @mcpServers');
        fieldMap.mcpServers = JSON.stringify(parsed.mcpServers ?? []);
      }
      if (parsed.claudeMdSections !== undefined) {
        setClauses.push('claude_md_sections = @claudeMdSections');
        fieldMap.claudeMdSections = JSON.stringify(parsed.claudeMdSections ?? []);
      }
      if (parsed.skills !== undefined) {
        setClauses.push('skills = @skills');
        fieldMap.skills = JSON.stringify(parsed.skills ?? []);
      }
      if (parsed.networkPolicy !== undefined) {
        setClauses.push('network_policy = @networkPolicy');
        fieldMap.networkPolicy = parsed.networkPolicy ? JSON.stringify(parsed.networkPolicy) : null;
      }
      if (parsed.actionPolicy !== undefined) {
        setClauses.push('action_policy = @actionPolicy');
        fieldMap.actionPolicy = parsed.actionPolicy ? JSON.stringify(parsed.actionPolicy) : null;
      }
      if (parsed.outputMode !== undefined) {
        setClauses.push('output_mode = @outputMode');
        fieldMap.outputMode = parsed.outputMode;
      }
      if (parsed.pod !== undefined) {
        setClauses.push(
          'agent_mode = @agentMode',
          'output_target = @outputTarget',
          'validate = @validate',
          'promotable = @promotable',
        );
        fieldMap.agentMode = parsed.pod?.agentMode ?? null;
        fieldMap.outputTarget = parsed.pod?.output ?? null;
        fieldMap.validate =
          parsed.pod?.validate === undefined || parsed.pod === null
            ? null
            : parsed.pod.validate
              ? 1
              : 0;
        fieldMap.promotable =
          parsed.pod?.promotable === undefined || parsed.pod === null
            ? null
            : parsed.pod.promotable
              ? 1
              : 0;
        // Also sync the legacy column if the caller didn't explicitly set it.
        if (parsed.outputMode === undefined && parsed.pod) {
          setClauses.push('output_mode = @outputMode');
          fieldMap.outputMode = outputModeFromPodOptions(parsed.pod);
        }
      }
      if (parsed.modelProvider !== undefined) {
        setClauses.push('model_provider = @modelProvider');
        fieldMap.modelProvider = parsed.modelProvider;
      }
      if (parsed.providerCredentials !== undefined) {
        setClauses.push('provider_credentials = @providerCredentials');
        fieldMap.providerCredentials = encryptCreds(parsed.providerCredentials);
      }
      if (parsed.testCommand !== undefined) {
        setClauses.push('test_command = @testCommand');
        fieldMap.testCommand = parsed.testCommand ?? null;
      }
      if (parsed.buildWorkDir !== undefined) {
        setClauses.push('build_work_dir = @buildWorkDir');
        fieldMap.buildWorkDir = parsed.buildWorkDir ?? null;
      }
      if (parsed.prProvider !== undefined) {
        setClauses.push('pr_provider = @prProvider');
        fieldMap.prProvider = parsed.prProvider;
      }
      if (parsed.adoPat !== undefined) {
        setClauses.push('ado_pat = @adoPat');
        fieldMap.adoPat = encryptPat(parsed.adoPat);
      }
      if (parsed.githubPat !== undefined) {
        setClauses.push('github_pat = @githubPat');
        fieldMap.githubPat = encryptPat(parsed.githubPat);
      }
      if (parsed.privateRegistries !== undefined) {
        setClauses.push('private_registries = @privateRegistries');
        fieldMap.privateRegistries = JSON.stringify(parsed.privateRegistries ?? []);
      }
      if (parsed.registryPat !== undefined) {
        setClauses.push('registry_pat = @registryPat');
        fieldMap.registryPat = encryptPat(parsed.registryPat);
      }
      if (parsed.branchPrefix !== undefined) {
        setClauses.push('branch_prefix = @branchPrefix');
        fieldMap.branchPrefix = parsed.branchPrefix;
      }
      if (parsed.containerMemoryGb !== undefined) {
        setClauses.push('container_memory_gb = @containerMemoryGb');
        fieldMap.containerMemoryGb = parsed.containerMemoryGb ?? null;
      }
      if (parsed.buildTimeout !== undefined) {
        setClauses.push('build_timeout = @buildTimeout');
        fieldMap.buildTimeout = parsed.buildTimeout;
      }
      if (parsed.testTimeout !== undefined) {
        setClauses.push('test_timeout = @testTimeout');
        fieldMap.testTimeout = parsed.testTimeout;
      }
      if (parsed.lintCommand !== undefined) {
        setClauses.push('lint_command = @lintCommand');
        fieldMap.lintCommand = parsed.lintCommand ?? null;
      }
      if (parsed.lintTimeout !== undefined) {
        setClauses.push('lint_timeout = @lintTimeout');
        fieldMap.lintTimeout = parsed.lintTimeout ?? null;
      }
      if (parsed.sastCommand !== undefined) {
        setClauses.push('sast_command = @sastCommand');
        fieldMap.sastCommand = parsed.sastCommand ?? null;
      }
      if (parsed.sastTimeout !== undefined) {
        setClauses.push('sast_timeout = @sastTimeout');
        fieldMap.sastTimeout = parsed.sastTimeout ?? null;
      }
      if (parsed.tokenBudget !== undefined) {
        setClauses.push('token_budget = @tokenBudget');
        fieldMap.tokenBudget = parsed.tokenBudget ?? null;
      }
      if (parsed.tokenBudgetWarnAt !== undefined) {
        setClauses.push('token_budget_warn_at = @tokenBudgetWarnAt');
        fieldMap.tokenBudgetWarnAt = parsed.tokenBudgetWarnAt;
      }
      if (parsed.tokenBudgetPolicy !== undefined) {
        setClauses.push('token_budget_policy = @tokenBudgetPolicy');
        fieldMap.tokenBudgetPolicy = parsed.tokenBudgetPolicy;
      }
      if (parsed.maxBudgetExtensions !== undefined) {
        setClauses.push('max_budget_extensions = @maxBudgetExtensions');
        fieldMap.maxBudgetExtensions = parsed.maxBudgetExtensions ?? null;
      }
      if (parsed.hasWebUi !== undefined) {
        setClauses.push('has_web_ui = @hasWebUi');
        fieldMap.hasWebUi = parsed.hasWebUi === null ? null : parsed.hasWebUi ? 1 : 0;
      }
      if (parsed.issueWatcherEnabled !== undefined) {
        setClauses.push('issue_watcher_enabled = @issueWatcherEnabled');
        fieldMap.issueWatcherEnabled =
          parsed.issueWatcherEnabled === null ? null : parsed.issueWatcherEnabled ? 1 : 0;
      }
      if (parsed.issueWatcherLabelPrefix !== undefined) {
        setClauses.push('issue_watcher_label_prefix = @issueWatcherLabelPrefix');
        fieldMap.issueWatcherLabelPrefix = parsed.issueWatcherLabelPrefix;
      }
      if (parsed.pimActivations !== undefined) {
        setClauses.push('pim_activations = @pimActivations');
        fieldMap.pimActivations = parsed.pimActivations
          ? JSON.stringify(parsed.pimActivations)
          : null;
      }
      if (parsed.mergeStrategy !== undefined) {
        setClauses.push('merge_strategy = @mergeStrategy');
        fieldMap.mergeStrategy = JSON.stringify(parsed.mergeStrategy);
      }
      if (parsed.sidecars !== undefined) {
        setClauses.push('sidecars = @sidecars');
        fieldMap.sidecars = parsed.sidecars ? JSON.stringify(parsed.sidecars) : null;
      }
      if (parsed.trustedSource !== undefined) {
        setClauses.push('trusted_source = @trustedSource');
        fieldMap.trustedSource =
          parsed.trustedSource === null ? null : parsed.trustedSource ? 1 : 0;
      }
      if (parsed.testPipeline !== undefined) {
        setClauses.push('test_pipeline = @testPipeline');
        fieldMap.testPipeline = parsed.testPipeline ? JSON.stringify(parsed.testPipeline) : null;
      }
      if (parsed.securityScan !== undefined) {
        setClauses.push('security_scan = @securityScan');
        fieldMap.securityScan = parsed.securityScan ? JSON.stringify(parsed.securityScan) : null;
      }

      if (setClauses.length === 0) {
        return this.get(name);
      }

      // Always bump version and update timestamp
      setClauses.push('version = version + 1');
      setClauses.push('updated_at = @updatedAt');
      fieldMap.updatedAt = new Date().toISOString();
      fieldMap.name = name;

      db.prepare(`UPDATE profiles SET ${setClauses.join(', ')} WHERE name = @name`).run(fieldMap);

      logger.info(
        {
          name,
          fields: Object.keys(parsed).filter((k) => parsed[k as keyof typeof parsed] !== undefined),
        },
        'Profile updated',
      );
      return this.get(name);
    },

    delete(name: string): void {
      // Verify profile exists
      fetchRaw(name);

      // Check for active pods
      const activeCount = db
        .prepare(
          `SELECT COUNT(*) as count FROM pods WHERE profile_name = ? AND status NOT IN ('complete', 'killed')`,
        )
        .get(name) as { count: number };

      if (activeCount.count > 0) {
        throw new AutopodError('Cannot delete profile with active pods', 'PROFILE_IN_USE', 409);
      }

      // Check if other profiles extend this one
      const children = db.prepare('SELECT name FROM profiles WHERE extends = ?').all(name) as {
        name: string;
      }[];
      if (children.length > 0) {
        const childNames = children.map((c) => c.name).join(', ');
        throw new AutopodError(
          `Cannot delete profile that is extended by: ${childNames}`,
          'PROFILE_HAS_CHILDREN',
          409,
        );
      }

      // Clean up completed/killed pods before deleting (FK constraint)
      db.prepare(
        `DELETE FROM pods WHERE profile_name = ? AND status IN ('complete', 'killed')`,
      ).run(name);

      db.prepare('DELETE FROM profiles WHERE name = ?').run(name);
      logger.info({ name }, 'Profile deleted');
    },

    exists(name: string): boolean {
      const row = db.prepare('SELECT 1 FROM profiles WHERE name = ?').get(name);
      return row !== undefined;
    },

    resolveCredentialOwner(name: string): string | null {
      // Walk up the extends chain — cycle-safe via a visited set.
      const visited = new Set<string>();
      let current: string | null = name;
      while (current !== null && !visited.has(current)) {
        visited.add(current);
        const row = db
          .prepare('SELECT provider_credentials, extends FROM profiles WHERE name = ?')
          .get(current) as
          | { provider_credentials: string | null; extends: string | null }
          | undefined;
        if (!row) return null;
        if (row.provider_credentials !== null && row.provider_credentials !== undefined) {
          return current;
        }
        current = row.extends;
      }
      return null;
    },
  };
}
