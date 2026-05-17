import type { FactEvidence } from '@autopod/shared';
import type { PodBridge } from '../pod-bridge.js';

export interface ReportTaskSummaryInput {
  actualSummary: string;
  how?: string;
  deviations: Array<{
    step: string;
    planned: string;
    actual: string;
    reason: string;
  }>;
  acChecklist?: Array<{ criterion: string; verified: boolean; notes?: string }>;
  factEvidence?: FactEvidence[];
}

export async function reportTaskSummary(
  podId: string,
  input: ReportTaskSummaryInput,
  bridge: PodBridge,
): Promise<string> {
  bridge.reportTaskSummary(
    podId,
    input.actualSummary,
    input.deviations,
    input.how,
    input.acChecklist,
    input.factEvidence,
  );
  const deviationCount = input.deviations.length;
  const deviationNote =
    deviationCount === 0
      ? 'No deviations from plan reported.'
      : `${deviationCount} deviation${deviationCount === 1 ? '' : 's'} from plan recorded.`;
  const acNote = input.acChecklist?.length
    ? ` ${input.acChecklist.filter((c) => c.verified).length}/${input.acChecklist.length} acceptance criteria self-verified.`
    : '';
  const factNote = input.factEvidence?.length
    ? ` ${input.factEvidence.length} fact evidence item${input.factEvidence.length === 1 ? '' : 's'} recorded.`
    : '';
  return `Task summary registered. ${deviationNote}${acNote}${factNote} The reviewer will assess any deviations.`;
}
