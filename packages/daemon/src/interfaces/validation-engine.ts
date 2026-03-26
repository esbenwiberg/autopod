import type { ValidationResult } from '@autopod/shared';

export interface ValidationEngineConfig {
  sessionId: string;
  containerId: string;
  previewUrl: string;
  buildCommand: string;
  startCommand: string;
  healthPath: string;
  healthTimeout: number;
  smokePages: import('@autopod/shared').SmokePage[];
  attempt: number;
  task: string;
  diff: string;
  reviewerModel?: string;
  testCommand?: string | null;
  acceptanceCriteria?: string[];
}

export interface ValidationEngine {
  validate(config: ValidationEngineConfig): Promise<ValidationResult>;
}
