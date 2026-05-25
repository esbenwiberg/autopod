import type { MemoryPlanIntentItem, PodBridge } from '../pod-bridge.js';

export interface ReportPlanInput {
  summary: string;
  steps: string[];
  memoryIntents?: MemoryPlanIntentItem[];
}

export async function reportPlan(
  podId: string,
  input: ReportPlanInput,
  bridge: PodBridge,
): Promise<string> {
  bridge.reportPlan(podId, input.summary, input.steps, input.memoryIntents);
  const memoryNote = input.memoryIntents?.length
    ? ` ${input.memoryIntents.length} memory intent${input.memoryIntents.length === 1 ? '' : 's'} recorded.`
    : '';
  return `Plan registered with ${input.steps.length} steps.${memoryNote} Proceed with implementation.`;
}
