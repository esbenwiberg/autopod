import {
  type PhaseTokenUsage,
  type Pod,
  type PodCostBreakdownResponse,
  type PodCostBucket,
  type PodCostSegment,
  computeCostWithCache,
  effectiveCostUsd,
} from '@autopod/shared';

type TokenBucket = { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
const COST_EPSILON = 1e-9;

const SEGMENT_DEFS: Array<{
  bucket: PodCostBucket;
  label: string;
  costScope: 'agent' | 'harness';
  phases: readonly string[];
  includePhase?: (phase: string) => boolean;
}> = [
  { bucket: 'work', label: 'Work', costScope: 'agent', phases: ['agent_initial'] },
  {
    bucket: 'rework',
    label: 'Rework',
    costScope: 'agent',
    phases: [],
    includePhase: (phase) => /^agent_rework_\d+$/.test(phase),
  },
  {
    bucket: 'validation',
    label: 'Validation',
    costScope: 'harness',
    phases: ['review', 'plan_eval'],
  },
  { bucket: 'advisory', label: 'Advisory', costScope: 'harness', phases: ['advisory'] },
];

function comparePhaseName(a: string, b: string): number {
  const reworkRe = /^agent_rework_(\d+)$/;
  const aMatch = reworkRe.exec(a);
  const bMatch = reworkRe.exec(b);
  if (aMatch && bMatch) return Number(aMatch[1]) - Number(bMatch[1]);
  return a.localeCompare(b);
}

function addTokens(total: TokenBucket, bucket: TokenBucket | undefined): void {
  if (!bucket) return;
  total.inputTokens += bucket.inputTokens;
  total.outputTokens += bucket.outputTokens;
  const cachedInputTokens = (total.cachedInputTokens ?? 0) + (bucket.cachedInputTokens ?? 0);
  if (cachedInputTokens > 0) total.cachedInputTokens = cachedInputTokens;
}

function collectSegmentTokens(
  usage: PhaseTokenUsage | null,
  def: (typeof SEGMENT_DEFS)[number],
  model: string | null,
): { tokens: TokenBucket; sourcePhases: string[]; costUsd: number } {
  const tokens: TokenBucket = { inputTokens: 0, outputTokens: 0 };
  const sourcePhases: string[] = [];
  let costUsd = 0;
  if (!usage) return { tokens, sourcePhases, costUsd };

  const allPhases = Object.keys(usage).sort(comparePhaseName);
  const matchingPhases = [
    ...def.phases,
    ...allPhases.filter((phase) => def.includePhase?.(phase) ?? false),
  ];

  for (const phase of matchingPhases) {
    const bucket = usage[phase as keyof PhaseTokenUsage];
    if (!bucket) continue;
    addTokens(tokens, bucket);
    costUsd += phaseBucketCost(model, bucket);
    sourcePhases.push(phase);
  }

  return { tokens, sourcePhases, costUsd };
}

function phaseBucketCost(model: string | null, bucket: TokenBucket & { costUsd?: number }): number {
  if (typeof bucket.costUsd === 'number' && Number.isFinite(bucket.costUsd)) {
    return bucket.costUsd;
  }
  return computeCostWithCache(
    model,
    bucket.inputTokens,
    bucket.outputTokens,
    bucket.cachedInputTokens ?? 0,
  );
}

export function computePodCostBreakdown(pod: Pod): PodCostBreakdownResponse {
  const agentCostUsd = effectiveCostUsd(pod);
  const phaseUsage = pod.phaseTokenUsage;

  const segments: PodCostSegment[] = SEGMENT_DEFS.map((def) => {
    const { tokens, sourcePhases, costUsd } = collectSegmentTokens(phaseUsage, def, pod.model);
    return {
      bucket: def.bucket,
      label: def.label,
      costUsd,
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
      sourcePhases,
    };
  });

  const rawAgentCostUsd = segments.reduce((sum, segment) => {
    const def = SEGMENT_DEFS.find((candidate) => candidate.bucket === segment.bucket);
    return def?.costScope === 'agent' ? sum + segment.costUsd : sum;
  }, 0);

  if (rawAgentCostUsd > agentCostUsd && rawAgentCostUsd > 0) {
    const scale = agentCostUsd / rawAgentCostUsd;
    for (const segment of segments.filter((segment) => {
      const def = SEGMENT_DEFS.find((candidate) => candidate.bucket === segment.bucket);
      return def?.costScope === 'agent';
    })) {
      segment.costUsd *= scale;
    }
  }

  const attributedAgentCostUsd = segments.reduce((sum, segment) => {
    const def = SEGMENT_DEFS.find((candidate) => candidate.bucket === segment.bucket);
    return def?.costScope === 'agent' ? sum + segment.costUsd : sum;
  }, 0);
  const harnessCostUsd = segments.reduce((sum, segment) => {
    const def = SEGMENT_DEFS.find((candidate) => candidate.bucket === segment.bucket);
    return def?.costScope === 'harness' ? sum + segment.costUsd : sum;
  }, 0);
  const agentGapUsd = agentCostUsd - attributedAgentCostUsd;

  segments.push({
    bucket: 'unattributed',
    label: 'Unattributed',
    costUsd: agentGapUsd > COST_EPSILON ? agentGapUsd : 0,
    inputTokens: 0,
    outputTokens: 0,
    sourcePhases: agentGapUsd > COST_EPSILON ? ['agent_legacy'] : [],
  });

  return {
    podId: pod.id,
    model: pod.model || null,
    totalCostUsd: agentCostUsd + harnessCostUsd,
    inputTokens: pod.inputTokens,
    outputTokens: pod.outputTokens,
    segments,
  };
}
