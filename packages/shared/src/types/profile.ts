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
  /** Profile to use when spawning worker sessions from a workspace pod using this profile */
  workerProfile: string | null;
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
  /** Build phase timeout in seconds. Default 300 (5 min). */
  buildTimeout: number;
  /** Test phase timeout in seconds. Default 600 (10 min). */
  testTimeout: number;
  /** PR provider — determines which service creates/merges pull requests */
  prProvider: 'github' | 'ado';
  /** ADO Personal Access Token (encrypted at rest). Required when prProvider is 'ado'. */
  adoPat: string | null;
  /** GitHub Personal Access Token (encrypted at rest). Used for PR creation and action read access. */
  githubPat: string | null;
  /** Private package registries (npm/NuGet) for Azure DevOps feeds */
  privateRegistries: PrivateRegistry[];
  /** PAT for authenticating against private registries (encrypted at rest) */
  registryPat: string | null;
  /** Branch name prefix for auto-generated session branches. Defaults to 'autopod/'. */
  branchPrefix: string;
  /** Container memory limit in GB. null = no limit (Docker default). */
  containerMemoryGb: number | null;
  /** Auto-incremented on every profile update. Useful for auditing which config a session ran under. */
  version: number;
  /** Maximum total tokens (input + output) allowed per session. null = unlimited. */
  tokenBudget: number | null;
  /** Fraction of tokenBudget at which a warning event is emitted. E.g. 0.8 = warn at 80%. */
  tokenBudgetWarnAt: number;
  /** What to do when the budget is exceeded: 'soft' = pause for user approval, 'hard' = fail immediately. */
  tokenBudgetPolicy: 'soft' | 'hard';
  /** How many times a user may approve budget extensions per session. null = unlimited. */
  maxBudgetExtensions: number | null;
  /** Whether the project has a web frontend. When false, AC validation skips browser checks
   *  and the classifier will not produce web-ui validation types. Default true. */
  hasWebUi: boolean;
  /** Whether the issue/work-item watcher is enabled for this profile */
  issueWatcherEnabled: boolean;
  /** Label prefix to watch for. Default 'autopod'. Triggers on exact match or '<prefix>:<target-profile>' */
  issueWatcherLabelPrefix: string;
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

export type NetworkPolicyMode = 'allow-all' | 'deny-all' | 'restricted';

export interface NetworkPolicy {
  enabled: boolean;
  /**
   * Firewall mode:
   * - 'allow-all'  — no DROP rule; all outbound traffic is permitted
   * - 'deny-all'   — DROP all outbound (loopback + established still allowed)
   * - 'restricted' — default; only allowedHosts (+ defaults) are permitted
   */
  mode?: NetworkPolicyMode;
  /** Additional hosts beyond defaults (api.anthropic.com, registry.npmjs.org, etc.) */
  allowedHosts: string[];
  /** If true, replace the default allowlist entirely (advanced) */
  replaceDefaults?: boolean;
  /** When true and mode='restricted', auto-allow all common package manager registry hosts */
  allowPackageManagers?: boolean;
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

export interface PimGroupConfig {
  groupId: string;
  displayName?: string;
  /** ISO 8601 duration (e.g. "PT4H"). Defaults to "PT8H". */
  duration?: string;
  justification?: string;
}

export interface EscalationConfig {
  askHuman: boolean;
  askAi: {
    enabled: boolean;
    model: string;
    maxCalls: number;
  };
  advisor: {
    enabled: boolean;
  };
  autoPauseAfter: number;
  humanResponseTimeout: number;
}
