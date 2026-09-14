import type { z } from 'zod';
import type {
  agentRouteSchema,
  configurationKindSchema,
  configurationPayloadSchemas,
  configurationRevisionSchema,
  executionSettingsSchema,
  launchOverridesSchema,
  launchRequestSchema,
  pimSelectionSchema,
  savedLaunchSelectionSchema,
} from '../schemas/launch-config.schema.js';
import type { ResolvedCredentialReference } from './configuration-credential.js';
import type { ModelProvider } from './model-provider.js';

export type ConfigurationKind = z.infer<typeof configurationKindSchema>;
export type ConfigurationPayloads = {
  [K in ConfigurationKind]: z.infer<(typeof configurationPayloadSchemas)[K]>;
};
export type ConfigurationRevision = z.infer<typeof configurationRevisionSchema>;
export type ConfigurationEntity<K extends ConfigurationKind = ConfigurationKind> = {
  [P in K]: ConfigurationRevision & { kind: P; payload: ConfigurationPayloads[P] };
}[K];
export type RepositoryConfig = ConfigurationPayloads['repository'];
export type RepositorySetup = RepositoryConfig['setups'][number];
export type EnvironmentPreset = ConfigurationPayloads['environment'];
export type AiPreset = ConfigurationPayloads['ai'];
export type AgentRoute = z.infer<typeof agentRouteSchema>;
export type WorkflowPreset = ConfigurationPayloads['workflow'];
export type GitHubAccessPreset = ConfigurationPayloads['githubAccess'];
export type ToolPack = ConfigurationPayloads['toolPack'];
export type LaunchProfile = ConfigurationPayloads['profile'];
export type LaunchRequest = z.infer<typeof launchRequestSchema>;
export type SavedLaunchSelection = z.infer<typeof savedLaunchSelectionSchema>;
export type LaunchOrigin =
  | { kind: 'follow-up'; podId: string; digest: string; configuration: 'current' }
  | { kind: 'series'; seriesId: string; briefTitle: string }
  | { kind: 'schedule'; jobId: string; runKey: string }
  | {
      kind: 'issue-watcher';
      watcherId: string;
      issueId: string;
      triggerLabel: string;
      labelPrefix: string;
    };
export type LaunchOverrides = z.infer<typeof launchOverridesSchema>;
export type ExecutionSettings = z.infer<typeof executionSettingsSchema>;
export type PimSelection = z.infer<typeof pimSelectionSchema>;
export interface ResolvedAllocation {
  memoryGb: number;
  cpus: number | null;
  storageGb: number | null;
}
export interface ExecutionCapabilities {
  target: ExecutionSettings['target'];
  available: boolean;
  unavailableReason?: string;
  defaults: ResolvedAllocation;
  maxMemoryGb: number;
  maxCpus: number | null;
  maxStorageGb: number | null;
  memoryTiersGb: number[] | null;
  sidecars: boolean;
  privilegedSidecars: boolean;
  sidecarStorageLimit: boolean;
  maxTotalMemoryGb: number;
  maxTotalCpus: number | null;
  sidecarDefaults: Record<EnvironmentPreset['sidecars'][number]['type'], ResolvedAllocation>;
}
export interface ResolvedExecution {
  target: ExecutionSettings['target'];
  main: ResolvedAllocation;
  sidecars: Record<string, ResolvedAllocation>;
  totalMemoryGb: number;
  totalCpus: number | null;
}
export interface ResolvedEnvironment {
  pinnedBase: string;
  platform: 'linux/amd64' | 'linux/arm64';
  agentToolingDigest: string;
  toolInstallCommands: string[];
  imageKey: string;
}
export interface ResolvedAgentAccount {
  accountId: string;
  providerId: string;
  adapter: ModelProvider;
  createdAt: string;
}
export interface ResolvedGitHubRule {
  rule: GitHubAccessPreset['rules'][number];
  repositoryIds: string[];
  workflowBindings: Array<{ repositoryId: string; path: string; workflowId: string }>;
}
export interface LaunchProvenance {
  source: 'default' | 'repository' | 'profile' | 'preset' | 'override';
  entityId?: string;
  revision?: number;
}
export interface EffectiveLaunchConfig {
  schemaVersion: 1;
  repository: { id: string; config: RepositoryConfig; setup: RepositorySetup } | null;
  profileId: string;
  task: string;
  /** Daemon-owned caller identity. Never accepted in a public launch request. */
  origin?: LaunchOrigin;
  work: NonNullable<LaunchRequest['work']>;
  derivation?: {
    podId: string;
    digest: string;
    kind:
      | 'fix'
      | 'worker'
      | 'rerun'
      | 'watcher-worker'
      | 'manual-fix'
      | 'follow-up'
      | 'goal-rework'
      | 'spawn-worker';
  };
  intent: 'task' | 'goal';
  environment: EnvironmentPreset;
  resolvedEnvironment: ResolvedEnvironment;
  ai: AiPreset;
  agentAccounts: Record<string, ResolvedAgentAccount>;
  credentialReferences: Record<string, ResolvedCredentialReference>;
  workflow: WorkflowPreset;
  githubAccess: ResolvedGitHubRule[];
  execution: ExecutionSettings;
  requiredSidecarIds: string[];
  resolvedExecution: ResolvedExecution;
  pim: PimSelection[];
  toolPacks: ToolPack[];
  toolContents: Record<string, { content: string; digest: string }>;
  references: Array<{ id: string; remote: string; revision: string }>;
  revisions: ConfigurationRevision[];
  provenance: Record<string, LaunchProvenance>;
  worker: EffectiveLaunchConfig | null;
  digest: string;
}
