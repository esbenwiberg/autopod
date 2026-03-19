import type { SessionBridge } from '../session-bridge.js';

export interface ReportProgressInput {
  phase: string;
  description: string;
  currentPhase: number;
  totalPhases: number;
}

export async function reportProgress(
  sessionId: string,
  input: ReportProgressInput,
  bridge: SessionBridge,
): Promise<string> {
  bridge.reportProgress(
    sessionId,
    input.phase,
    input.description,
    input.currentPhase,
    input.totalPhases,
  );
  return `Progress updated: phase ${input.currentPhase}/${input.totalPhases} — ${input.phase}`;
}
