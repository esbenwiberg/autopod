import type { FactEvidence, MemoryOutcomeItem } from '@autopod/shared';
import type { PodBridge } from '../pod-bridge.js';

export interface ReportTaskSummaryInput {
  actualSummary: string;
  how?: string;
  deviations: Array<{
    step: string;
    planned: string;
    actual: string;
    reason: string;
    kind?: 'constraint' | 'tradeoff' | 'scope' | 'bugfix' | 'other';
    impact?: string;
  }>;
  factEvidence?: FactEvidence[];
  factDeviations?: Array<{
    factId: string;
    action: 'waive' | 'replace';
    reason: string;
    whyImpossible: string;
    decision?: 'approved_waive' | 'approved_replace' | 'rejected';
    replacement?: {
      artifactPath: string;
      command: string;
      proves?: string[];
    };
  }>;
  memoryOutcomes?: MemoryOutcomeItem[];
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
    input.factEvidence,
    input.factDeviations,
    input.memoryOutcomes,
  );
  const deviationCount = input.deviations.length;
  const deviationNote =
    deviationCount === 0
      ? 'No deviations from plan reported.'
      : `${deviationCount} deviation${deviationCount === 1 ? '' : 's'} from plan recorded.`;
  const factNote = input.factEvidence?.length
    ? ` ${input.factEvidence.length} fact evidence item${input.factEvidence.length === 1 ? '' : 's'} recorded.`
    : '';
  const factDeviationNote = input.factDeviations?.length
    ? ` ${input.factDeviations.length} fact deviation request${input.factDeviations.length === 1 ? '' : 's'} recorded.`
    : '';
  const memoryNote = input.memoryOutcomes?.length
    ? ` ${input.memoryOutcomes.length} memory outcome${input.memoryOutcomes.length === 1 ? '' : 's'} recorded.`
    : '';
  return `Task summary registered. ${deviationNote}${factNote}${factDeviationNote}${memoryNote} The reviewer will assess any deviations.`;
}
