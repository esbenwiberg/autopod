export type RuntimeType = 'claude' | 'codex';

export interface Runtime {
  type: RuntimeType;
  spawn(config: SpawnConfig): AsyncIterable<AgentEvent>;
  resume(
    sessionId: string,
    message: string,
    containerId: string,
    env?: Record<string, string>,
  ): AsyncIterable<AgentEvent>;
  abort(sessionId: string): Promise<void>;
  suspend(sessionId: string): Promise<void>;
}

export interface SpawnConfig {
  sessionId: string;
  task: string;
  model: string;
  workDir: string;
  containerId: string;
  customInstructions?: string;
  env: Record<string, string>;
  mcpServers?: McpServerConfig[];
}

export interface McpServerConfig {
  name: string;
  url: string;
  headers?: Record<string, string>;
}

export type AgentEvent =
  | AgentStatusEvent
  | AgentToolUseEvent
  | AgentFileChangeEvent
  | AgentCompleteEvent
  | AgentErrorEvent
  | AgentEscalationEvent
  | AgentPlanEvent
  | AgentProgressEvent;

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
