import type {
  ActionDefinition,
  ActionResponse,
  EscalationRequest,
  EscalationResponse,
} from '@autopod/shared';

export interface SessionBridge {
  createEscalation(escalation: EscalationRequest): void;
  resolveEscalation(escalationId: string, response: EscalationResponse): void;
  getAiEscalationCount(sessionId: string): number;
  getMaxAiCalls(sessionId: string): number;
  getAutoPauseThreshold(sessionId: string): number;
  getHumanResponseTimeout(sessionId: string): number;
  getReviewerModel(sessionId: string): string;
  callReviewerModel(sessionId: string, question: string, context?: string): Promise<string>;
  incrementEscalationCount(sessionId: string): void;
  reportPlan(sessionId: string, summary: string, steps: string[]): void;
  reportProgress(
    sessionId: string,
    phase: string,
    description: string,
    currentPhase: number,
    totalPhases: number,
  ): void;
  reportTaskSummary(
    sessionId: string,
    actualSummary: string,
    deviations: Array<{ step: string; planned: string; actual: string; reason: string }>,
  ): void;
  consumeMessages(sessionId: string): { hasMessage: boolean; message?: string };
  /** Check if an action requires human approval before execution */
  actionRequiresApproval(sessionId: string, actionName: string): boolean;
  /** Execute an action via the action control plane */
  executeAction(
    sessionId: string,
    actionName: string,
    params: Record<string, unknown>,
    options?: { skipApprovalCheck?: boolean },
  ): Promise<ActionResponse>;
  /** Get all action definitions available for a session's profile */
  getAvailableActions(sessionId: string): ActionDefinition[];

  /** Write a file into the session's container. Throws if no container. */
  writeFileInContainer(sessionId: string, path: string, content: string): Promise<void>;

  /** Execute a command in the session's container. Throws if no container. */
  execInContainer(
    sessionId: string,
    command: string[],
    options?: { cwd?: string; timeout?: number },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;

  /** Get the host-accessible URL for the session's app (e.g. http://127.0.0.1:45678). */
  getPreviewUrl(sessionId: string): string | null;

  /**
   * Run a Playwright script on the daemon host (not inside the container).
   * Returns null if host-side Playwright is not available.
   */
  runBrowserOnHost(
    sessionId: string,
    script: string,
    timeout: number,
  ): Promise<{ stdout: string; stderr: string; exitCode: number } | null>;

  /** Read a file from the daemon host filesystem as base64. Returns null if not found. */
  readHostScreenshot(path: string): Promise<string | null>;

  /** Get the host-side screenshot directory for a session, or null if host browser unavailable. */
  getHostScreenshotDir(sessionId: string): string | null;

  /** Get the linked session ID for a workspace (if any). */
  getLinkedSessionId(sessionId: string): string | null;

  /** Trigger revalidation on a linked failed worker session (pull + validate, no agent). */
  revalidateLinkedSession(
    linkedSessionId: string,
  ): Promise<{ newCommits: boolean; result: 'pass' | 'fail' }>;
}
