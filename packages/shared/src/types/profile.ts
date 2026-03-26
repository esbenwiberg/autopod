import type { ActionPolicy, OutputMode } from './actions.js';
import type { InjectedClaudeMdSection, InjectedMcpServer, InjectedSkill } from './injection.js';
import type { ModelProvider, ProviderCredentials } from './model-provider.js';
import type { RuntimeType } from './runtime.js';

export type ExecutionTarget = 'local' | 'aci';

export type StackTemplate =
  | 'node22'
  | 'node22-pw'
  | 'dotnet9'
  | 'dotnet10'
  | 'python312'
  | 'custom';

export interface Profile {
  name: string;
  repoUrl: string;
  defaultBranch: string;
  template: StackTemplate;
  buildCommand: string;
  startCommand: string;
  healthPath: string;
  healthTimeout: number;
  smokePages: SmokePage[];
  maxValidationAttempts: number;
  defaultModel: string;
  defaultRuntime: RuntimeType;
  executionTarget: ExecutionTarget;
  customInstructions: string | null;
  escalation: EscalationConfig;
  extends: string | null;
  warmImageTag: string | null;
  warmImageBuiltAt: string | null;
  /** Additional MCP servers for sessions using this profile */
  mcpServers: InjectedMcpServer[];
  /** Additional CLAUDE.md sections for sessions using this profile */
  claudeMdSections: InjectedClaudeMdSection[];
  /** Skills (slash commands) injected into agent sessions */
  skills: InjectedSkill[];
  /** Optional network isolation policy for containers */
  networkPolicy: NetworkPolicy | null;
  /** Action control plane policy — which actions are enabled, PII rules, custom actions */
  actionPolicy: ActionPolicy | null;
  /** Output mode — 'pr' for code changes, 'artifact' for research/output collection */
  outputMode: OutputMode;
  /** Model provider — determines how the daemon authenticates with the AI backend */
  modelProvider: ModelProvider;
  /** Provider-specific credentials (OAuth tokens for MAX, endpoint config for Foundry, etc.) */
  providerCredentials: ProviderCredentials | null;
  /** Optional test command to run after build (e.g. 'pnpm test') */
  testCommand?: string | null;
  /** PR provider — determines which service creates/merges pull requests */
  prProvider: 'github' | 'ado';
  /** ADO Personal Access Token (encrypted at rest). Required when prProvider is 'ado'. */
  adoPat: string | null;
  /** Private package registries (npm/NuGet) for Azure DevOps feeds */
  privateRegistries: PrivateRegistry[];
  /** PAT for authenticating against private registries (encrypted at rest) */
  registryPat: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SmokePage {
  path: string;
  assertions?: PageAssertion[];
}

export interface PageAssertion {
  selector: string;
  type: 'exists' | 'text_contains' | 'visible' | 'count';
  value?: string;
}

export interface NetworkPolicy {
  enabled: boolean;
  /** Additional hosts beyond defaults (api.anthropic.com, registry.npmjs.org, etc.) */
  allowedHosts: string[];
  /** If true, replace the default allowlist entirely (advanced) */
  replaceDefaults?: boolean;
}

export type RegistryType = 'npm' | 'nuget';

export interface PrivateRegistry {
  /** Registry type — determines which config file is generated (.npmrc vs NuGet.config) */
  type: RegistryType;
  /** Full feed URL (e.g. https://pkgs.dev.azure.com/{org}/_packaging/{feed}/npm/registry/) */
  url: string;
  /** npm scope (e.g. '@myorg') — only used for npm registries. Omit to override the default registry. */
  scope?: string;
}

export interface EscalationConfig {
  askHuman: boolean;
  askAi: {
    enabled: boolean;
    model: string;
    maxCalls: number;
  };
  autoPauseAfter: number;
  humanResponseTimeout: number;
}
