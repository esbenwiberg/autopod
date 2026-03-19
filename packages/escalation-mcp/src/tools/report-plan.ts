import type { SessionBridge } from '../session-bridge.js';

export interface ReportPlanInput {
  summary: string;
  steps: string[];
}

export async function reportPlan(
  sessionId: string,
  input: ReportPlanInput,
  bridge: SessionBridge,
): Promise<string> {
  bridge.reportPlan(sessionId, input.summary, input.steps);
  return `Plan registered with ${input.steps.length} steps. Proceed with implementation.`;
}
