// Types
export type {
  SessionStatus,
  Session,
  CreateSessionRequest,
  SessionSummary,
} from './types/session.js';

export type {
  Profile,
  StackTemplate,
  ExecutionTarget,
  ValidationPage,
  PageAssertion,
  EscalationConfig,
  NetworkPolicy,
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

export type {
  InjectedMcpServer,
  InjectedClaudeMdSection,
} from './types/injection.js';

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
} from './types/runtime.js';

export type {
  ValidationResult,
  SmokeResult,
  BuildResult,
  HealthResult,
  PageResult,
  AssertionResult,
  TaskReviewResult,
} from './types/validation.js';

export type {
  EscalationType,
  EscalationRequest,
  AskHumanPayload,
  AskAiPayload,
  ReportBlockerPayload,
  EscalationResponse,
} from './types/escalation.js';

export type {
  SystemEvent,
  SessionCreatedEvent,
  SessionStatusChangedEvent,
  AgentActivityEvent,
  ValidationStartedEvent,
  ValidationCompletedEvent,
  EscalationCreatedEvent,
  EscalationResolvedEvent,
  SessionCompletedEvent,
} from './types/events.js';

export type {
  NotificationType,
  NotificationPayload,
  SessionValidatedNotification,
  SessionFailedNotification,
  SessionNeedsInputNotification,
  SessionErrorNotification,
} from './types/notification.js';

export type {
  AuthToken,
  AppRole,
  JwtPayload,
  DaemonConnection,
} from './types/auth.js';

// Errors (runtime values, not just types)
export {
  AutopodError,
  AuthError,
  ForbiddenError,
  SessionNotFoundError,
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
  SESSION_ID_LENGTH,
  DEFAULT_MAX_VALIDATION_ATTEMPTS,
  DEFAULT_HEALTH_TIMEOUT,
  DEFAULT_HUMAN_RESPONSE_TIMEOUT,
  DEFAULT_MAX_AI_ESCALATIONS,
  DEFAULT_AUTO_PAUSE_AFTER,
  MAX_BUILD_LOG_LENGTH,
  MAX_DIFF_LENGTH,
  SCREENSHOT_QUALITY,
  EVENT_LOG_RETENTION_DAYS,
  VALID_STATUS_TRANSITIONS,
} from './constants.js';

// Schemas (runtime values — Zod objects)
export {
  createSessionRequestSchema,
  sessionStatusSchema,
  sendMessageSchema,
} from './schemas/session.schema.js';

export {
  createProfileSchema,
  updateProfileSchema,
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
export { generateId } from './id.js';
