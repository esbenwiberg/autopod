import type { CostEvidence, Pod } from '@autopod/shared';
import type { ProviderUsageProjection } from './provider-usage-projection.js';

export interface CostPhase {
  phase: string;
  scope: 'agent' | 'harness';
  storedCostUsd: number | null;
  attributedCostUsd: number | null;
  inputTokens: number;
  outputTokens: number;
}
export const finiteAmount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
export const isAgentCostPhase = (phase: string): boolean =>
  phase === 'agent_initial' || /^agent_rework_\d+$/.test(phase);
export const isHarnessCostPhase = (phase: string): boolean =>
  ['review', 'plan_eval', 'advisory'].includes(phase);

/** Reconcile stored amounts without substituting current model prices or
 * manufacturing phase allocation. A conflicting source remains visible. */
export function reconcilePodCosts(
  pod: Pick<Pod, 'id' | 'inputTokens' | 'outputTokens' | 'costUsd' | 'recordDiagnostics'> & {
    phaseTokenUsage: unknown;
    historyArchived?: boolean;
  },
  usage?: ProviderUsageProjection,
): { total: number; agent: number; phases: CostPhase[]; evidence: CostEvidence } {
  const diagnostics: CostEvidence['diagnostics'] = [];
  let omittedDiagnosticCount = 0;
  const diagnose = (code: string, message: string) => {
    if (diagnostics.length < 100) diagnostics.push({ podId: pod.id, code, message });
    else omittedDiagnosticCount++;
  };
  if (pod.historyArchived)
    diagnose('RETAINED_DELETED_POD', 'Deleted pod retained in recorded cost totals.');
  for (const issue of pod.recordDiagnostics ?? []) {
    if (issue.field === 'phase_token_usage')
      diagnose(
        issue.code === 'size_limit' ? 'PHASE_PAYLOAD_LIMIT' : 'PHASE_PAYLOAD_INVALID',
        issue.code === 'size_limit'
          ? 'Phase telemetry exceeds the 64 KiB read limit; its cost is unavailable and the stored source is preserved.'
          : 'Some phase telemetry is unreadable; healthy stored phase amounts remain included.',
      );
  }
  const provider = usage && usage.count > 0 ? usage : null;
  const amount = provider ? provider.costUsd : pod.costUsd;
  const agent = finiteAmount(amount) ? amount : 0;
  if (!finiteAmount(amount))
    diagnose('AGENT_COST_UNAVAILABLE', 'Agent cost is unavailable; subtotal excludes it.');
  const phases: CostPhase[] = [];
  const raw: unknown = pod.phaseTokenUsage;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [phase, value] of Object.entries(raw)) {
      if (!isAgentCostPhase(phase) && !isHarnessCostPhase(phase)) {
        diagnose('UNKNOWN_COST_PHASE', 'An unrecognized phase is excluded from the subtotal.');
        continue;
      }
      const bucket =
        value && typeof value === 'object' && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {};
      const cost = finiteAmount(bucket.costUsd) ? bucket.costUsd : null;
      if (cost === null)
        diagnose(
          'PHASE_COST_UNAVAILABLE',
          `Cost for ${phase} is unavailable; worker-model pricing is not substituted.`,
        );
      phases.push({
        phase,
        scope: isAgentCostPhase(phase) ? 'agent' : 'harness',
        storedCostUsd: cost,
        attributedCostUsd: cost,
        inputTokens: finiteAmount(bucket.inputTokens) ? bucket.inputTokens : 0,
        outputTokens: finiteAmount(bucket.outputTokens) ? bucket.outputTokens : 0,
      });
    }
  } else {
    diagnose('PHASE_ATTRIBUTION_UNAVAILABLE', 'Phase cost attribution is unavailable.');
  }
  const agentPhases = phases.filter((p) => p.scope === 'agent');
  const phaseSum = agentPhases.reduce((sum, p) => sum + (p.storedCostUsd ?? 0), 0);
  const stalePhaseBasis =
    provider &&
    agentPhases.length > 0 &&
    (provider.inputTokens !== pod.inputTokens ||
      provider.outputTokens !== pod.outputTokens ||
      provider.costUsd !== pod.costUsd);
  const conflict = !!stalePhaseBasis || !Number.isFinite(phaseSum) || phaseSum > agent + 1e-9;
  if (conflict) {
    diagnose(
      'PHASE_COST_CONFLICT',
      stalePhaseBasis
        ? 'Corrected provider totals differ from the saved phase basis. Agent cost remains unattributed.'
        : 'Stored agent phase costs exceed the agent subtotal. No proportional allocation is applied.',
    );
    for (const phase of agentPhases) phase.attributedCostUsd = null;
  }
  const attributed = agentPhases.reduce((sum, p) => sum + (p.attributedCostUsd ?? 0), 0);
  const gap = agent - attributed;
  if (gap > 1e-9)
    phases.push({
      phase: 'agent_legacy',
      scope: 'agent',
      storedCostUsd: null,
      attributedCostUsd: gap,
      inputTokens: 0,
      outputTokens: 0,
    });
  const harness = phases
    .filter((p) => p.scope === 'harness')
    .reduce((sum, p) => sum + (p.attributedCostUsd ?? 0), 0);
  const estimated = provider?.knownEstimatedCostUsd;
  if (finiteAmount(estimated) && estimated > 0)
    diagnose(
      'KNOWN_COST_ESTIMATE',
      'Codex rollout correction costs include daemon price estimates.',
    );
  diagnose(
    'COST_PROVENANCE_UNVERIFIED',
    'Stored amounts can include runtime or historical estimates; billing and infrastructure cost are unverified.',
  );
  return {
    total: agent + harness,
    agent,
    phases,
    evidence: {
      basis: 'stored_subtotal',
      billingVerified: false,
      knownEstimatedCostUsd: finiteAmount(estimated) ? estimated : 0,
      unavailablePhaseCount: phases.filter(
        (p) => p.phase !== 'agent_legacy' && p.storedCostUsd === null,
      ).length,
      conflictingPodCount: conflict ? 1 : 0,
      diagnostics,
      omittedDiagnosticCount,
    },
  };
}

export function emptyCostEvidence(): CostEvidence {
  return {
    basis: 'stored_subtotal',
    billingVerified: false,
    knownEstimatedCostUsd: 0,
    unavailablePhaseCount: 0,
    conflictingPodCount: 0,
    diagnostics: [],
    omittedDiagnosticCount: 0,
  };
}
export function appendCostEvidence(target: CostEvidence, source: CostEvidence): void {
  target.knownEstimatedCostUsd += source.knownEstimatedCostUsd;
  target.unavailablePhaseCount += source.unavailablePhaseCount;
  target.conflictingPodCount += source.conflictingPodCount;
  const room = Math.max(0, 100 - target.diagnostics.length);
  target.diagnostics.push(...source.diagnostics.slice(0, room));
  target.omittedDiagnosticCount +=
    source.omittedDiagnosticCount + Math.max(0, source.diagnostics.length - room);
}
