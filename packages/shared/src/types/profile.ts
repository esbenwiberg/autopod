import type { RuntimeType } from './runtime.js';
import type { InjectedMcpServer, InjectedClaudeMdSection } from './injection.js';

export type ExecutionTarget = 'local' | 'aci';

export type StackTemplate = 'node22' | 'node22-pw' | 'dotnet9' | 'python312' | 'custom';

export interface Profile {
  name: string;
  repoUrl: string;
  defaultBranch: string;
  template: StackTemplate;
  buildCommand: string;
  startCommand: string;
  healthPath: string;
  healthTimeout: number;
  validationPages: ValidationPage[];
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
  createdAt: string;
  updatedAt: string;
}

export interface ValidationPage {
  path: string;
  assertions?: PageAssertion[];
}

export interface PageAssertion {
  selector: string;
  type: 'exists' | 'text_contains' | 'visible' | 'count';
  value?: string;
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
