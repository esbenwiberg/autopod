// ─── Action Group ───────────────────────────────────────────────
export type ActionGroup =
  | 'github-issues'
  | 'github-prs'
  | 'github-code'
  | 'ado-workitems'
  | 'azure-logs'
  | 'custom';

export type ActionHandler = 'github' | 'ado' | 'azure-logs' | 'http';

// ─── Auth Config ────────────────────────────────────────────────
export type AuthConfig =
  | { type: 'bearer'; secret: string }
  | { type: 'basic'; username: string; password: string }
  | { type: 'custom-header'; name: string; value: string }
  | { type: 'none' };

// ─── Parameter Definition ───────────────────────────────────────
export interface ParamDef {
  type: 'string' | 'number' | 'boolean';
  required: boolean;
  description: string;
  default?: unknown;
  enum?: string[];
}

// ─── Action Definition ──────────────────────────────────────────
export interface ActionDefinition {
  name: string;
  description: string;
  group: ActionGroup;
  handler: ActionHandler;

  /** What the agent passes as input */
  params: Record<string, ParamDef>;

  /** HTTP-specific config (handler: 'http') */
  endpoint?: {
    url: string;
    method: 'GET' | 'POST' | 'PUT';
    auth?: AuthConfig;
    timeout?: number;
  };
  request?: {
    bodyMapping?: Record<string, string>;
    queryMapping?: Record<string, string>;
    pathMapping?: Record<string, string>;
  };

  /** Response processing — shared by all handlers */
  response: {
    resultPath?: string;
    fields: string[];
    redactFields?: string[];
  };
}

// ─── Action Override ────────────────────────────────────────────
export interface ActionOverride {
  action: string;
  allowedResources?: string[];
  requiresApproval?: boolean;
  disabled?: boolean;
}

// ─── Data Sanitization Config ───────────────────────────────────
export type SanitizationPreset = 'strict' | 'standard' | 'relaxed';

export interface DataSanitizationConfig {
  preset: SanitizationPreset;
  allowedDomains?: string[];
}

// ─── Quarantine Config ──────────────────────────────────────────
export interface QuarantineConfig {
  enabled: boolean;
  threshold: number;
  blockThreshold: number;
  onBlock: 'skip' | 'ask_human';
}

// ─── Action Policy (on Profile) ─────────────────────────────────
export interface ActionPolicy {
  enabledGroups: ActionGroup[];
  enabledActions?: string[];
  actionOverrides?: ActionOverride[];
  customActions?: ActionDefinition[];
  sanitization: DataSanitizationConfig;
  quarantine?: QuarantineConfig;
}

// ─── Output Mode ────────────────────────────────────────────────
export type OutputMode = 'pr' | 'artifact' | 'workspace';

// ─── Runtime types (action engine request/response) ─────────────
export interface ActionRequest {
  sessionId: string;
  actionName: string;
  params: Record<string, unknown>;
  /** Set by MCP layer after human approval — bypasses requiresApproval check in engine */
  skipApprovalCheck?: boolean;
}

export interface ActionResponse {
  success: boolean;
  data?: unknown;
  error?: string;
  sanitized: boolean;
  quarantined: boolean;
}

// ─── Audit ──────────────────────────────────────────────────────
export interface ActionAuditEntry {
  id: number;
  sessionId: string;
  actionName: string;
  params: Record<string, unknown>;
  responseSummary: string | null;
  piiDetected: boolean;
  quarantineScore: number;
  createdAt: string;
}
