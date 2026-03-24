import type { ValidationResult } from '@autopod/shared';

export interface ValidationEngineConfig {
  sessionId: string;
  containerId: string;
  previewUrl: string;
  buildCommand: string;
  startCommand: string;
  healthPath: string;
  healthTimeout: number;
  validationPages: import('@autopod/shared').ValidationPage[];
  attempt: number;
  task: string;
  diff: string;
  reviewerModel?: string;
  testCommand?: string | null;
}

export interface ValidationEngine {
  validate(config: ValidationEngineConfig): Promise<ValidationResult>;
}
