import type Database from 'better-sqlite3';
import type { OrchestrationContinuations } from './continuations.js';

type Target = { run_id: string; kind: 'controller' | 'allocation'; key: string; binding: string };
type Observation = Target & { pod_id: string | null; reserved_requests: number };
type Fence = Observation & { actor: string; case_ref: string; recorded_at: number };

/** Local host only. Actor comes from the operator's trusted caller, not the controller.
 * 'Unknown' means missing evidence at inspection time, not proof of provider/runtime failure. */
export class UnknownOutcomes {
  constructor(
    private readonly db: Database.Database,
    private readonly ledger: OrchestrationContinuations,
  ) {}
  inspect(run: string) {
    return this.db.transaction(() => ({
      unknown: this.db
        .prepare('SELECT * FROM orchestration_unknown_outcomes WHERE run_id=? ORDER BY kind,key')
        .all(run) as Observation[],
      fences: this.db
        .prepare('SELECT * FROM orchestration_unknown_fences WHERE run_id=? ORDER BY kind,key')
        .all(run) as Fence[],
    }))();
  }
  /** Irreversible run-wide stop. The watchdog can still learn a runtime ref and observe exit.
   * An exact replay returns the historical receipt even if the uncertainty has since cleared. */
  fence(target: Target, actor: string, caseRef: string): Fence {
    const label = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
    if (!label.test(actor) || !label.test(caseRef)) throw new Error('invalid-operator-reference');
    const { run_id, kind, key, binding } = target;
    return this.db
      .transaction(() => {
        const prior = () =>
          this.db
            .prepare(
              'SELECT * FROM orchestration_unknown_fences WHERE run_id=? AND kind=? AND key=?',
            )
            .get(run_id, kind, key) as Fence | undefined;
        const saved = prior();
        if (saved) {
          if (saved.binding !== binding || saved.actor !== actor || saved.case_ref !== caseRef)
            throw new Error('unknown-fence-conflict');
          return saved;
        }
        const inserted = this.db
          .prepare(`INSERT INTO orchestration_unknown_fences (run_id,kind,key,binding,pod_id,reserved_requests,actor,case_ref)
        SELECT run_id,kind,key,binding,pod_id,reserved_requests,?,? FROM orchestration_unknown_outcomes WHERE run_id=? AND kind=? AND key=? AND binding=?`)
          .run(actor, caseRef, run_id, kind, key, binding);
        if (inserted.changes !== 1) throw new Error('outcome-not-unknown');
        // Nested SQLite transaction: the audit row and existing run/descendant fences commit together.
        this.ledger.cancel(run_id);
        const receipt = prior();
        if (!receipt) throw new Error('unknown-fence-missing');
        return receipt;
      })
      .immediate();
  }
}
