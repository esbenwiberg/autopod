import type {
  ActionDefinition,
  ActionResponse,
  EscalationRequest,
  EscalationResponse,
  MemoryEntry,
  MemoryScope,
} from '@autopod/shared';

export interface PodBridge {
  createEscalation(escalation: EscalationRequest): void;
  resolveEscalation(escalationId: string, response: EscalationResponse): void;
  getAiEscalationCount(podId: string): number;
  getMaxAiCalls(podId: string): number;
  getAutoPauseThreshold(podId: string): number;
  getHumanResponseTimeout(podId: string): number;
  getReviewerModel(podId: string): string;
  callReviewerModel(podId: string, question: string, context?: string): Promise<string>;
  incrementEscalationCount(podId: string): void;
  reportPlan(podId: string, summary: string, steps: string[]): void;
  reportProgress(
    podId: string,
    phase: string,
    description: string,
    currentPhase: number,
    totalPhases: number,
  ): void;
  reportTaskSummary(
    podId: string,
    actualSummary: string,
    deviations: Array<{ step: string; planned: string; actual: string; reason: string }>,
    how?: string,
  ): void;
  consumeMessages(podId: string): { hasMessage: boolean; message?: string };
  /** Check if an action requires human approval before execution */
  actionRequiresApproval(podId: string, actionName: string): boolean;
  /**
   * Optionally called before creating a human-approval escalation.
   * Handlers that need to show additional context to the reviewer (e.g. deploy
   * script content) implement this. The returned object is:
   *  - Included in the escalation payload so the human sees it before approving
   *  - Forwarded to the action handler after approval as `request.approvalContext`
   *    so it can perform post-approval verification (e.g. hash check).
   * Returns undefined when the action has no special approval context.
   */
  getActionApprovalContext?(
    podId: string,
    actionName: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown> | undefined>;
  /** Execute an action via the action control plane */
  executeAction(
    podId: string,
    actionName: string,
    params: Record<string, unknown>,
    options?: { skipApprovalCheck?: boolean; approvalContext?: Record<string, unknown> },
  ): Promise<ActionResponse>;
  /** Get all action definitions available for a pod's profile */
  getAvailableActions(podId: string): ActionDefinition[];

  /** Write a file into the pod's container. Throws if no container. */
  writeFileInContainer(podId: string, path: string, content: string): Promise<void>;

  /** Execute a command in the pod's container. Throws if no container. */
  execInContainer(
    podId: string,
    command: string[],
    options?: { cwd?: string; timeout?: number },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;

  /** Get the host-accessible URL for the pod's app (e.g. http://127.0.0.1:45678). */
  getPreviewUrl(podId: string): string | null;

  /**
   * Run a Playwright script on the daemon host (not inside the container).
   * Returns null if host-side Playwright is not available.
   */
  runBrowserOnHost(
    podId: string,
    script: string,
    timeout: number,
  ): Promise<{ stdout: string; stderr: string; exitCode: number } | null>;

  /** Read a file from the daemon host filesystem as base64. Returns null if not found. */
  readHostScreenshot(path: string): Promise<string | null>;

  /** Get the host-side screenshot directory for a pod, or null if host browser unavailable. */
  getHostScreenshotDir(podId: string): string | null;

  /** Get the linked pod ID for a workspace (if any). */
  getLinkedPodId(podId: string): string | null;

  /** Returns true if ask_human calls should be auto-resolved via the reviewer model (series unattended mode). */
  isAskHumanDisabled(podId: string): boolean;

  /** List approved memories for the given scope. */
  listMemories(podId: string, scope: MemoryScope): MemoryEntry[];

  /** Read a single memory entry by ID. */
  readMemory(podId: string, id: string): MemoryEntry;

  /** Search memories by text within the given scope. */
  searchMemories(podId: string, scope: MemoryScope, query: string): MemoryEntry[];

  /**
   * Suggest a new memory (pending human approval).
   * Returns the new entry ID.
   */
  suggestMemory(
    podId: string,
    scope: MemoryScope,
    path: string,
    content: string,
    rationale?: string,
  ): string;

  /** Trigger revalidation on a linked failed worker pod (pull + validate, no agent). */
  revalidateLinkedPod(
    linkedPodId: string,
  ): Promise<{ newCommits: boolean; result: 'pass' | 'fail' }>;

  /**
   * Daemon-side gate for validate_in_browser URLs.
   *
   * Throws if the URL is not a safe browser validation target. The daemon
   * validates independently of the escalation-mcp package to provide
   * defence-in-depth: even if the client-side check is bypassed, the daemon
   * will still refuse to generate/execute the Playwright script.
   *
   * Rules:
   *  - Only http(s) protocols are accepted.
   *  - Only localhost / 127.0.0.1 hostnames are allowed (the tool is meant to
   *    test the application running inside the container).
   *  - All other hostnames — including private IP ranges and cloud metadata
   *    services — are blocked to prevent SSRF via URL rewriting.
   */
  validateBrowserUrl(podId: string, url: string): void;

  /**
   * Run one of the profile's configured validation commands (lint, build, or
   * tests) inside the pod's container, using the same cwd / env / timeout the
   * daemon's post-completion validation pipeline uses. Used by the
   * `validate_locally` tool so agents can catch failures pre-completion in
   * their own context, instead of being looped back through the full
   * validation cycle.
   *
   * Returns structured results regardless of pass/fail. `configured: false`
   * when the profile has no command for that phase. `output` is truncated by
   * the daemon to keep the agent's context manageable.
   */
  runValidationPhase(podId: string, phase: ValidationPhaseName): Promise<ValidationPhaseResult>;

  /**
   * Run a fast critic pass on the pod's current diff using the profile's
   * reviewer model. Used by the `pre_submit_review` tool so agents get a
   * sanity-check before calling `report_task_summary`.
   *
   * The verdict is also recorded on the pod so the daemon's full reviewer can
   * skip Tier 1 when the diff hasn't changed since this pre-submit pass.
   */
  runPreSubmitReview(
    podId: string,
    input: PreSubmitReviewInput,
  ): Promise<PreSubmitReviewToolResult>;
}

export type ValidationPhaseName = 'lint' | 'build' | 'tests';

export interface PreSubmitReviewInput {
  /** Optional preview of the agent's planned task summary. */
  plannedSummary?: string;
  /** Optional preview of deviations the agent intends to disclose. */
  plannedDeviations?: Array<{
    step: string;
    planned: string;
    actual: string;
    reason: string;
  }>;
}

export interface PreSubmitReviewToolResult {
  /** 'pass'/'fail'/'uncertain' from the model; 'skipped' when the critic couldn't run. */
  status: 'pass' | 'fail' | 'uncertain' | 'skipped';
  reasoning: string;
  /** List of issues to address before declaring done; empty on a clean pass. */
  issues: string[];
  /** Reason the critic was skipped (no diff, no model, parse failure, timeout). */
  skipReason?: string;
  model: string;
  durationMs: number;
}

export interface ValidationPhaseResult {
  phase: ValidationPhaseName;
  /** False when the profile has no command for this phase. */
  configured: boolean;
  /** True if the phase ran and exited 0. False if it failed or was skipped. */
  passed: boolean;
  /** Exit code; null when the phase wasn't configured or timed out before exiting. */
  exitCode: number | null;
  /** The exact command line that was run (or null when not configured). */
  command: string | null;
  durationMs: number;
  /** Combined stdout+stderr, head+tail truncated to fit the agent's context. */
  output: string;
}
