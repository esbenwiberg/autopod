import type { PodCostBreakdownResponse, PodCostBucket, PodCostSegment } from '@autopod/shared';
import type { PodCostSource } from './cost-pod-projection.js';
import { reconcilePodCosts } from './cost-reconciliation.js';
import type { ProviderUsageProjection } from './provider-usage-projection.js';

const definitions: Array<{
  bucket: PodCostBucket;
  label: string;
  includes: (phase: string) => boolean;
}> = [
  { bucket: 'work', label: 'Work', includes: (phase) => phase === 'agent_initial' },
  { bucket: 'rework', label: 'Rework', includes: (phase) => /^agent_rework_\d+$/.test(phase) },
  {
    bucket: 'validation',
    label: 'Validation',
    includes: (phase) => ['review', 'plan_eval'].includes(phase),
  },
  { bucket: 'advisory', label: 'Advisory', includes: (phase) => phase === 'advisory' },
  { bucket: 'unattributed', label: 'Unattributed', includes: (phase) => phase === 'agent_legacy' },
];

export function computePodCostBreakdown(
  pod: PodCostSource,
  usage?: ProviderUsageProjection,
): PodCostBreakdownResponse {
  const result = reconcilePodCosts(pod, usage);
  const provider = usage && usage.count > 0 ? usage : null;
  const segments: PodCostSegment[] = definitions.map((def) => {
    const phases = result.phases.filter((p) => def.includes(p.phase));
    const unavailable = phases.some((p) => p.attributedCostUsd === null);
    return {
      bucket: def.bucket,
      label: def.label,
      costUsd: phases.reduce((sum, p) => sum + (p.attributedCostUsd ?? 0), 0),
      storedCostUsd:
        phases.length === 0 || phases.some((p) => p.storedCostUsd === null)
          ? null
          : phases.reduce((sum, p) => sum + (p.storedCostUsd ?? 0), 0),
      attribution:
        def.bucket === 'unattributed'
          ? 'unattributed'
          : unavailable || phases.length === 0
            ? 'unavailable'
            : 'stored',
      inputTokens: phases.reduce((sum, p) => sum + p.inputTokens, 0),
      outputTokens: phases.reduce((sum, p) => sum + p.outputTokens, 0),
      sourcePhases: phases.map((p) => p.phase),
    };
  });
  return {
    podId: pod.id,
    model: pod.model || null,
    totalCostUsd: result.total,
    inputTokens: provider ? (provider.inputTokens ?? 0) : pod.inputTokens,
    outputTokens: provider ? (provider.outputTokens ?? 0) : pod.outputTokens,
    segments,
    costEvidence: result.evidence,
  };
}
