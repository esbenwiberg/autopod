import type {
  ActionPolicy,
  EscalationConfig,
  InjectedClaudeMdSection,
  InjectedMcpServer,
  NetworkPolicy,
  Profile,
  ProviderCredentials,
  ValidationPage,
} from '@autopod/shared';
import {
  AutopodError,
  ProfileExistsError,
  ProfileNotFoundError,
  createProfileSchema,
  updateProfileSchema,
} from '@autopod/shared';
import type Database from 'better-sqlite3';
import pino from 'pino';
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
}

/** Map a SQLite row (snake_case) to a Profile (camelCase). */
function rowToProfile(row: Record<string, unknown>): Profile {
  return {
    name: row.name as string,
    repoUrl: row.repo_url as string,
    defaultBranch: row.default_branch as string,
    template: row.template as Profile['template'],
    buildCommand: row.build_command as string,
    startCommand: row.start_command as string,
    healthPath: row.health_path as string,
    healthTimeout: row.health_timeout as number,
    validationPages: JSON.parse(row.validation_pages as string) as ValidationPage[],
    maxValidationAttempts: row.max_validation_attempts as number,
    defaultModel: row.default_model as string,
    defaultRuntime: row.default_runtime as Profile['defaultRuntime'],
    executionTarget: (row.execution_target as Profile['executionTarget']) ?? 'local',
    customInstructions: (row.custom_instructions as string) ?? null,
    escalation: JSON.parse(row.escalation_config as string) as EscalationConfig,
    extends: (row.extends as string) ?? null,
    warmImageTag: (row.warm_image_tag as string) ?? null,
    warmImageBuiltAt: (row.warm_image_built_at as string) ?? null,
    mcpServers: JSON.parse((row.mcp_servers as string) ?? '[]') as InjectedMcpServer[],
    claudeMdSections: JSON.parse(
      (row.claude_md_sections as string) ?? '[]',
    ) as InjectedClaudeMdSection[],
    networkPolicy: row.network_policy
      ? (JSON.parse(row.network_policy as string) as NetworkPolicy)
      : null,
    actionPolicy: row.action_policy
      ? (JSON.parse(row.action_policy as string) as ActionPolicy)
      : null,
    outputMode: (row.output_mode as Profile['outputMode']) ?? 'pr',
    modelProvider: (row.model_provider as Profile['modelProvider']) ?? 'anthropic',
    providerCredentials: row.provider_credentials
      ? (JSON.parse(row.provider_credentials as string) as ProviderCredentials)
      : null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function createProfileStore(db: Database.Database): ProfileStore {
  /** Fetch a raw profile row from DB, throw if not found. */
  function fetchRaw(name: string): Profile {
    const row = db.prepare('SELECT * FROM profiles WHERE name = ?').get(name) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new ProfileNotFoundError(name);
    return rowToProfile(row);
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

      db.prepare(`
        INSERT INTO profiles (
          name, repo_url, default_branch, template, build_command, start_command,
          health_path, health_timeout, validation_pages, max_validation_attempts,
          default_model, default_runtime, execution_target, custom_instructions, escalation_config,
          extends, mcp_servers, claude_md_sections, network_policy, action_policy, output_mode,
          model_provider, provider_credentials,
          created_at, updated_at
        ) VALUES (
          @name, @repoUrl, @defaultBranch, @template, @buildCommand, @startCommand,
          @healthPath, @healthTimeout, @validationPages, @maxValidationAttempts,
          @defaultModel, @defaultRuntime, @executionTarget, @customInstructions, @escalationConfig,
          @extends, @mcpServers, @claudeMdSections, @networkPolicy, @actionPolicy, @outputMode,
          @modelProvider, @providerCredentials,
          @createdAt, @updatedAt
        )
      `).run({
        name: parsed.name,
        repoUrl: parsed.repoUrl,
        defaultBranch: parsed.defaultBranch,
        template: parsed.template,
        buildCommand: parsed.buildCommand,
        startCommand: parsed.startCommand,
        healthPath: parsed.healthPath,
        healthTimeout: parsed.healthTimeout,
        validationPages: JSON.stringify(parsed.validationPages),
        maxValidationAttempts: parsed.maxValidationAttempts,
        defaultModel: parsed.defaultModel,
        defaultRuntime: parsed.defaultRuntime,
        executionTarget: parsed.executionTarget,
        customInstructions: parsed.customInstructions,
        escalationConfig: JSON.stringify(parsed.escalation),
        extends: parsed.extends,
        mcpServers: JSON.stringify(parsed.mcpServers),
        claudeMdSections: JSON.stringify(parsed.claudeMdSections),
        networkPolicy: parsed.networkPolicy ? JSON.stringify(parsed.networkPolicy) : null,
        actionPolicy: parsed.actionPolicy ? JSON.stringify(parsed.actionPolicy) : null,
        outputMode: parsed.outputMode,
        modelProvider: parsed.modelProvider,
        providerCredentials: parsed.providerCredentials
          ? JSON.stringify(parsed.providerCredentials)
          : null,
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
        const profile = rowToProfile(row);
        return profile.extends ? resolve(profile) : profile;
      });
    },

    update(name: string, changes: Record<string, unknown>): Profile {
      // Verify profile exists
      fetchRaw(name);

      const parsed = updateProfileSchema.parse(changes);

      // If extends is being changed, verify new parent exists
      if (parsed.extends !== undefined && parsed.extends !== null) {
        const parentExists = db
          .prepare('SELECT 1 FROM profiles WHERE name = ?')
          .get(parsed.extends);
        if (!parentExists) throw new ProfileNotFoundError(parsed.extends);
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
      if (parsed.validationPages !== undefined) {
        setClauses.push('validation_pages = @validationPages');
        fieldMap.validationPages = JSON.stringify(parsed.validationPages);
      }
      if (parsed.maxValidationAttempts !== undefined) {
        setClauses.push('max_validation_attempts = @maxValidationAttempts');
        fieldMap.maxValidationAttempts = parsed.maxValidationAttempts;
      }
      if (parsed.defaultModel !== undefined) {
        setClauses.push('default_model = @defaultModel');
        fieldMap.defaultModel = parsed.defaultModel;
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
        fieldMap.escalationConfig = JSON.stringify(parsed.escalation);
      }
      if (parsed.extends !== undefined) {
        setClauses.push('extends = @extends');
        fieldMap.extends = parsed.extends;
      }
      if (parsed.mcpServers !== undefined) {
        setClauses.push('mcp_servers = @mcpServers');
        fieldMap.mcpServers = JSON.stringify(parsed.mcpServers);
      }
      if (parsed.claudeMdSections !== undefined) {
        setClauses.push('claude_md_sections = @claudeMdSections');
        fieldMap.claudeMdSections = JSON.stringify(parsed.claudeMdSections);
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
      if (parsed.modelProvider !== undefined) {
        setClauses.push('model_provider = @modelProvider');
        fieldMap.modelProvider = parsed.modelProvider;
      }
      if (parsed.providerCredentials !== undefined) {
        setClauses.push('provider_credentials = @providerCredentials');
        fieldMap.providerCredentials = parsed.providerCredentials
          ? JSON.stringify(parsed.providerCredentials)
          : null;
      }

      if (setClauses.length === 0) {
        return this.get(name);
      }

      // Always update timestamp
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

      // Check for active sessions
      const activeCount = db
        .prepare(
          `SELECT COUNT(*) as count FROM sessions WHERE profile_name = ? AND status NOT IN ('complete', 'killed')`,
        )
        .get(name) as { count: number };

      if (activeCount.count > 0) {
        throw new AutopodError('Cannot delete profile with active sessions', 'PROFILE_IN_USE', 409);
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

      // Clean up completed/killed sessions before deleting (FK constraint)
      db.prepare(
        `DELETE FROM sessions WHERE profile_name = ? AND status IN ('complete', 'killed')`,
      ).run(name);

      db.prepare('DELETE FROM profiles WHERE name = ?').run(name);
      logger.info({ name }, 'Profile deleted');
    },

    exists(name: string): boolean {
      const row = db.prepare('SELECT 1 FROM profiles WHERE name = ?').get(name);
      return row !== undefined;
    },
  };
}
