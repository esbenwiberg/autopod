import type {
  DeferredCheck,
  FactEvidence,
  MemoryOutcomeItem,
  ReviewFeedbackResponseItem,
} from '@autopod/shared';
import { z } from 'zod';
import type { PodBridge } from '../pod-bridge.js';

// Keep bounds/strictness aligned with the daemon's independent write boundary.
export const deferredChecksSchema = z
  .array(
    z
      .object({
        id: z.string().trim().min(1).max(128),
        check: z.string().trim().min(1).max(2000),
        reason: z.string().trim().min(1).max(2000),
        expectedExecutor: z.string().trim().min(1).max(256),
        requiredFactId: z.string().trim().min(1).max(128).optional(),
      })
      .strict(),
  )
  .max(50);

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
  deferredChecks?: DeferredCheck[];
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
  reviewFeedbackResponses?: ReviewFeedbackResponseItem[];
}

export async function reportTaskSummary(
  podId: string,
  input: ReportTaskSummaryInput,
  bridge: PodBridge,
): Promise<string> {
  const deferredChecks =
    input.deferredChecks === undefined
      ? undefined
      : deferredChecksSchema.parse(input.deferredChecks);
  bridge.reportTaskSummary(
    podId,
    input.actualSummary,
    input.deviations,
    input.how,
    input.factEvidence,
    input.factDeviations,
    input.memoryOutcomes,
    input.reviewFeedbackResponses,
    deferredChecks,
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
  const reviewFeedbackNote = input.reviewFeedbackResponses?.length
    ? ` ${input.reviewFeedbackResponses.length} review feedback response${input.reviewFeedbackResponses.length === 1 ? '' : 's'} recorded for host-side PR replies.`
    : '';
  const deferredNote = deferredChecks?.length
    ? ` ${deferredChecks.length} deferred check(s) reported NOT-RUN; required checks remain incomplete. This is not a pass, waiver or repair receipt.`
    : '';
  return `Task summary registered. ${deviationNote}${factNote}${factDeviationNote}${memoryNote}${reviewFeedbackNote}${deferredNote} The reviewer will assess any deviations.`;
}
