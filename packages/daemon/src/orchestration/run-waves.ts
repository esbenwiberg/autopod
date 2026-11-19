import type Database from 'better-sqlite3';
import { signalLocalRun } from '../managed/local-run-signals.js';
import { tryRecoveryClaim } from './local-recovery-claim.js';

interface Result {
  sequence: number;
  start_key: string;
  pod_id: string;
  state: string;
  exit_code: number | null;
  artifact_id: string | null;
  candidate_digest: string | null;
}
interface PendingWait {
  wait_key: string;
  after_cursor: number;
  minimum: number;
}
export interface ResultWake {
  key: string;
  cursor: number;
  results: Result[];
  inFlight: string[];
  queued: string[];
  available: number;
}

/** Host-driven, level-triggered waits. No worker keeps a connection or polls while parked.
 * A wake is at-least-once: issue follow-ups with stable start keys before acknowledging it. */
export class RunWaves {
  constructor(private readonly db: Database.Database) {}
  available(run: string) {
    const n = this.db
      .prepare(`SELECT max(0,r.max_active-(SELECT count(*) FROM managed_pods p
      WHERE p.dispatcher_installation_id=('native.' || r.id) AND p.observed_exit=0))
      FROM orchestration_runs r WHERE r.id=? AND r.canceled=0`)
      .pluck()
      .get(run);
    return typeof n === 'number' ? n : 0;
  }
  park(run: string, key: string, after: number, minimum: number) {
    if (
      !/^[a-zA-Z0-9_-]{1,200}$/.test(key) ||
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isInteger(minimum) ||
      minimum < 1 ||
      minimum > 100
    )
      throw new Error('invalid-result-wait');
    this.db
      .transaction(() => {
        if (!this.db.prepare('SELECT 1 FROM orchestration_runs WHERE id=? AND canceled=0').get(run))
          throw new Error('inactive-run');
        if (
          after &&
          !this.db
            .prepare('SELECT 1 FROM orchestration_child_outcomes WHERE run_id=? AND sequence=?')
            .get(run, after)
        )
          throw new Error('invalid-result-cursor');
        const prior = this.db
          .prepare(
            'SELECT after_cursor,minimum FROM orchestration_result_waits WHERE run_id=? AND wait_key=?',
          )
          .get(run, key) as PendingWait | undefined;
        if (prior) {
          if (prior.after_cursor !== after || prior.minimum !== minimum)
            throw new Error('result-wait-conflict');
          return;
        }
        this.db
          .prepare(
            'INSERT INTO orchestration_result_waits(run_id,wait_key,after_cursor,minimum) VALUES (?,?,?,?)',
          )
          .run(run, key, after, minimum);
        signalLocalRun(this.db, `native.${run}`);
      })
      .immediate();
  }
  /** Rebuild readiness from durable facts, including completions that precede registration.
   * An exited but still validating child frees compute, but is not yet a returned result. */
  private ready(run: string): ResultWake[] {
    return this.db
      .transaction(() => {
        if (!this.db.prepare('SELECT 1 FROM orchestration_runs WHERE id=? AND canceled=0').get(run))
          return [];
        const waits = this.db
          .prepare(
            'SELECT wait_key,after_cursor,minimum FROM orchestration_result_waits WHERE run_id=? AND acknowledged=0 ORDER BY rowid',
          )
          .all(run) as PendingWait[];
        if (!waits.length) return [];
        this.db
          .prepare(`INSERT INTO orchestration_child_outcomes(run_id,start_key,pod_id,state,exit_code,artifact_id,candidate_digest)
        SELECT c.run_id,c.start_key,p.pod_id,p.state,p.exit_code,a.artifact_id,json_extract(s.candidate_json,'$.candidateDigest')
        FROM orchestration_continuations c JOIN managed_pods p ON p.pod_id=c.pod_id
        LEFT JOIN managed_source_candidates s ON s.pod_id=p.pod_id
        LEFT JOIN artifact_exports a ON a.pod_id=p.pod_id AND a.status='committed'
        WHERE c.run_id=? AND p.dispatcher_installation_id=('native.' || c.run_id) AND p.observed_exit=1
          AND (p.state IN ('killed','failed','complete','review_required') OR (p.state='validated' AND s.pod_id IS NOT NULL))
          AND NOT EXISTS(SELECT 1 FROM orchestration_child_outcomes o WHERE o.run_id=c.run_id AND o.start_key=c.start_key)
        ORDER BY c.rowid`)
          .run(run);
        const children = this.db
          .prepare(`SELECT c.start_key,p.pod_id,p.observed_exit FROM orchestration_continuations c LEFT JOIN managed_pods p
        ON p.dispatcher_installation_id=('native.' || c.run_id) AND p.managed_start_key=c.start_key WHERE c.run_id=? ORDER BY c.rowid`)
          .all(run) as { start_key: string; pod_id: string | null; observed_exit: number | null }[];
        const inFlight = children
          .filter((c) => c.pod_id && !c.observed_exit)
          .map((c) => c.start_key);
        const queued = children.filter((c) => !c.pod_id).map((c) => c.start_key);
        const available = this.available(run);
        const wakes: ResultWake[] = [];
        for (const wait of waits) {
          if (wait.wait_key === '@kickoff') {
            wakes.push({ key: wait.wait_key, cursor: 0, results: [], inFlight, queued, available });
            continue;
          }
          const results = this.db
            .prepare(
              `SELECT sequence,start_key,pod_id,state,exit_code,artifact_id,candidate_digest FROM orchestration_child_outcomes WHERE run_id=? AND sequence>? ORDER BY sequence LIMIT ?`,
            )
            .all(run, wait.after_cursor, wait.minimum) as Result[];
          const last = results.at(-1);
          if (last && results.length === wait.minimum)
            wakes.push({
              key: wait.wait_key,
              cursor: last.sequence,
              results,
              inFlight,
              queued,
              available,
            });
        }
        return wakes;
      })
      .immediate();
  }
  /** One scheduler pass. A failed/interrupted controller turn leaves its wake replayable. */
  async dispatch(run: string, turn: (wake: ResultWake) => Promise<void>) {
    // Only one local controller callback per run at a time, including across processes.
    const release = tryRecoveryClaim(this.db, run, '@controller-turn');
    if (!release) return;
    try {
      for (const wake of this.ready(run)) {
        if (
          !this.db
            .prepare(
              `SELECT 1 FROM orchestration_result_waits w JOIN orchestration_runs r ON r.id=w.run_id WHERE r.canceled=0 AND w.run_id=? AND w.wait_key=? AND w.acknowledged=0`,
            )
            .get(run, wake.key)
        )
          continue;
        await turn(wake);
        this.db
          .prepare(
            'UPDATE orchestration_result_waits SET acknowledged=1 WHERE run_id=? AND wait_key=?',
          )
          .run(run, wake.key);
      }
    } finally {
      release();
    }
  }
}
