// Types
export type {
  PodStatus,
  Pod,
  CreatePodRequest,
  PodSummary,
  ReferenceRepo,
} from './types/pod.js';

export type {
  Profile,
  StackTemplate,
  ExecutionTarget,
  SmokePage,
  PageAssertion,
  EscalationConfig,
  NetworkPolicy,
  NetworkPolicyMode,
  PimGroupConfig,
  PimActivationConfig,
  PrivateRegistry,
  RegistryType,
} from './types/profile.js';

export type {
  ActionGroup,
  ActionHandler,
  AuthConfig,
  ParamDef,
  ActionDefinition,
  ActionOverride,
  SanitizationPreset,
  DataSanitizationConfig,
  QuarantineConfig,
  ActionPolicy,
  OutputMode,
  ActionRequest,
  ActionResponse,
  ActionAuditEntry,
} from './types/actions.js';

export type { AgentMode, OutputTarget, PodOptions } from './types/pod-options.js';
export {
  podOptionsFromOutputMode,
  outputModeFromPodOptions,
  resolvePodOptions,
} from './types/pod-options.js';

export type {
  InjectedMcpServer,
  InjectedClaudeMdSection,
  InjectedSkill,
  LocalSkillSource,
  GithubSkillSource,
} from './types/injection.js';

export type {
  ModelProvider,
  ProviderCredentials,
  AnthropicCredentials,
  MaxCredentials,
  FoundryCredentials,
} from './types/model-provider.js';

export type {
  RuntimeType,
  Runtime,
  SpawnConfig,
  McpServerConfig,
  AgentEvent,
  AgentStatusEvent,
  AgentToolUseEvent,
  AgentFileChangeEvent,
  AgentCompleteEvent,
  AgentErrorEvent,
  AgentEscalationEvent,
  AgentPlanEvent,
  AgentProgressEvent,
  AgentTaskSummaryEvent,
} from './types/runtime.js';

export type {
  ValidationResult,
  SmokeResult,
  BuildResult,
  HealthResult,
  PageResult,
  AssertionResult,
  TaskReviewResult,
  RequirementsCheckItem,
  AcValidationResult,
  AcCheckResult,
  ValidationFinding,
  ValidationOverride,
} from './types/validation.js';

export type { DeviationItem, TaskSummary, DeviationsAssessment } from './types/task-summary.js';

export type {
  EscalationType,
  EscalationRequest,
  AskHumanPayload,
  AskAiPayload,
  ReportBlockerPayload,
  ActionApprovalPayload,
  ValidationOverridePayload,
  RequestCredentialPayload,
  EscalationResponse,
} from './types/escalation.js';

export type {
  SystemEvent,
  ValidationPhase,
  PodCreatedEvent,
  PodStatusChangedEvent,
  AgentActivityEvent,
  ValidationStartedEvent,
  ValidationCompletedEvent,
  ValidationPhaseStartedEvent,
  ValidationPhaseCompletedEvent,
  EscalationCreatedEvent,
  EscalationResolvedEvent,
  PodCompletedEvent,
  MemorySuggestionCreatedEvent,
  ValidationOverrideQueuedEvent,
  TokenBudgetWarningEvent,
  TokenBudgetExceededEvent,
  ScheduledJobCatchupRequestedEvent,
  ScheduledJobFiredEvent,
  IssueWatcherPickedUpEvent,
  IssueWatcherCompletedEvent,
  IssueWatcherErrorEvent,
} from './types/events.js';

export type { WatchedIssue, WatchedIssueStatus } from './types/issue-watcher.js';

export type {
  ScheduledJob,
  CreateScheduledJobRequest,
  UpdateScheduledJobRequest,
} from './types/scheduled-job.js';

export type {
  NotificationType,
  NotificationPayload,
  PodValidatedNotification,
  PodFailedNotification,
  PodNeedsInputNotification,
  PodErrorNotification,
} from './types/notification.js';

export type {
  AuthToken,
  AppRole,
  JwtPayload,
  DaemonConnection,
} from './types/auth.js';

export type { HistoryQuery, HistoryExportStats } from './types/history.js';

export type { MemoryScope, MemoryEntry } from './types/memory.js';

// Errors (runtime values, not just types)
export {
  AutopodError,
  AuthError,
  ForbiddenError,
  PodNotFoundError,
  InvalidStateTransitionError,
  ProfileNotFoundError,
  ProfileExistsError,
  ContainerError,
  ValidationError,
  EscalationNotFoundError,
  RuntimeError,
} from './errors.js';

// Constants (runtime values)
export {
  POD_ID_LENGTH,
  DEFAULT_MAX_VALIDATION_ATTEMPTS,
  DEFAULT_MAX_PR_FIX_ATTEMPTS,
  DEFAULT_HEALTH_TIMEOUT,
  DEFAULT_HUMAN_RESPONSE_TIMEOUT,
  DEFAULT_MAX_AI_ESCALATIONS,
  DEFAULT_AUTO_PAUSE_AFTER,
  MAX_BUILD_LOG_LENGTH,
  MAX_DIFF_LENGTH,
  SCREENSHOT_QUALITY,
  EVENT_LOG_RETENTION_DAYS,
  DEFAULT_CONTAINER_MEMORY_GB,
  MAX_MEMORY_INDEX_ENTRIES,
  VALID_STATUS_TRANSITIONS,
  CONTAINER_USER,
  CONTAINER_HOME_DIR,
  AUTOPOD_INSTRUCTIONS_PATH,
} from './constants.js';

// Schemas (runtime values — Zod objects)
export {
  createPodRequestSchema,
  podStatusSchema,
  sendMessageSchema,
} from './schemas/pod.schema.js';

export {
  createProfileSchema,
  updateProfileSchema,
  escalationConfigSchema,
  modelProviderSchema,
  providerCredentialsSchema,
  pimActivationConfigSchema,
} from './schemas/profile.schema.js';

export {
  actionDefinitionSchema,
  actionPolicySchema,
  actionOverrideSchema,
  actionGroupSchema,
  actionHandlerSchema,
  authConfigSchema,
  paramDefSchema,
  dataSanitizationConfigSchema,
  quarantineConfigSchema,
  outputModeSchema,
  sanitizationPresetSchema,
} from './schemas/action-definition.schema.js';

export {
  injectedSkillSchema,
  injectedMcpServerSchema,
  injectedClaudeMdSectionSchema,
} from './schemas/injection.schema.js';

export {
  daemonConfigSchema,
  type DaemonConfig,
} from './schemas/config.schema.js';

// Sanitize + quarantine pipeline
export {
  sanitize,
  sanitizeDeep,
  getPresetConfig,
  quarantine,
  processContent,
  processContentDeep,
  PII_PATTERNS,
  INJECTION_PATTERNS,
  REDACT_FIELD_NAMES,
} from './sanitize/index.js';

export type {
  PiiPattern,
  InjectionPattern,
  QuarantineResult,
  ThreatIndicator,
  ProcessedContent,
  ProcessContentConfig,
} from './sanitize/index.js';

// ID generation utility
export { generateId, generatePodId } from './id.js';

// AC list parser
export { parseAcList } from './parse-ac-list.js';
