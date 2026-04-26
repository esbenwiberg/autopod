export type RuntimeType = 'claude' | 'codex' | 'copilot';

export interface Runtime {
  type: RuntimeType;
  spawn(config: SpawnConfig): AsyncIterable<AgentEvent>;
  resume(
    podId: string,
    message: string,
    containerId: string,
    env?: Record<string, string>,
  ): AsyncIterable<AgentEvent>;
  abort(podId: string): Promise<void>;
  suspend(podId: string): Promise<void>;
}

export interface SpawnConfig {
  podId: string;
  task: string;
  model: string;
  workDir: string;
  containerId: string;
  customInstructions?: string;
  env: Record<string, string>;
  mcpServers?: McpServerConfig[];
}

export type McpServerConfig = HttpMcpServerConfig | StdioMcpServerConfig;

export interface HttpMcpServerConfig {
  type?: 'http';
  name: string;
  url: string;
  headers?: Record<string, string>;
}

export interface StdioMcpServerConfig {
  type: 'stdio';
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export type AgentEvent =
  | AgentStatusEvent
  | AgentToolUseEvent
  | AgentFileChangeEvent
  | AgentCompleteEvent
  | AgentErrorEvent
  | AgentEscalationEvent
  | AgentPlanEvent
  | AgentProgressEvent
  | AgentTaskSummaryEvent;

export interface AgentStatusEvent {
  type: 'status';
  timestamp: string;
  message: string;
}

export interface AgentToolUseEvent {
  type: 'tool_use';
  timestamp: string;
  tool: string;
  input: Record<string, unknown>;
  output?: string;
}

export interface AgentFileChangeEvent {
  type: 'file_change';
  timestamp: string;
  path: string;
  action: 'create' | 'modify' | 'delete';
  diff?: string;
}

export interface AgentCompleteEvent {
  type: 'complete';
  timestamp: string;
  result: string;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  costUsd?: number;
}

export interface AgentErrorEvent {
  type: 'error';
  timestamp: string;
  message: string;
  fatal: boolean;
}

export interface AgentEscalationEvent {
  type: 'escalation';
  timestamp: string;
  escalationType: 'ask_human' | 'ask_ai' | 'report_blocker';
  payload: import('./escalation.js').EscalationRequest;
}

export interface AgentPlanEvent {
  type: 'plan';
  timestamp: string;
  summary: string;
  steps: string[];
}

export interface AgentProgressEvent {
  type: 'progress';
  timestamp: string;
  phase: string;
  description: string;
  currentPhase: number;
  totalPhases: number;
}

export interface AgentTaskSummaryEvent {
  type: 'task_summary';
  timestamp: string;
  actualSummary: string;
  how?: string;
  deviations: Array<{
    step: string;
    planned: string;
    actual: string;
    reason: string;
  }>;
}
