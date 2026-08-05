import { createHash, randomUUID } from 'node:crypto';
import type {
  InitialReviewFinding,
  ReviewAxis,
  ReviewBatchResult,
  ReviewFailure,
  ReviewFindingCandidate,
  StructuredReviewFinding,
  TaskReviewResult,
} from '@autopod/shared';
import { structuredFindingSourceId } from './finding-fingerprint.js';
import { filterOutOfDiffFindings } from './review-finding-filter.js';
import {
  REVIEW_VALIDATION_CODE,
  ReviewStructuredOutputError,
  parseAxisResponse,
  reviewAxisOutputContract,
} from './review-structured-output.js';
import { parseSynthesis, reviewSynthesisPrompt } from './review-synthesizer.js';

export const REVIEW_AXES: ReviewAxis[] = [
  'contract_completeness',
  'security_authority',
  'lifecycle_reliability',
  'persistence_reproducibility',
  'tests_integration',
];

export interface FrozenReviewPacket {
  id: string;
  diff: string;
  diffHash: string;
  reviewedHead: string;
  task: string;
  context: string;
  executableContract?: string;
  initialFindings: InitialReviewFinding[];
  validationSummary?: string;
  factSummary?: string;
  promptVersion: string;
  schemaVersion: string;
}

export interface ReviewBatchRunnerOptions {
  packet: FrozenReviewPacket;
  model: string;
  execute: (
    prompt: string,
    label: string,
    timeoutMs: number,
    outputContract?: typeof reviewAxisOutputContract,
  ) => Promise<{ stdout: string; tokenUsage?: TaskReviewResult['tokenUsage'] }>;
  synthesize?: (
    prompt: string,
    label: string,
    timeoutMs: number,
  ) => Promise<{ stdout: string; tokenUsage?: TaskReviewResult['tokenUsage'] }>;
  /** One wall-clock budget for axes, retries, and synthesis. */
  timeoutMs?: number;
  /** Safe status messages; never includes prompts or provider output. */
  onProgress?: (event: {
    axis: ReviewAxis;
    attempt: number;
    status: 'started' | 'completed' | 'unavailable';
    elapsedMs: number;
  }) => void;
  /** Read HEAD immediately before each call; prevents a batch from mixing commits. */
  readHead?: () => Promise<string>;
}

export function createFrozenReviewPacket(
  input: Omit<FrozenReviewPacket, 'id' | 'diffHash'>,
): FrozenReviewPacket {
  const diffHash = createHash('sha256').update(input.diff).digest('hex');
  return { ...input, diffHash, id: `review-batch-${diffHash.slice(0, 12)}-${randomUUID()}` };
}

function axisPrompt(packet: FrozenReviewPacket, axis: ReviewAxis, correctionCode?: string): string {
  const concerns: Record<ReviewAxis, string> = {
    contract_completeness:
      'Check every stated contract requirement, boundary, and completeness gap.',
    security_authority:
      'Check authentication, authorization, secrets, trust boundaries, and privilege escalation.',
    lifecycle_reliability:
      'Check state transitions, retries, failure handling, concurrency, and cleanup.',
    persistence_reproducibility:
      'Check durable data, migrations, determinism, replayability, and configuration.',
    tests_integration:
      'Check test coverage, integration behavior, executable validation, and realistic failure modes.',
  };
  return `You are the ${axis} reviewer in a frozen review council. ${concerns[axis]} Read only; do not modify files.
PACKET id=${packet.id} diffHash=${packet.diffHash} head=${packet.reviewedHead} schema=${packet.schemaVersion}.
Return JSON only: {"findings":[{"severity":"MEDIUM|HIGH|CRITICAL","path":"changed file","line":number?,"symbol":"string?","claim":"specific defect","evidence":"evidence","remediation":"action","confidence":0.0}]}
Only cite changed files and only report supported issues. Task: ${packet.task}
Contract: ${packet.executableContract ?? ''}
Initial broad-review inputs: ${JSON.stringify(packet.initialFindings)}
Validation: ${packet.validationSummary ?? ''}\nFacts: ${packet.factSummary ?? ''}
Context: ${packet.context}
Diff:
${packet.diff}${correctionCode ? `\nCorrection required: return only a response satisfying validation code ${correctionCode}.` : ''}`;
}

function parseCandidates(
  stdout: string,
  axis: ReviewAxis,
  diff: string,
): StructuredReviewFinding[] {
  const candidates = parseAxisResponse(stdout, axis).map((finding) => {
    const result = { ...finding };
    result.id = structuredFindingSourceId(result);
    return result;
  });
  const allowed = new Set(
    filterOutOfDiffFindings(
      candidates.map((f) => `${f.path}: ${f.claim}`),
      diff,
    ).issues,
  );
  return candidates.filter((f) => allowed.has(`${f.path}: ${f.claim}`));
}

function failureFor(error: unknown): ReviewFailure {
  if (error instanceof ReviewStructuredOutputError)
    return {
      kind: 'invalid-response',
      code: REVIEW_VALIDATION_CODE,
      message: error.message,
      retryable: true,
    };
  const message = error instanceof Error ? error.message : String(error);
  if (/reviewed HEAD changed/i.test(message))
    return {
      kind: 'head-changed',
      code: 'REVIEW_HEAD_CHANGED',
      message: 'Reviewed HEAD changed during frozen batch',
      retryable: false,
    };
  if (/timed? out|timeout/i.test(message))
    return {
      kind: 'timeout',
      code: 'REVIEW_TIMEOUT',
      message: 'Reviewer timed out',
      retryable: true,
    };
  if (/auth|credential|provider|model.*unavailable|offline/i.test(message))
    return {
      kind: 'provider-unavailable',
      code: 'REVIEW_PROVIDER_UNAVAILABLE',
      message: 'Reviewer provider is unavailable',
      retryable: true,
    };
  return {
    kind: 'runner-failed',
    code: 'REVIEW_RUNNER_FAILED',
    message: 'Reviewer runner failed',
    retryable: true,
  };
}

function dedupe<T extends ReviewFindingCandidate>(findings: T[]): T[] {
  return [...new Map(findings.map((finding) => [finding.id, finding])).values()].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
}

function usage(usages: Array<TaskReviewResult['tokenUsage']>): TaskReviewResult['tokenUsage'] {
  const present = usages.filter(Boolean) as NonNullable<TaskReviewResult['tokenUsage']>[];
  if (!present.length) return undefined;
  return {
    inputTokens: present.reduce((n, u) => n + u.inputTokens, 0),
    outputTokens: present.reduce((n, u) => n + u.outputTokens, 0),
    cachedInputTokens: present.reduce((n, u) => n + (u.cachedInputTokens ?? 0), 0),
    costUsd: present.reduce((n, u) => n + (u.costUsd ?? 0), 0),
  };
}

/** Runs exactly five isolated reviews, at most three at a time, retrying each unavailable axis once. */
export async function runReviewBatch(
  options: ReviewBatchRunnerOptions,
): Promise<ReviewBatchResult> {
  const started = Date.now();
  const runs: ReviewBatchResult['axes'] = [];
  const candidates: StructuredReviewFinding[] = [];
  const tokenUsage: Array<TaskReviewResult['tokenUsage']> = [];
  const deadline = started + (options.timeoutMs ?? 300_000);
  const remaining = () => Math.max(0, deadline - Date.now());
  let next = 0;
  const worker = async () => {
    while (next < REVIEW_AXES.length) {
      const axis = REVIEW_AXES[next++];
      let lastError: string | undefined;
      let failure: ReviewFailure | undefined;
      const axisStarted = Date.now();
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          if (remaining() <= 0) throw new Error('frozen review council deadline exceeded');
          options.onProgress?.({
            axis,
            attempt,
            status: 'started',
            elapsedMs: Date.now() - started,
          });
          if (options.readHead && (await options.readHead()) !== options.packet.reviewedHead)
            throw new Error('reviewed HEAD changed during frozen batch');
          // Head validation can itself consume wall-clock budget. Recompute
          // immediately before the remotely timed reviewer call.
          const timeoutMs = remaining();
          if (timeoutMs <= 0) throw new Error('frozen review council deadline exceeded');
          const result = await options.execute(
            axisPrompt(
              options.packet,
              axis,
              failure?.kind === 'invalid-response' ? REVIEW_VALIDATION_CODE : undefined,
            ),
            `${options.packet.id}-${axis}-${attempt}`,
            timeoutMs,
            reviewAxisOutputContract,
          );
          tokenUsage.push(result.tokenUsage);
          candidates.push(...parseCandidates(result.stdout, axis, options.packet.diff));
          runs.push({
            axis,
            status: 'completed',
            attempts: attempt,
            durationMs: Date.now() - axisStarted,
          });
          options.onProgress?.({
            axis,
            attempt,
            status: 'completed',
            elapsedMs: Date.now() - started,
          });
          lastError = undefined;
          break;
        } catch (error) {
          failure = failureFor(error);
          lastError = failure.message;
          if (attempt === 2)
            runs.push({
              axis,
              status: 'unavailable',
              attempts: attempt,
              durationMs: Date.now() - axisStarted,
              error: lastError,
              failure,
            });
          if (attempt === 2)
            options.onProgress?.({
              axis,
              attempt,
              status: 'unavailable',
              elapsedMs: Date.now() - started,
            });
        }
      }
    }
  };
  await Promise.all(Array.from({ length: 3 }, worker));
  const accepted = dedupe(candidates);
  const allCandidates = dedupe([...options.packet.initialFindings, ...accepted]);
  let synthesis: ReviewBatchResult['synthesis'] = 'deterministic-fallback';
  let synthesized = {
    accepted: allCandidates,
    rejected: [] as ReviewBatchResult['rejected'],
    merged: [] as ReviewBatchResult['merged'],
  };
  // A missing required axis is infrastructure failure, not an input for a
  // potentially reassuring synthesis verdict. Five 300s axes with retries can
  // otherwise stretch a nominal 300s review into roughly 20 minutes.
  if (options.synthesize && !runs.some((run) => run.status === 'unavailable') && remaining() > 0) {
    try {
      const prompt = reviewSynthesisPrompt(allCandidates);
      if (prompt.length > 1_000_000) throw new Error('synthesis prompt exceeds bounded input');
      const result = await options.synthesize(
        prompt,
        `${options.packet.id}-synthesis`,
        remaining(),
      );
      tokenUsage.push(result.tokenUsage);
      synthesized = parseSynthesis(result.stdout.slice(0, 1_000_000), allCandidates);
      synthesis = 'model';
    } catch {
      synthesis = 'deterministic-fallback';
    }
  }
  return {
    id: options.packet.id,
    diffHash: options.packet.diffHash,
    reviewedHead: options.packet.reviewedHead,
    promptVersion: options.packet.promptVersion,
    schemaVersion: options.packet.schemaVersion,
    model: options.model,
    axes: runs.sort((a, b) => REVIEW_AXES.indexOf(a.axis) - REVIEW_AXES.indexOf(b.axis)),
    candidates: allCandidates,
    initialFindings: options.packet.initialFindings,
    accepted: dedupe(synthesized.accepted),
    rejected: synthesized.rejected,
    merged: synthesized.merged,
    synthesis,
    durationMs: Date.now() - started,
    infrastructureUnavailable: runs.some((r) => r.status === 'unavailable'),
    tokenUsage: usage(tokenUsage),
  };
}

export function reviewBatchIssues(batch: ReviewBatchResult): string[] {
  return batch.accepted.map((finding) =>
    'source' in finding
      ? finding.issue
      : `[${finding.severity}] ${finding.path}${finding.line ? `:${finding.line}` : ''} — ${finding.claim}`,
  );
}
