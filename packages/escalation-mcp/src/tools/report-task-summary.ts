import type {
  DeferredCheck,
  FactEvidence,
  MemoryOutcomeItem,
  ReviewFeedbackResponseItem,
} from '@autopod/shared';
import { z } from 'zod';
import type { PodBridge, WorkspaceCleanliness } from '../pod-bridge.js';

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

const MAX_LISTED_PATHS = 20;

function displayPath(path: string): string {
  const cleaned = Array.from(path, (character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f ? '?' : character;
  }).join('');
  return cleaned.length > 200 ? `${cleaned.slice(0, 199)}…` : cleaned;
}

function listed(title: string, paths: string[]): string[] {
  if (paths.length === 0) return [];
  const shown = paths.slice(0, MAX_LISTED_PATHS).map((path) => `- ${displayPath(path)}`);
  if (paths.length > MAX_LISTED_PATHS) shown.push(`- …and ${paths.length - MAX_LISTED_PATHS} more`);
  return [title, ...shown];
}

/** Agent-facing warning while the worker can still commit or remove leftovers. */
export function formatWorkspaceCleanlinessWarning(
  state: WorkspaceCleanliness | null | undefined,
): string {
  if (!state) return '';
  const sections = [
    ...listed('Uncommitted changes to tracked paths:', state.changed),
    ...listed('Untracked paths:', state.untracked),
    ...listed(
      "Hidden only by this container's .git/info/exclude (Autopod's host copy does not share it, so it still sees them):",
      state.hiddenByLocalExclude,
    ),
  ];
  if (sections.length === 0) return '';
  return [
    '',
    '',
    'WARNING: your workspace still has paths outside committed source. Before you finish, commit each one that belongs to this change and delete the rest (keep scratch notes outside /workspace, for example under /tmp). Left behind, they are either swept into your change by an automatic commit or stop finalization before any checks run.',
    ...sections,
    'Your summary is already recorded; you do not need to report it again.',
  ].join('\n');
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
  const cleanliness = await bridge.inspectWorkspaceCleanliness?.(podId).catch(() => null);
  return `Task summary registered. ${deviationNote}${factNote}${factDeviationNote}${memoryNote}${reviewFeedbackNote}${deferredNote} The reviewer will assess any deviations.${formatWorkspaceCleanlinessWarning(cleanliness)}`;
}
