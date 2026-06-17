export interface ProgressValidationPlan {
  summary: string;
  steps: string[];
}

export interface ProgressValidationInput {
  currentPhase: number;
  totalPhases: number;
}

export function validatePlanAlignedProgress(
  plan: ProgressValidationPlan | null | undefined,
  progress: ProgressValidationInput,
): void {
  if (progress.currentPhase > progress.totalPhases) {
    throw new Error(
      `report_progress rejected: currentPhase (${progress.currentPhase}) cannot exceed totalPhases (${progress.totalPhases}).`,
    );
  }

  if (!plan) return;

  const planStepCount = plan.steps.length;
  if (planStepCount === 0) return;

  if (progress.totalPhases !== planStepCount) {
    throw new Error(
      `report_progress rejected: totalPhases (${progress.totalPhases}) must equal the reported plan step count (${planStepCount}).`,
    );
  }

  if (progress.currentPhase < 1 || progress.currentPhase > planStepCount) {
    throw new Error(
      `report_progress rejected: currentPhase (${progress.currentPhase}) must reference a plan step between 1 and ${planStepCount}.`,
    );
  }
}
