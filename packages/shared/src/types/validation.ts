import type { PageAssertion } from './profile.js';
import type { DeviationsAssessment } from './task-summary.js';

export interface ValidationResult {
  podId: string;
  attempt: number;
  timestamp: string;
  smoke: SmokeResult;
  test?: { status: 'pass' | 'fail' | 'skip'; duration: number; stdout?: string; stderr?: string };
  lint?: LintResult;
  sast?: SastResult;
  acValidation?: AcValidationResult | null;
  taskReview: TaskReviewResult | null;
  /** Human-readable reason when taskReview is null (e.g. "No code changes detected") */
  reviewSkipReason?: string;
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
  status: 'pass' | 'fail';
  url: string;
  responseCode: number | null;
  duration: number;
  /** Stdout/stderr captured from the start command (only populated on failure for diagnostics) */
  startOutput?: string;
}

export interface PageResult {
  path: string;
  status: 'pass' | 'fail';
  screenshotPath: string;
  /** Base64-encoded PNG screenshot (populated after collection from host filesystem) */
  screenshotBase64?: string;
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

export interface AcCheckResult {
  /** The original acceptance criterion text */
  criterion: string;
  /** Whether the check passed */
  passed: boolean;
  /** Base64-encoded PNG screenshot of the relevant page state */
  screenshot?: string;
  /** Reviewer/executor reasoning about why it passed or failed */
  reasoning: string;
  /** How this criterion was (or was not) validated */
  validationType?: 'web-ui' | 'api' | 'none';
}

export interface AcValidationResult {
  status: 'pass' | 'fail' | 'skip';
  results: AcCheckResult[];
  /** The model used to generate and execute checks */
  model: string;
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
  screenshots: string[];
  diff: string;
  /** Per-AC requirements coverage check */
  requirementsCheck?: RequirementsCheckItem[];
  /** Reviewer's assessment of agent-reported and detected deviations */
  deviationsAssessment?: DeviationsAssessment;
}

/** A single failed finding extracted from a ValidationResult for recurring-detection. */
export interface ValidationFinding {
  /** Stable ID: 'ac:<hash>' | 'review:<hash>' | 'req:<hash>' */
  id: string;
  source: 'ac_validation' | 'task_review' | 'requirements_check';
  /** Human-readable description of the finding */
  description: string;
  /** Reviewer reasoning (for AC checks) */
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
