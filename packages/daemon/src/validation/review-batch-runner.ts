import { createHash, randomUUID } from 'node:crypto';
import type {
  ReviewAxis,
  ReviewBatchResult,
  StructuredReviewFinding,
  TaskReviewResult,
} from '@autopod/shared';
import { filterOutOfDiffFindings } from './review-finding-filter.js';
import { structuredFindingId } from './finding-fingerprint.js';

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
  promptVersion: string;
  schemaVersion: string;
}

export interface ReviewBatchRunnerOptions {
  packet: FrozenReviewPacket;
  model: string;
  execute: (
    prompt: string,
    label: string,
  ) => Promise<{ stdout: string; tokenUsage?: TaskReviewResult['tokenUsage'] }>;
  /** Read HEAD immediately before each call; prevents a batch from mixing commits. */
  readHead?: () => Promise<string>;
}

export function createFrozenReviewPacket(
  input: Omit<FrozenReviewPacket, 'id' | 'diffHash'>,
): FrozenReviewPacket {
  const diffHash = createHash('sha256').update(input.diff).digest('hex');
  return { ...input, diffHash, id: `review-batch-${diffHash.slice(0, 12)}-${randomUUID()}` };
}

function axisPrompt(packet: FrozenReviewPacket, axis: ReviewAxis): string {
  return (
    `You are the ${axis} reviewer in a frozen review council. Read only; do not modify files.\n` +
    `PACKET id=${packet.id} diffHash=${packet.diffHash} head=${packet.reviewedHead} schema=${packet.schemaVersion}.\n` +
    `Return JSON only: {"findings":[{"severity":"MEDIUM|HIGH|CRITICAL","path":"changed file","line":number?,"symbol":"string?","claim":"specific defect","evidence":"evidence","remediation":"action","confidence":0.0}]}\n` +
    `Only cite changed files and only report supported issues. Task: ${packet.task}\nContext: ${packet.context}\nDiff:\n${packet.diff}`
  );
}

function parseCandidates(
  stdout: string,
  axis: ReviewAxis,
  diff: string,
): StructuredReviewFinding[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('unparseable reviewer response');
  }
  const raw =
    parsed &&
    typeof parsed === 'object' &&
    Array.isArray((parsed as { findings?: unknown[] }).findings)
      ? (parsed as { findings: unknown[] }).findings
      : [];
  const candidates: StructuredReviewFinding[] = [];
  for (const value of raw) {
    if (!value || typeof value !== 'object') continue;
    const f = value as Record<string, unknown>;
    if (
      !['MEDIUM', 'HIGH', 'CRITICAL'].includes(String(f.severity)) ||
      !f.path ||
      !f.claim ||
      !f.evidence ||
      !f.remediation
    )
      continue;
    const finding: StructuredReviewFinding = {
      id: '',
      axis,
      severity: f.severity as StructuredReviewFinding['severity'],
      path: String(f.path),
      ...(typeof f.line === 'number' && { line: f.line }),
      ...(typeof f.symbol === 'string' && { symbol: f.symbol }),
      claim: String(f.claim),
      evidence: String(f.evidence),
      remediation: String(f.remediation),
      confidence: typeof f.confidence === 'number' ? Math.max(0, Math.min(1, f.confidence)) : 0.5,
    };
    finding.id = structuredFindingId(finding);
    candidates.push(finding);
  }
  const allowed = new Set(
    filterOutOfDiffFindings(
      candidates.map((f) => `${f.path}: ${f.claim}`),
      diff,
    ).issues,
  );
  return candidates.filter((f) => allowed.has(`${f.path}: ${f.claim}`));
}

function dedupe(findings: StructuredReviewFinding[]): StructuredReviewFinding[] {
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
  let next = 0;
  const worker = async () => {
    while (next < REVIEW_AXES.length) {
      const axis = REVIEW_AXES[next++];
      let lastError: string | undefined;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          if (options.readHead && (await options.readHead()) !== options.packet.reviewedHead)
            throw new Error('reviewed HEAD changed during frozen batch');
          const result = await options.execute(
            axisPrompt(options.packet, axis),
            `${options.packet.id}-${axis}-${attempt}`,
          );
          tokenUsage.push(result.tokenUsage);
          candidates.push(
            ...parseCandidates(result.stdout.slice(0, 1_000_000), axis, options.packet.diff),
          );
          runs.push({ axis, status: 'completed', attempts: attempt });
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          if (attempt === 2)
            runs.push({ axis, status: 'unavailable', attempts: attempt, error: lastError });
        }
      }
    }
  };
  await Promise.all(Array.from({ length: 3 }, worker));
  const accepted = dedupe(candidates);
  return {
    id: options.packet.id,
    diffHash: options.packet.diffHash,
    reviewedHead: options.packet.reviewedHead,
    promptVersion: options.packet.promptVersion,
    schemaVersion: options.packet.schemaVersion,
    model: options.model,
    axes: runs.sort((a, b) => REVIEW_AXES.indexOf(a.axis) - REVIEW_AXES.indexOf(b.axis)),
    candidates: dedupe(candidates),
    accepted,
    rejected: [],
    synthesis: 'deterministic-fallback',
    durationMs: Date.now() - started,
    infrastructureUnavailable: runs.some((r) => r.status === 'unavailable'),
    tokenUsage: usage(tokenUsage),
  };
}

export function reviewBatchIssues(batch: ReviewBatchResult): string[] {
  return batch.accepted.map(
    (f) => `[${f.severity}] ${f.path}${f.line ? `:${f.line}` : ''} — ${f.claim}`,
  );
}
