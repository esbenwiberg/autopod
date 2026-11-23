import { AutopodError, type CodexFinalProofRefusal, type Pod } from '@autopod/shared';
import type Database from 'better-sqlite3';
import type { TaskExecutionLedger } from './task-execution-ledger.js';

export function readCodexFinalProofHold(db: Database.Database, podId: string, generation: number) {
  return (
    (db
      .prepare(`
    SELECT f.reason, r.id AS runId, r.cycle, r.ended_at AS endedAt
    FROM codex_final_proof_refusals f JOIN task_agent_runs r ON r.id=f.run_id
    WHERE r.pod_id=? AND r.generation=? ORDER BY r.cycle DESC LIMIT 1
  `)
      .get(podId, generation) as
      | {
          reason: CodexFinalProofRefusal;
          runId: string;
          cycle: number;
          endedAt: string | null;
        }
      | undefined) ?? null
  );
}

const CODEX_FINAL_PROOF_NEXT_STEP =
  'For an ordinary local Docker task, inspect Stop & Retain (GET /pods/:podId/stalled-worker-recovery). Only an exact sealed source receipt can be selected for retained checks. No coding replay is authorized.';

export function codexFinalProofNextStep(pod: Pick<Pod, 'id' | 'executionTarget'>): string {
  return pod.executionTarget === 'local'
    ? `Inspect stalled execution in Recovery (GET /pods/${pod.id}/stalled-worker-recovery). Only a verified stopped-resource receipt with an exact clean commit can enter retained checks.`
    : 'The stopped-Docker source seal does not support this execution target. Retain the original source and resource; no checks or worker replay are authorized by this hold.';
}

export function codexFinalProofHeld(): never {
  throw new AutopodError(
    `Native Codex final usage is incomplete. ${CODEX_FINAL_PROOF_NEXT_STEP}`,
    'CODEX_FINAL_PROOF_REFUSED',
    409,
  );
}

export function assertNoCodexFinalProofHold(
  ledger: TaskExecutionLedger | undefined,
  pod: Pick<Pod, 'id' | 'lifecycleGeneration'>,
): void {
  if (ledger?.codexFinalProofHold?.(pod.id, pod.lifecycleGeneration)) codexFinalProofHeld();
}
