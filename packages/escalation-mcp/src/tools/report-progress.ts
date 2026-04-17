import type { PodBridge } from '../pod-bridge.js';

export interface ReportProgressInput {
  phase: string;
  description: string;
  currentPhase: number;
  totalPhases: number;
}

export async function reportProgress(
  podId: string,
  input: ReportProgressInput,
  bridge: PodBridge,
): Promise<string> {
  bridge.reportProgress(
    podId,
    input.phase,
    input.description,
    input.currentPhase,
    input.totalPhases,
  );
  return `Progress updated: phase ${input.currentPhase}/${input.totalPhases} — ${input.phase}`;
}
