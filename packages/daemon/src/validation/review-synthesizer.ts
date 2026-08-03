import { isDeepStrictEqual } from 'node:util';
import type {
  ReviewFindingCandidate,
  StructuredReviewFinding,
  TaskReviewResult,
} from '@autopod/shared';
import { structuredFindingId } from './finding-fingerprint.js';

export interface SynthesisDecision {
  action: 'accept' | 'reject' | 'merge';
  sourceIds: string[];
  reason?: string;
  finding?: ReviewFindingCandidate;
}

export interface SynthesisResult {
  accepted: ReviewFindingCandidate[];
  rejected: Array<{ sourceIds: string[]; reason: string }>;
  merged: Array<{ finding: StructuredReviewFinding; sourceIds: string[] }>;
}

export function reviewSynthesisPrompt(candidates: ReviewFindingCandidate[]): string {
  return `You are a review-finding synthesizer. Return JSON only: {"decisions":[{"action":"accept|reject|merge","sourceIds":["finding id"],"reason":"brief reason","finding":{...}}]}.
Use only the candidate findings below. Every decision must cite one or more sourceIds. An accepted finding must exactly equal its one source; a merged finding may only use field values already present in one of its sources. Never invent a claim, path, severity, evidence, or remediation.\nCandidates:\n${JSON.stringify(candidates)}`;
}

function equalFinding(a: ReviewFindingCandidate, b: ReviewFindingCandidate): boolean {
  return isDeepStrictEqual(a, b);
}

function supportedMerge(
  finding: StructuredReviewFinding,
  sources: StructuredReviewFinding[],
): boolean {
  const fields: Array<keyof StructuredReviewFinding> = [
    'axis',
    'severity',
    'path',
    'claim',
    'evidence',
    'remediation',
  ];
  return fields.every((field) => sources.some((source) => source[field] === finding[field]));
}

/** Validates that synthesis is purely a source-backed consolidation, never a new review. */
export function parseSynthesis(
  stdout: string,
  candidates: ReviewFindingCandidate[],
): SynthesisResult {
  const parsed: unknown = JSON.parse(stdout);
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !Array.isArray((parsed as { decisions?: unknown }).decisions)
  )
    throw new Error('invalid synthesis response');
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const accepted: ReviewFindingCandidate[] = [];
  const rejected: SynthesisResult['rejected'] = [];
  const merged: SynthesisResult['merged'] = [];
  const used = new Set<string>();
  for (const raw of (parsed as { decisions: unknown[] }).decisions) {
    if (!raw || typeof raw !== 'object') throw new Error('invalid synthesis decision');
    const decision = raw as Record<string, unknown>;
    const sourceIds = Array.isArray(decision.sourceIds) ? decision.sourceIds.map(String) : [];
    if (!sourceIds.length || sourceIds.some((id) => !byId.has(id) || used.has(id)))
      throw new Error('invalid synthesis source IDs');
    const sources = sourceIds
      .map((id) => byId.get(id))
      .filter((source): source is ReviewFindingCandidate => source !== undefined);
    const action = decision.action;
    if (action === 'accept') {
      const source = sources[0];
      if (
        sources.length !== 1 ||
        !source ||
        !decision.finding ||
        !equalFinding(decision.finding as ReviewFindingCandidate, source)
      )
        throw new Error('unsupported accepted finding');
      accepted.push(source);
    } else if (action === 'reject') {
      if (typeof decision.reason !== 'string' || !decision.reason)
        throw new Error('invalid rejection');
      rejected.push({ sourceIds, reason: decision.reason });
    } else if (action === 'merge') {
      const structuredSources = sources.filter(
        (source): source is StructuredReviewFinding => !('source' in source),
      );
      const mergedFinding = decision.finding;
      if (
        !mergedFinding ||
        typeof mergedFinding !== 'object' ||
        'source' in mergedFinding ||
        structuredSources.length !== sources.length ||
        !supportedMerge(mergedFinding as StructuredReviewFinding, structuredSources)
      )
        throw new Error('unsupported merged finding');
      // IDs are provenance identifiers, not model-controlled content. Derive the
      // merged ID after validating its source-backed fields so it cannot collide
      // with an unrelated candidate.
      const normalizedFinding: StructuredReviewFinding = {
        ...(mergedFinding as StructuredReviewFinding),
        id: structuredFindingId(mergedFinding as StructuredReviewFinding),
      };
      merged.push({ finding: normalizedFinding, sourceIds });
      accepted.push(normalizedFinding);
    } else throw new Error('invalid synthesis action');
    sourceIds.forEach((id) => used.add(id));
  }
  if (used.size !== candidates.length) throw new Error('synthesis omitted candidate');
  return { accepted, rejected, merged };
}

export function addTokenUsage(
  first?: TaskReviewResult['tokenUsage'],
  second?: TaskReviewResult['tokenUsage'],
): TaskReviewResult['tokenUsage'] {
  if (!first) return second;
  if (!second) return first;
  return {
    inputTokens: first.inputTokens + second.inputTokens,
    outputTokens: first.outputTokens + second.outputTokens,
    cachedInputTokens: (first.cachedInputTokens ?? 0) + (second.cachedInputTokens ?? 0),
    costUsd: (first.costUsd ?? 0) + (second.costUsd ?? 0),
  };
}
