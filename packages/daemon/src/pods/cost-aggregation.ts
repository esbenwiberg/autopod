import {
  type CostAnalyticsResponse,
  MODEL_PRICING,
  type Pod,
  computeCostWithCache,
  effectiveCostUsd,
} from '@autopod/shared';
import type { PodRepository } from './pod-repository.js';

type CompletedPod = Pod & { completedAt: string };

export interface CostAggregationDeps {
  podRepo: PodRepository;
  now?: () => Date;
}

export interface CostAggregationOptions {
  days: number;
}

const TERMINAL_STATUSES = new Set(['complete', 'killed', 'failed', 'rejected']);
const WASTE_STATUSES = new Set(['killed', 'failed', 'rejected']);
const COST_EPSILON = 1e-9;

type PhaseBucket = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  costUsd?: number;
};

/** Sort phase keys per spec: agent_initial, agent_rework_1..N, review, plan_eval, advisory, agent_legacy. */
function comparePhaseKeys(a: string, b: string): number {
  if (a === b) return 0;
  if (a === 'agent_initial') return -1;
  if (b === 'agent_initial') return 1;
  const reworkRe = /^agent_rework_(\d+)$/;
  const aM = reworkRe.exec(a);
  const bM = reworkRe.exec(b);
  if (aM && bM) return Number(aM[1]) - Number(bM[1]);
  if (aM) return -1;
  if (bM) return 1;
  const tail = ['review', 'plan_eval', 'advisory', 'agent_legacy'];
  return tail.indexOf(a) - tail.indexOf(b);
}

function isAgentPhaseKey(key: string): boolean {
  return key === 'agent_initial' || /^agent_rework_\d+$/.test(key);
}

function isHarnessPhaseKey(key: string): boolean {
  return key === 'review' || key === 'plan_eval' || key === 'advisory';
}

function isKnownPhaseKey(key: string): boolean {
  return isAgentPhaseKey(key) || isHarnessPhaseKey(key);
}

function phaseBucketCost(model: string | null, bucket: PhaseBucket): number {
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

function harnessCostForPod(pod: Pod): number {
  let cost = 0;
  if (!pod.phaseTokenUsage) return cost;
  for (const [key, bucket] of Object.entries(pod.phaseTokenUsage)) {
    if (!bucket || !isHarnessPhaseKey(key)) continue;
    cost += phaseBucketCost(pod.model, bucket);
  }
  return cost;
}

/**
 * Parse `days` query param — returns a positive integer or null on invalid input.
 * Exported so the route can import it without duplicating logic.
 */
export function parseDays(query: Record<string, unknown>): number | null {
  const raw = query.days;
  if (raw === undefined || raw === null) return 30;
  const str = String(raw);
  // Must be digits only (no sign, no decimal point).
  if (!/^\d+$/.test(str)) return null;
  const n = Number.parseInt(str, 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return n;
}

export function aggregateCost(
  deps: CostAggregationDeps,
  options: CostAggregationOptions,
): CostAnalyticsResponse {
  const { days } = options;
  const now = (deps.now ?? (() => new Date()))();
  const windowEndMs = now.getTime();
  const windowStartMs = windowEndMs - days * 86_400_000;
  const priorStartMs = windowStartMs - days * 86_400_000;

  const windowStartIso = new Date(windowStartMs).toISOString();
  const priorStartIso = new Date(priorStartMs).toISOString();

  // Fetch all pods; filter in-memory (operator-grade dataset, no date-range query needed).
  const allPods = deps.podRepo.list();

  const relevant = allPods.filter(
    (pod): pod is CompletedPod =>
      TERMINAL_STATUSES.has(pod.status) &&
      pod.options.agentMode !== 'interactive' &&
      pod.completedAt !== null &&
      pod.completedAt >= priorStartIso,
  );

  const currentPods = relevant.filter((pod) => pod.completedAt >= windowStartIso);
  const priorPods = relevant.filter((pod) => pod.completedAt < windowStartIso);

  const sparkline = Array.from({ length: days }, (_, i) => ({
    day: new Date(windowStartMs + i * 86_400_000).toISOString().slice(0, 10),
    costUsd: 0,
  }));

  let total = 0;
  let priorTotal = 0;
  let wasteTotal = 0;
  let wastePodCount = 0;
  const phaseMap = new Map<string, number>();
  const profileModelMap = new Map<
    string,
    { profile: string; model: string | null; costUsd: number; podCount: number }
  >();
  // Cache cost per pod so top10 sort doesn't re-invoke effectiveCostUsd.
  const costById = new Map<string, number>();
  const unknownPhaseKeys = new Set<string>();
  const unknownModels = new Set<string>();

  for (const pod of currentPods) {
    const agentCost = effectiveCostUsd(pod);

    if (pod.costUsd === 0 && pod.model && !MODEL_PRICING[pod.model]) {
      unknownModels.add(pod.model);
    }

    const agentPhaseCosts: Array<{ key: string; costUsd: number }> = [];
    const harnessPhaseCosts: Array<{ key: string; costUsd: number }> = [];
    let rawAgentPhaseCostSum = 0;
    if (pod.phaseTokenUsage) {
      for (const [key, bucket] of Object.entries(pod.phaseTokenUsage)) {
        if (!bucket) continue;
        if (!isKnownPhaseKey(key)) {
          unknownPhaseKeys.add(key);
          continue;
        }
        const phaseCost = phaseBucketCost(pod.model, bucket);
        if (isAgentPhaseKey(key)) {
          agentPhaseCosts.push({ key, costUsd: phaseCost });
          rawAgentPhaseCostSum += phaseCost;
        } else {
          harnessPhaseCosts.push({ key, costUsd: phaseCost });
        }
      }
    }

    const phaseScale =
      rawAgentPhaseCostSum > agentCost && rawAgentPhaseCostSum > 0
        ? agentCost / rawAgentPhaseCostSum
        : 1;
    let agentPhaseCostSum = 0;
    for (const phase of agentPhaseCosts) {
      const scaledCost = phase.costUsd * phaseScale;
      phaseMap.set(phase.key, (phaseMap.get(phase.key) ?? 0) + scaledCost);
      agentPhaseCostSum += scaledCost;
    }
    const gap = agentCost - agentPhaseCostSum;
    if (gap > COST_EPSILON) {
      phaseMap.set('agent_legacy', (phaseMap.get('agent_legacy') ?? 0) + gap);
    }
    let harnessCost = 0;
    for (const phase of harnessPhaseCosts) {
      phaseMap.set(phase.key, (phaseMap.get(phase.key) ?? 0) + phase.costUsd);
      harnessCost += phase.costUsd;
    }

    const cost = agentCost + harnessCost;
    costById.set(pod.id, cost);
    total += cost;

    if (WASTE_STATUSES.has(pod.status)) {
      wasteTotal += cost;
      wastePodCount += 1;
    }

    const completedMs = new Date(pod.completedAt).getTime();
    const dayOffset = Math.floor((completedMs - windowStartMs) / 86_400_000);
    const bucket = sparkline[dayOffset];
    if (bucket) {
      bucket.costUsd += cost;
    }

    const pmKey = `${pod.profileName}\0${pod.model ?? ''}`;
    const pm = profileModelMap.get(pmKey) ?? {
      profile: pod.profileName,
      model: pod.model ?? null,
      costUsd: 0,
      podCount: 0,
    };
    pm.costUsd += cost;
    pm.podCount += 1;
    profileModelMap.set(pmKey, pm);
  }

  for (const pod of priorPods) {
    priorTotal += effectiveCostUsd(pod) + harnessCostForPod(pod);
  }

  if (unknownPhaseKeys.size > 0) {
    console.warn(
      `[cost-aggregation] Ignoring unrecognized phaseTokenUsage keys: ${[...unknownPhaseKeys].join(', ')}`,
    );
  }
  if (unknownModels.size > 0) {
    console.warn(
      `[cost-aggregation] Unknown model(s) — effective cost defaulted to 0: ${[...unknownModels].join(', ')}`,
    );
  }

  let direction: 'up' | 'down' | 'flat';
  if (priorTotal === 0) {
    direction = total > 0 ? 'up' : 'flat';
  } else if (total > priorTotal * 1.05) {
    direction = 'up';
  } else if (total < priorTotal * 0.95) {
    direction = 'down';
  } else {
    direction = 'flat';
  }

  const byPhase = [...phaseMap.entries()]
    .filter(([, v]) => v > 0)
    .sort(([a], [b]) => comparePhaseKeys(a, b))
    .map(([phase, costUsd]) => ({ phase, costUsd }));

  const byProfileModel = [...profileModelMap.values()].sort((a, b) => b.costUsd - a.costUsd);

  const top10 = currentPods
    .map((pod) => ({ pod, cost: costById.get(pod.id) ?? 0 }))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 10)
    .map(({ pod, cost }) => ({
      podId: pod.id,
      profile: pod.profileName,
      model: pod.model ?? null,
      finalStatus: pod.status as 'complete' | 'killed' | 'failed' | 'rejected',
      costUsd: cost,
      completedAt: pod.completedAt,
    }));

  return {
    total,
    sparkline,
    deltaVsPrior: { value: total - priorTotal, direction },
    byPhase,
    byProfileModel,
    top10,
    waste: { total: wasteTotal, podCount: wastePodCount },
  };
}
