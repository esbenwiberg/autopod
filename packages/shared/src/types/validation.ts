import type { PageAssertion } from './profile.js';

export interface ValidationResult {
  sessionId: string;
  attempt: number;
  timestamp: string;
  smoke: SmokeResult;
  taskReview: TaskReviewResult | null;
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

export interface HealthResult {
  status: 'pass' | 'fail';
  url: string;
  responseCode: number | null;
  duration: number;
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

export interface TaskReviewResult {
  status: 'pass' | 'fail' | 'uncertain';
  reasoning: string;
  issues: string[];
  model: string;
  screenshots: string[];
  diff: string;
}
