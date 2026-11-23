import type Database from 'better-sqlite3';
import { z } from 'zod';
import { observeLocalRun } from '../managed/local-run-signals.js';
import { controllerFindings } from './controller-findings.js';
import type { ResultWake } from './run-waves.js';

const resultsSchema = z.object({ after: z.number().int().safe().min(0).default(0) }).strict();
const waitSchema = resultsSchema.extend({
  timeoutMs: z.number().int().min(1).max(15_000).default(10_000),
});
const maxResults = 8;
const maxConcurrentWaits = 32;

interface Outcome {
  sequence: number;
  start_key: string;
  pod_id: string;
  state: string;
  exit_code: number | null;
  artifact_id: string | null;
  candidate_digest: string | null;
  request_key: string;
}

export interface ParentReportResult {
  cursor: number;
  requestKey: string;
  childId: string;
  exitCode: number | null;
  report: { status: string; text?: string; truncated?: boolean };
}

export interface ParentReportPage {
  nextCursor: number;
  results: ParentReportResult[];
}

export interface ParentReportDependency {
  cursor: number;
  artifactId: string;
  childId: string;
  requestKey: string;
  text: string;
  truncated: boolean;
}

const activeWaits = new WeakMap<Database.Database, Map<string, number>>();

/** Durable, parent-scoped projection of terminal managed outcomes. Reads never contact a provider. */
export class ParentReportResults {
  constructor(private readonly db: Database.Database) {}

  private assertCursor(run: string, after: number) {
    if (
      after !== 0 &&
      !this.db
        .prepare(
          `SELECT 1 FROM orchestration_child_outcomes o
           JOIN parent_managed_requests q ON q.run_id=o.run_id AND q.start_key=o.start_key
           WHERE o.run_id=? AND o.sequence=?`,
        )
        .get(run, after)
    )
      throw new Error('parent-result-cursor-refused');
  }

  private materialize(run: string) {
    this.db
      .prepare(`INSERT INTO orchestration_child_outcomes(run_id,start_key,pod_id,state,exit_code,artifact_id,candidate_digest)
        SELECT c.run_id,c.start_key,p.pod_id,p.state,p.exit_code,
          CASE WHEN q.private_scope_json IS NULL THEN a.artifact_id END,
          json_extract(private.candidate_json,'$.candidateDigest')
        FROM orchestration_continuations c
        JOIN parent_managed_requests q ON q.run_id=c.run_id AND q.start_key=c.start_key
        JOIN managed_pods p ON p.pod_id=c.pod_id AND p.dispatcher_attempt_id=c.attempt_id
          AND p.managed_start_key=c.start_key
          AND p.execution_spec_digest=json_extract(c.request_json,'$.executionSpecDigest')
        LEFT JOIN artifact_exports a ON a.pod_id=p.pod_id AND a.status='committed'
          AND a.dispatcher_attempt_id=p.dispatcher_attempt_id
          AND a.execution_spec_digest=p.execution_spec_digest
        LEFT JOIN parent_private_candidates private ON private.pod_id=p.pod_id
        WHERE c.run_id=? AND p.dispatcher_installation_id=('native.' || c.run_id) AND p.observed_exit=1
          -- validating and review_required may still complete artifact custody.
          AND (p.state IN ('killed','failed','complete')
              OR (q.private_scope_json IS NOT NULL AND p.state='review_required'))
          AND (p.state <> 'complete' OR a.artifact_id IS NOT NULL
            OR (q.private_scope_json IS NOT NULL AND private.pod_id IS NOT NULL)
            OR json_extract(c.request_json,'$.outputs.artifacts.mode') <> 'required')
          AND NOT EXISTS(SELECT 1 FROM orchestration_child_outcomes o WHERE o.run_id=c.run_id AND o.start_key=c.start_key)
        ORDER BY c.rowid`)
      .run(run);
  }

  private rows(run: string, after: number) {
    this.materialize(run);
    this.assertCursor(run, after);
    return this.db
      .prepare(
        `SELECT o.sequence,o.start_key,o.pod_id,o.state,o.exit_code,o.artifact_id,o.candidate_digest,q.request_key
         FROM orchestration_child_outcomes o
         JOIN parent_managed_requests q ON q.run_id=o.run_id AND q.start_key=o.start_key
         WHERE o.run_id=? AND o.sequence>? ORDER BY o.sequence LIMIT ?`,
      )
      .all(run, after, maxResults) as Outcome[];
  }

  private async page(run: string, after: number): Promise<ParentReportPage> {
    const rows = this.rows(run, after);
    const successful = rows.filter(
      (row) => row.state === 'complete' && row.exit_code === 0 && !row.candidate_digest,
    );
    const reports = new Map<number, ParentReportResult['report']>();
    const successfulLast = successful.at(-1);
    if (successfulLast) {
      const wake: ResultWake = {
        key: '@parent-report',
        cursor: successfulLast.sequence,
        results: successful,
        inFlight: [],
        queued: [],
        available: 0,
      };
      const findings = await controllerFindings(this.db, run, wake);
      for (const [index, row] of successful.entries()) {
        const finding = findings[index];
        if (!finding) throw new Error('parent-report-missing');
        reports.set(row.sequence, finding);
      }
    }
    return {
      nextCursor: rows.at(-1)?.sequence ?? after,
      results: rows.map((row) => ({
        cursor: row.sequence,
        requestKey: row.request_key,
        childId: row.pod_id,
        exitCode: row.exit_code,
        report: reports.get(row.sequence) ?? {
          status:
            row.candidate_digest && row.state === 'complete'
              ? 'private-candidate-retained'
              : row.state === 'complete'
                ? 'unverified-exit'
                : row.state,
        },
      })),
    };
  }

  async dependencies(
    cursors: readonly number[],
    authenticate: () => string,
  ): Promise<ParentReportDependency[]> {
    const run = authenticate();
    this.materialize(run);
    const lookup = this.db.prepare(
      `SELECT o.sequence,o.start_key,o.pod_id,o.state,o.exit_code,o.artifact_id,o.candidate_digest,q.request_key
       FROM orchestration_child_outcomes o
       JOIN parent_managed_requests q ON q.run_id=o.run_id AND q.start_key=o.start_key
       JOIN orchestration_continuations c ON c.run_id=o.run_id AND c.start_key=o.start_key
       JOIN managed_pods p ON p.pod_id=c.pod_id AND p.pod_id=o.pod_id
         AND p.dispatcher_installation_id=('native.' || c.run_id) AND p.managed_start_key=c.start_key
         AND p.dispatcher_attempt_id=c.attempt_id AND p.observed_exit=1
         AND p.state='complete' AND p.exit_code=0
         AND p.execution_spec_digest=json_extract(c.request_json,'$.executionSpecDigest')
       WHERE o.run_id=? AND o.sequence=?`,
    );
    const rows = cursors.map((cursor) => {
      const row = lookup.get(run, cursor) as Outcome | undefined;
      if (!row || row.state !== 'complete' || row.exit_code !== 0 || !row.artifact_id)
        throw new Error('parent-report-dependency-refused');
      return { ...row, artifact_id: row.artifact_id };
    });
    if (!rows.length) return [];
    const findings = await controllerFindings(this.db, run, {
      key: '@parent-dependency',
      cursor: Math.max(...cursors),
      results: rows,
      inFlight: [],
      queued: [],
      available: 0,
    });
    if (authenticate() !== run) throw new Error('parent-session-stale');
    return rows.map((row, index) => {
      const finding = findings[index];
      if (finding?.status !== 'excerpt' || !finding.text?.trim())
        throw new Error('parent-report-dependency-refused');
      return {
        cursor: row.sequence,
        artifactId: row.artifact_id,
        childId: row.pod_id,
        requestKey: row.request_key,
        text: finding.text,
        truncated: finding.truncated ?? false,
      };
    });
  }

  async results(raw: unknown, authenticate: () => string): Promise<ParentReportPage> {
    const run = authenticate();
    const { after } = resultsSchema.parse(raw);
    const page = await this.page(run, after);
    if (authenticate() !== run) throw new Error('parent-session-stale');
    return page;
  }

  async wait(
    raw: unknown,
    authenticate: () => string,
  ): Promise<ParentReportPage & { timedOut: boolean }> {
    const run = authenticate();
    const { after, timeoutMs } = waitSchema.parse(raw);
    const counts = activeWaits.get(this.db) ?? new Map<string, number>();
    const count = counts.get(run) ?? 0;
    if (count >= maxConcurrentWaits) throw new Error('parent-wait-capacity');
    counts.set(run, count + 1);
    activeWaits.set(this.db, counts);
    const deadline = performance.now() + timeoutMs;
    const timeout = { nextCursor: after, results: [], timedOut: true } as const;
    try {
      while (true) {
        let wake!: () => void;
        const signaled = new Promise<'wake'>((resolve) => {
          wake = () => resolve('wake');
        });
        const unsubscribe = observeLocalRun(this.db, `native.${run}`, wake);
        const remaining = deadline - performance.now();
        let timer: NodeJS.Timeout | undefined;
        try {
          if (remaining <= 0) return { ...timeout, results: [] };
          const expired = new Promise<'expired'>((resolve) => {
            timer = setTimeout(() => resolve('expired'), Math.ceil(remaining));
          });
          const page = await Promise.race([this.page(run, after), expired]);
          if (authenticate() !== run) throw new Error('parent-session-stale');
          // Never advance the caller's cursor until the full page has been verified.
          if (page === 'expired' || performance.now() >= deadline)
            return { ...timeout, results: [] };
          if (page.results.length) return { ...page, timedOut: false };
          const reason = await Promise.race([signaled, expired]);
          if (authenticate() !== run) throw new Error('parent-session-stale');
          if (reason === 'expired') return { ...timeout, results: [] };
        } finally {
          if (timer) clearTimeout(timer);
          unsubscribe();
        }
      }
    } finally {
      const remaining = (counts.get(run) ?? 1) - 1;
      if (remaining) counts.set(run, remaining);
      else counts.delete(run);
    }
  }
}
