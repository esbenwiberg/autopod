import type { PageAssertion } from './profile.js';
import type { DeviationsAssessment } from './task-summary.js';

export type ScreenshotSource = 'smoke' | 'fact' | 'review' | 'advisory';

export interface ScreenshotRef {
  podId: string;
  source: ScreenshotSource;
  filename: string;
  /** Path relative to the data dir, e.g. `screenshots/abc12345/smoke/root.png`. */
  relativePath: string;
}

export interface ValidationResult {
  podId: string;
  attempt: number;
  timestamp: string;
  smoke: SmokeResult;
  test?: { status: 'pass' | 'fail' | 'skip'; duration: number; stdout?: string; stderr?: string };
  lint?: LintResult;
  sast?: SastResult;
  factValidation?: FactValidationResult | null;
  taskReview: TaskReviewResult | null;
  /**
   * Screenshot-backed exploratory browser QA. Advisory only: required facts
   * remain the blocking proof layer and this result must not affect `overall`.
   */
  advisoryBrowserQa?: AdvisoryBrowserQaResult | null;
  /** Human-readable reason when taskReview is null (e.g. "No code changes detected") */
  reviewSkipReason?: string;
  /** Machine-readable kind for taskReview skip — paired with reviewSkipReason. */
  reviewSkipKind?:
    | 'upstream-failed'
    | 'profile-skip'
    | 'no-changes'
    | 'review-failed'
    | 'review-timeout';
  overall: 'pass' | 'fail';
  duration: number;
}

export interface SmokeResult {
  status: 'pass' | 'fail';
  build: BuildResult;
  health: HealthResult;
  pages: PageResult[];
}

export interface BuildResult {
  status: 'pass' | 'fail';
  output: string;
  duration: number;
  /**
   * Warnings parsed from build output. Populated when the build emits a
   * recognizable warning summary (e.g. MSBuild's "succeeded with N warning(s)").
   * Diagnostic only: build pass/fail follows the build command's exit code so
   * project-level warning policy remains authoritative.
   */
  warningCount?: number;
}

export interface LintResult {
  status: 'pass' | 'fail' | 'skip';
  output: string;
  duration: number;
}

export interface SastResult {
  status: 'pass' | 'fail' | 'skip';
  output: string;
  duration: number;
}

export interface HealthResult {
  status: 'pass' | 'fail' | 'skip';
  url: string;
  responseCode: number | null;
  duration: number;
  /** Response body from the health endpoint (truncated to 2 KB, only on pass) */
  responseBody?: string;
  /** Stdout/stderr captured from the start command (only populated on failure for diagnostics) */
  startOutput?: string;
}

export interface PageResult {
  path: string;
  status: 'pass' | 'fail';
  screenshotPath: string;
  /** Reference to the on-disk screenshot (populated after collection from host filesystem) */
  screenshot?: ScreenshotRef;
  consoleErrors: string[];
  assertions: AssertionResult[];
  loadTime: number;
}

export interface AssertionResult {
  selector: string;
  type: PageAssertion['type'];
  expected: string | undefined;
  actual: string | undefined;
  passed: boolean;
}

export interface FactCheckResult {
  factId: string;
  proves: string[];
  kind?: string;
  artifactPath: string;
  command: string;
  passed: boolean;
  status?: 'pass' | 'fail' | 'waived' | 'replaced' | 'pending_human';
  exitCode?: number;
  durationMs?: number;
  artifact?: {
    path: string;
    change?: string;
    exists: boolean;
    changed: boolean;
    hash?: string;
  };
  attachments?: FactEvidenceAttachment[];
  reasoning: string;
  stdout?: string;
  stderr?: string;
}

export interface FactEvidenceAttachment {
  kind: 'screenshot' | 'trace' | 'video' | 'report' | 'log' | 'artifact';
  path: string;
  label?: string;
  /** Reference to the on-disk screenshot when this attachment is a collected PNG screenshot. */
  screenshot?: ScreenshotRef;
}

export interface FactValidationResult {
  status: 'pass' | 'fail' | 'skip' | 'pending_human';
  results: FactCheckResult[];
}

export interface RequirementsCheckItem {
  criterion: string;
  met: boolean;
  note?: string;
}

export interface TaskReviewResult {
  status: 'pass' | 'fail' | 'uncertain';
  reasoning: string;
  issues: string[];
  model: string;
  screenshots: ScreenshotRef[];
  diff: string;
  /** Per-contract human-review requirements coverage check */
  requirementsCheck?: RequirementsCheckItem[];
  /** Reviewer's assessment of agent-reported and detected deviations */
  deviationsAssessment?: DeviationsAssessment;
  /** Token counts from the LLM call(s) that produced this result. Absent for Tier-1 CLI reviews. */
  tokenUsage?: { inputTokens: number; outputTokens: number };
}

export interface AdvisoryBrowserQaObservation {
  id: string;
  /** Scenario this observation relates to, when scenario-backed QA was possible. */
  scenarioId?: string;
  status: 'pass' | 'fail' | 'uncertain';
  summary: string;
  details?: string;
  screenshots: ScreenshotRef[];
  /** Suggestions for required facts when advisory evidence exposes a weak proof boundary. */
  suggestedFacts?: string[];
}

export interface AdvisoryBrowserQaResult {
  status: 'pass' | 'fail' | 'uncertain' | 'skip';
  reasoning: string;
  model?: string;
  durationMs?: number;
  observations: AdvisoryBrowserQaObservation[];
  screenshots: ScreenshotRef[];
}

/** A single failed finding extracted from a ValidationResult for recurring-detection. */
export interface ValidationFinding {
  /** Stable ID: 'fact:<hash>' | 'review:<hash>' | 'req:<hash>' */
  id: string;
  source: 'fact_validation' | 'task_review' | 'requirements_check';
  /** Human-readable description of the finding */
  description: string;
  /** Reviewer or validator reasoning */
  reasoning?: string;
}

/** A human decision to dismiss or provide guidance for a recurring validation finding. */
export interface ValidationOverride {
  findingId: string;
  /** Original finding description (for display + reviewer prompt context) */
  description: string;
  action: 'dismiss' | 'guidance';
  /** Human's reason for dismissal */
  reason?: string;
  /** Human's guidance for the agent on how to fix this */
  guidance?: string;
  createdAt: string;
}
