import type { PodBridge } from '../pod-bridge.js';

export interface ReportPlanInput {
  summary: string;
  steps: string[];
}

export async function reportPlan(
  podId: string,
  input: ReportPlanInput,
  bridge: PodBridge,
): Promise<string> {
  bridge.reportPlan(podId, input.summary, input.steps);
  return `Plan registered with ${input.steps.length} steps. Proceed with implementation.`;
}
