import type { ActionPolicy, OutputMode } from './actions.js';
import type { InjectedClaudeMdSection, InjectedMcpServer, InjectedSkill } from './injection.js';
import type { ModelProvider, ProviderCredentials } from './model-provider.js';
import type { PodOptions } from './pod-options.js';
import type { RuntimeType } from './runtime.js';
import type { SecurityScanPolicy } from './security-scan.js';
import type { SidecarsConfig } from './sidecar.js';

export type ExecutionTarget = 'local' | 'aci';

/**
 * Fields whose inheritance behavior can be switched from merge (the default —
 * append/deep-merge with the parent's value) to replace (use only the child's
 * value, discard the parent's).
 *
 * Note: an empty array in the raw row still means "inherit" (not "empty list")
 * to preserve existing semantics. Use `mergeStrategy.<field> = 'replace'` with
 * an empty array to explicitly produce an empty list.
 */
export type MergeableField =
  | 'smokePages'
  | 'customInstructions'
  | 'escalation'
  | 'mcpServers'
  | 'claudeMdSections'
  | 'skills'
  | 'privateRegistries';

export type MergeMode = 'merge' | 'replace';
export type MergeStrategy = Partial<Record<MergeableField, MergeMode>>;

export type StackTemplate =
  | 'node22'
  | 'node22-pw'
  | 'dotnet9'
  | 'dotnet10'
  | 'dotnet10-go'
  | 'python312'
  | 'python-node'
  | 'go124'
  | 'go124-pw'
  | 'custom';

/**
 * Profile shape. For derived profiles, most fields may be null — null means
 * "inherit from parent". After `resolveInheritance()` the nulls are filled in
 * from the parent chain (which must bottom out at a base profile with real
 * values), so runtime readers of a resolved Profile see non-null values for
 * these fields even though TypeScript keeps the `| null` for the raw shape.
 */
export interface Profile {
  name: string;
  repoUrl: string | null;
  defaultBranch: string | null;
  template: StackTemplate | null;
  /** Null on derived profiles (extends != null) means "inherit from parent". */
  buildCommand: string | null;
  /** Null on derived profiles (extends != null) means "inherit from parent". */
  startCommand: string | null;
  /** Optional subdirectory (relative to /workspace) where build/test/start commands run. */
  buildWorkDir: string | null;
  healthPath: string | null;
  healthTimeout: number | null;
  smokePages: SmokePage[];
  maxValidationAttempts: number | null;
  defaultModel: string | null;
  reviewerModel: string | null;
  defaultRuntime: RuntimeType | null;
  executionTarget: ExecutionTarget | null;
  customInstructions: string | null;
  escalation: EscalationConfig | null;
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
  /**
   * Profile-level default pod configuration (agent mode, output target, etc.).
   * Optional — when null, session creation falls back to `outputMode` or
   * built-in defaults (`{auto, pr}`). Per-session overrides shallow-merge
   * over this.
   */
  pod: PodOptions | null;
  /**
   * @deprecated Mirrors `pod` for wire/storage back-compat. New code should
   * read `pod` directly. Kept in sync by the profile store.
   */
  outputMode: OutputMode | null;
  /** Model provider — determines how the daemon authenticates with the AI backend */
  modelProvider: ModelProvider | null;
  /** Provider-specific credentials (OAuth tokens for MAX, endpoint config for Foundry, etc.) */
  providerCredentials: ProviderCredentials | null;
  /** Optional test command to run after build (e.g. 'pnpm test') */
  testCommand?: string | null;
  /** Build phase timeout in seconds. Default 300 (5 min). */
  buildTimeout: number | null;
  /** Test phase timeout in seconds. Default 600 (10 min). */
  testTimeout: number | null;
  /** Optional lint command to run after tests (e.g. 'biome lint .') */
  lintCommand?: string | null;
  /** Lint phase timeout in seconds. Default 120 (2 min). */
  lintTimeout?: number | null;
  /** Optional SAST command to run after lint (e.g. 'semgrep --config=p/security-audit .') */
  sastCommand?: string | null;
  /** SAST phase timeout in seconds. Default 300 (5 min). */
  sastTimeout?: number | null;
  /** PR provider — determines which service creates/merges pull requests */
  prProvider: 'github' | 'ado' | null;
  /** ADO Personal Access Token (encrypted at rest). Required when prProvider is 'ado'. */
  adoPat: string | null;
  /** GitHub Personal Access Token (encrypted at rest). Used for PR creation and action read access. */
  githubPat: string | null;
  /** Private package registries (npm/NuGet) for Azure DevOps feeds */
  privateRegistries: PrivateRegistry[];
  /** PAT for authenticating against private registries (encrypted at rest) */
  registryPat: string | null;
  /** Branch name prefix for auto-generated session branches. Defaults to 'autopod/'. */
  branchPrefix: string | null;
  /** Container memory limit in GB. null = no limit (Docker default). */
  containerMemoryGb: number | null;
  /** Auto-incremented on every profile update. Useful for auditing which config a session ran under. */
  version: number;
  /** Maximum total tokens (input + output) allowed per session. null = unlimited. */
  tokenBudget: number | null;
  /** Fraction of tokenBudget at which a warning event is emitted. E.g. 0.8 = warn at 80%. */
  tokenBudgetWarnAt: number | null;
  /** What to do when the budget is exceeded: 'soft' = pause for user approval, 'hard' = fail immediately. */
  tokenBudgetPolicy: 'soft' | 'hard' | null;
  /** How many times a user may approve budget extensions per session. null = unlimited. */
  maxBudgetExtensions: number | null;
  /** Whether the project has a web frontend. When false, AC validation skips browser checks
   *  and the classifier will not produce web-ui validation types. Default true. */
  hasWebUi: boolean | null;
  /** Whether the issue/work-item watcher is enabled for this profile */
  issueWatcherEnabled: boolean | null;
  /** Label prefix to watch for. Default 'autopod'. Triggers on exact match or '<prefix>:<target-profile>' */
  issueWatcherLabelPrefix: string | null;
  /** PIM activations (group membership and/or RBAC roles) auto-activated for sessions using this profile */
  pimActivations: PimActivationConfig[] | null;
  /**
   * Per-field override of merge-vs-replace semantics for merge-special fields.
   * Absent keys default to 'merge' (historical behavior). Only meaningful on
   * derived profiles (those with `extends` set).
   */
  mergeStrategy: MergeStrategy;
  /**
   * Companion-container configs per sidecar type (e.g. `sidecars.dagger`).
   * Pods created against this profile may request any declared sidecar via
   * `CreatePodRequest.requireSidecars`. Null = inherit from parent.
   */
  sidecars: SidecarsConfig | null;
  /**
   * Trust gate for privileged sidecars (currently: Dagger engine). When a
   * sidecar has `privileged: true`, the daemon refuses to spawn it unless the
   * owning profile has `trustedSource: true`. Internal repos with reviewed PRs
   * qualify; public-PR / OSS profiles should not. Null = inherit from parent.
   */
  trustedSource: boolean | null;
  /**
   * Pre-configured ADO test pipeline the agent can trigger for integration
   * validation (`execute_action("ado.run_test_pipeline", ...)`). Secrets live
   * in the test repo's ADO variable groups — pods never see them. Null =
   * inherit from parent / feature disabled.
   */
  testPipeline: TestPipelineConfig | null;
  /**
   * Security scan policy — controls how the daemon scans the cloned repo for
   * secrets, PII, and prompt injection at provisioning and pre-push. Null =
   * inherit from parent or fall back to the bundled `default` preset.
   */
  securityScan: SecurityScanPolicy | null;
  createdAt: string;
  updatedAt: string;
}

export interface TestPipelineConfig {
  enabled: boolean;
  /** Full URL of the test repo (separate from the pod's main repo for blast-radius). */
  testRepo: string;
  /** ADO pipeline definition id to trigger. */
  testPipelineId: number;
  /** Max test runs per pod per hour. Default 10. */
  rateLimitPerHour?: number;
  /** Prefix for temp branches the daemon pushes to the test repo. Default `test-runs/`. */
  branchPrefix?: string;
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

/** Discriminated union covering both PIM for Groups and Azure RBAC role activation. */
export type PimActivationConfig =
  | {
      type: 'group';
      groupId: string;
      displayName?: string;
      /** ISO 8601 duration (e.g. "PT4H"). Defaults to "PT8H". */
      duration?: string;
      justification?: string;
    }
  | {
      type: 'rbac_role';
      /** ARM scope path, e.g. "/subscriptions/{subId}/resourceGroups/{rg}" */
      scope: string;
      /** Role definition UUID, e.g. "73c42c96-874c-492b-b04d-ab87d138a893" (Log Analytics Reader) */
      roleDefinitionId: string;
      displayName?: string;
      /** ISO 8601 duration (e.g. "PT4H"). Defaults to "PT8H". */
      duration?: string;
      justification?: string;
    };

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
