import type {
  ActionPolicy,
  CodeIntelligenceConfig,
  DeploymentConfig,
  EscalationConfig,
  ExecutionTarget,
  InjectedClaudeMdSection,
  InjectedMcpServer,
  InjectedSkill,
  ModelProvider,
  NetworkPolicy,
  OutputMode,
  PimActivationConfig,
  PodOptions,
  PrivateRegistry,
  ProviderCredentials,
  ProviderFailoverPolicy,
  ReasoningEffort,
  RuntimeType,
  SecurityScanPolicy,
  SidecarsConfig,
  SmokePage,
  StackTemplate,
  TestPipelineConfig,
  ValidationPhase,
} from '@autopod/shared';

/** Per-pod engine inputs resolved from the launch snapshot, never a stored reusable profile. */
export interface PodExecutionSettings {
  /** Legacy runtime-only extensions; new launch resolution does not read these from profiles. */
  contentProcessing?: import('@autopod/shared').ProcessContentConfig;
  reuseFixPod?: boolean;
  name: string;
  repoUrl: string | null;
  defaultBranch: string | null;
  template: StackTemplate | null;
  buildCommand: string | null;
  startCommand: string | null;
  buildWorkDir: string | null;
  healthPath: string | null;
  healthTimeout: number | null;
  smokePages: SmokePage[];
  maxValidationAttempts: number | null;
  defaultModel: string | null;
  reviewerModel: string | null;
  defaultRuntime: RuntimeType | null;
  reasoningEffort: ReasoningEffort | null;
  executionTarget: ExecutionTarget | null;
  customInstructions: string | null;
  agentDonePrompt: string | null;
  escalation: EscalationConfig | null;
  warmImageTag: string | null;
  mcpServers: InjectedMcpServer[];
  claudeMdSections: InjectedClaudeMdSection[];
  skills: InjectedSkill[];
  networkPolicy: NetworkPolicy | null;
  actionPolicy: ActionPolicy | null;
  pod: PodOptions | null;
  outputMode: OutputMode | null;
  modelProvider: ModelProvider | null;
  providerAccountId: string | null;
  providerFailover: ProviderFailoverPolicy | null;
  providerCredentials: ProviderCredentials | null;
  testCommand?: string | null;
  validationSetupCommand?: string | null;
  buildEnv: Record<string, string> | null;
  buildTimeout: number | null;
  testTimeout: number | null;
  lintCommand?: string | null;
  lintTimeout?: number | null;
  sastCommand?: string | null;
  sastTimeout?: number | null;
  mergePollIntervalSec?: number | null;
  preflightConflictPolicy?: 'warn' | 'block' | null;
  prProvider: 'github' | 'ado' | null;
  githubPatExpiresAt?: string | null;
  privateRegistries: PrivateRegistry[];
  registryPat: string | null;
  registryPatExpiresAt?: string | null;
  branchPrefix: string | null;
  containerMemoryGb: number | null;
  tokenBudget: number | null;
  tokenBudgetWarnAt: number | null;
  tokenBudgetPolicy: 'soft' | 'hard' | null;
  maxBudgetExtensions: number | null;
  hasWebUi: boolean | null;
  pimActivations: PimActivationConfig[] | null;
  sidecars: SidecarsConfig | null;
  trustedSource: boolean | null;
  testPipeline: TestPipelineConfig | null;
  securityScan: SecurityScanPolicy | null;
  deployment: DeploymentConfig | null;
  codeIntelligence: CodeIntelligenceConfig | null;
  skipValidationPhases: ValidationPhase[] | null;
}
