import type { SessionBridge } from '../session-bridge.js';

export interface ReportTaskSummaryInput {
  actualSummary: string;
  deviations: Array<{
    step: string;
    planned: string;
    actual: string;
    reason: string;
  }>;
}

export async function reportTaskSummary(
  sessionId: string,
  input: ReportTaskSummaryInput,
  bridge: SessionBridge,
): Promise<string> {
  bridge.reportTaskSummary(sessionId, input.actualSummary, input.deviations);
  const deviationCount = input.deviations.length;
  const deviationNote =
    deviationCount === 0
      ? 'No deviations from plan reported.'
      : `${deviationCount} deviation${deviationCount === 1 ? '' : 's'} from plan recorded.`;
  return `Task summary registered. ${deviationNote} The reviewer will assess any deviations.`;
}
