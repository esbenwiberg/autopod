import type { CostAnalyticsResponse } from '@autopod/shared';
import type { PodCostSource } from './cost-pod-projection.js';
import { appendCostEvidence, emptyCostEvidence, reconcilePodCosts } from './cost-reconciliation.js';
import type { PodRepository } from './pod-repository.js';

type CompletedPod = PodCostSource & { completedAt: string };

export interface CostAggregationDeps {
  podRepo: PodRepository;
  now?: () => Date;
}

export interface CostAggregationOptions {
  days: number;
}

const TERMINAL_STATUSES = new Set(['complete', 'killed', 'failed', 'rejected']);
const WASTE_STATUSES = new Set(['killed', 'failed', 'rejected']);

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

  // Production uses a date-filtered scalar projection; compatibility for injected repositories.
  const allPods = deps.podRepo.listCostRecords?.(priorStartIso) ?? deps.podRepo.list();

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
  const evidence = emptyCostEvidence();

  for (const pod of currentPods) {
    const reconciled = reconcilePodCosts(pod, deps.podRepo.getProviderUsage?.(pod.id));
    for (const phase of reconciled.phases) {
      phaseMap.set(phase.phase, (phaseMap.get(phase.phase) ?? 0) + (phase.attributedCostUsd ?? 0));
    }
    appendCostEvidence(evidence, reconciled.evidence);
    const cost = reconciled.total;
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
    priorTotal += reconcilePodCosts(pod, deps.podRepo.getProviderUsage?.(pod.id)).total;
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
    costEvidence: evidence,
    telemetry: {
      completeness:
        evidence.unavailablePhaseCount === 0 &&
        evidence.conflictingPodCount === 0 &&
        currentPods.every(
          (pod) => pod.tokenTelemetryAccuracy !== 'partial' && !pod.recordDiagnostics?.length,
        )
          ? 'recorded'
          : 'partial',
      infrastructureCost: 'unavailable',
      diagnostics: currentPods.flatMap((pod) =>
        (pod.recordDiagnostics ?? []).map((diagnostic) => ({ podId: pod.id, ...diagnostic })),
      ),
    },
    total,
    sparkline,
    deltaVsPrior: { value: total - priorTotal, direction },
    byPhase,
    byProfileModel,
    top10,
    waste: { total: wasteTotal, podCount: wastePodCount },
  };
}
