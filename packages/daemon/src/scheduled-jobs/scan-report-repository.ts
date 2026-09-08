import { randomUUID } from 'node:crypto';
import {
  AutopodError,
  type ScanDecisionPage,
  type ScanFindingPage,
  type ScanRecordDiagnostic,
  type ScanReportPage,
  type ScanReportSummary,
  type ScanTriageDecision,
  type ScheduledScanCollection,
  type ScheduledScanFinding,
  type ScheduledScanPolicy,
  type ScheduledScanReport,
} from '@autopod/shared';
import type Database from 'better-sqlite3';
import {
  readScanDecision,
  readScanFinding,
  scanDecisionProjection,
  scanFindingProjection,
  scanRecordDiagnostic,
} from './scan-record-reader.js';

export type { ScanTriageDecision } from '@autopod/shared';
export interface ScanReportRepository {
  begin(jobId: string, runKey: string, policy: ScheduledScanPolicy): ScheduledScanReport;
  get(id: string): ScheduledScanReport;
  claim(id: string, owner: string): boolean;
  list(jobId: string): ScheduledScanReport[];
  page(jobId: string, before?: string): ScanReportPage;
  unresolvedPage(reportId: string, after?: string): ScanFindingPage;
  selectedUnresolved(reportId: string, ids: string[]): ScanFindingPage['items'];
  decisionPage(reportId: string, before?: string): ScanDecisionPage;
  getDecision(reportId: string, id: string): ScanDecisionPage['items'][number];
  decisions(reportId: string): Array<ScanTriageDecision & { repairPodId: string | null }>;
  finish(id: string, collection: ScheduledScanCollection): ScheduledScanReport;
  setJudgment(id: string, judgment: ScheduledScanReport['judgment']): void;
  recoverInterrupted(): number;
  unresolved(
    reportId: string,
  ): Array<ScheduledScanFinding & { disposition: 'unresolved' | 'deferred' }>;
  triage(input: Omit<ScanTriageDecision, 'id' | 'createdAt'>): ScanTriageDecision;
  launchRepair(selectionId: string, create: (decision: ScanTriageDecision) => string): string;
}

export function createScanReportRepository(db: Database.Database): ScanReportRepository {
  const get = (id: string): ScheduledScanReport => {
    const row = db.prepare('SELECT * FROM scheduled_scan_reports WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new AutopodError('Scan report not found', 'NOT_FOUND', 404);
    return {
      kind: 'scan_report',
      id,
      jobId: row.job_id as string,
      status: row.status as ScheduledScanReport['status'],
      policy: JSON.parse(row.policy as string),
      collection: row.collection ? JSON.parse(row.collection as string) : null,
      judgment: JSON.parse(row.judgment as string),
      createdAt: row.created_at as string,
      completedAt: row.completed_at as string | null,
    };
  };
  const decision = readScanDecision;
  const unresolved = (reportId: string) => {
    const report = get(reportId);
    const rows = db
      .prepare(`SELECT DISTINCT ${scanFindingProjection} FROM scheduled_scan_findings f
      JOIN scheduled_scan_occurrences o ON o.finding_id = f.id JOIN scheduled_scan_reports r ON r.id = o.report_id
      WHERE r.job_id = ? AND f.disposition != 'resolved' AND (? IS NULL OR f.repository = ?) ORDER BY f.id LIMIT 1001`)
      .all(
        report.jobId,
        report.collection?.repository ?? null,
        report.collection?.repository ?? null,
      ) as Array<{ id: string; finding: string | null; disposition: 'unresolved' | 'deferred' }>;
    if (rows.length > 1000)
      throw new AutopodError(
        'Triage scope exceeds 1000 findings; paginate or narrow the job',
        'SCAN_SCOPE_TOO_LARGE',
        409,
      );
    return rows.map(readScanFinding);
  };
  const selectedUnresolved = (reportId: string, ids: string[]): ScanFindingPage['items'] => {
    if (!ids.length || ids.length > 100 || ids.some((id) => !id || id.length > 200))
      throw new AutopodError('Select 1 to 100 bounded finding IDs', 'INVALID_INPUT', 400);
    const report = get(reportId);
    const rows = db
      .prepare(`SELECT ${scanFindingProjection} FROM scheduled_scan_findings f
      WHERE f.disposition != 'resolved' AND f.id IN (${ids.map(() => '?').join(',')})
      AND (? IS NULL OR f.repository = ?)
      AND EXISTS (SELECT 1 FROM scheduled_scan_occurrences o JOIN scheduled_scan_reports r ON r.id = o.report_id WHERE o.finding_id = f.id AND r.job_id = ?)`)
      .all(
        ...ids,
        report.collection?.repository ?? null,
        report.collection?.repository ?? null,
        report.jobId,
      ) as Array<{ id: string; finding: string | null; disposition: 'unresolved' | 'deferred' }>;
    return rows.map(readScanFinding);
  };
  const getDecision = (reportId: string, id: string): ScanDecisionPage['items'][number] => {
    get(reportId);
    const row = db
      .prepare(
        `SELECT ${scanDecisionProjection}, r.pod_id AS repair_pod_id FROM scheduled_scan_triage t LEFT JOIN scheduled_scan_repairs r ON r.selection_id = t.id WHERE t.report_id = ? AND t.id = ?`,
      )
      .get(reportId, id) as Record<string, unknown> | undefined;
    if (!row)
      throw new AutopodError('Selection does not belong to this report', 'INVALID_INPUT', 400);
    return { ...decision(row), repairPodId: row.repair_pod_id as string | null };
  };
  return {
    get,
    selectedUnresolved,
    getDecision,
    unresolvedPage(reportId, after) {
      const report = get(reportId);
      if (after !== undefined && (!after || after.length > 200))
        throw new AutopodError('Invalid finding cursor', 'SCAN_CURSOR_INVALID', 400);
      const scope =
        '(? IS NULL OR f.repository = ?) AND EXISTS (SELECT 1 FROM scheduled_scan_occurrences o JOIN scheduled_scan_reports r ON r.id = o.report_id WHERE o.finding_id = f.id AND r.job_id = ?)';
      const bindings = [
        report.collection?.repository ?? null,
        report.collection?.repository ?? null,
        report.jobId,
      ];
      if (
        after &&
        !db
          .prepare(`SELECT f.id FROM scheduled_scan_findings f WHERE f.id = ? AND ${scope}`)
          .get(after, ...bindings)
      )
        throw new AutopodError(
          'Finding cursor does not belong to this review; refresh findings.',
          'SCAN_CURSOR_INVALID',
          400,
        );
      const rows = db
        .prepare(
          `SELECT ${scanFindingProjection} FROM scheduled_scan_findings f WHERE f.disposition != 'resolved' AND ${scope} AND (? IS NULL OR f.id > ?) ORDER BY f.id LIMIT 51`,
        )
        .all(...bindings, after ?? null, after ?? null) as Array<{
        id: string;
        finding: string | null;
        disposition: 'unresolved' | 'deferred';
      }>;
      const diagnostics: ScanRecordDiagnostic[] = [];
      const items: ScanFindingPage['items'] = [];
      for (const row of rows.slice(0, 50)) {
        try {
          items.push(readScanFinding(row));
        } catch (error) {
          if (!(error instanceof AutopodError) || error.code !== 'SCAN_RECONCILIATION_REQUIRED')
            throw error;
          diagnostics.push(scanRecordDiagnostic('finding', row.id));
        }
      }
      return { items, diagnostics, nextCursor: rows.length > 50 ? (rows[49]?.id ?? null) : null };
    },
    decisionPage(reportId, before) {
      get(reportId);
      const anchor = before
        ? (db
            .prepare('SELECT rowid FROM scheduled_scan_triage WHERE report_id = ? AND id = ?')
            .get(reportId, before) as { rowid: number } | undefined)
        : undefined;
      if (before !== undefined && !anchor)
        throw new AutopodError(
          'Decision cursor does not belong to this report',
          'SCAN_CURSOR_INVALID',
          400,
        );
      const rows = db
        .prepare(
          `SELECT ${scanDecisionProjection}, r.pod_id AS repair_pod_id FROM scheduled_scan_triage t LEFT JOIN scheduled_scan_repairs r ON r.selection_id = t.id WHERE t.report_id = ? AND (? IS NULL OR t.rowid < ?) ORDER BY t.rowid DESC LIMIT 26`,
        )
        .all(reportId, anchor?.rowid ?? null, anchor?.rowid ?? null) as Array<
        Record<string, unknown>
      >;
      const diagnostics: ScanRecordDiagnostic[] = [];
      const items: ScanDecisionPage['items'] = [];
      for (const row of rows.slice(0, 25)) {
        try {
          items.push({ ...decision(row), repairPodId: row.repair_pod_id as string | null });
        } catch (error) {
          if (!(error instanceof AutopodError) || error.code !== 'SCAN_RECONCILIATION_REQUIRED')
            throw error;
          diagnostics.push(scanRecordDiagnostic('decision', row.id as string));
        }
      }
      return {
        items,
        diagnostics,
        nextCursor: rows.length > 25 ? ((rows[24]?.id as string | undefined) ?? null) : null,
      };
    },
    claim(id, owner) {
      return (
        db
          .prepare(
            "UPDATE scheduled_scan_reports SET collector_owner = ? WHERE id = ? AND status = 'collecting' AND collector_owner IS NULL",
          )
          .run(owner, id).changes === 1
      );
    },
    unresolved,
    decisions(reportId) {
      get(reportId);
      const rows = db
        .prepare(`SELECT ${scanDecisionProjection}, r.pod_id AS repair_pod_id FROM scheduled_scan_triage t
        LEFT JOIN scheduled_scan_repairs r ON r.selection_id = t.id
        WHERE t.report_id = ? ORDER BY t.created_at, t.id LIMIT 1000`)
        .all(reportId) as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        ...decision(row),
        repairPodId: (row.repair_pod_id as string | null) ?? null,
      }));
    },
    begin: db.transaction((jobId: string, runKey: string, policy: ScheduledScanPolicy) => {
      const existing = db
        .prepare('SELECT id FROM scheduled_scan_reports WHERE run_key = ?')
        .get(runKey) as { id: string } | undefined;
      if (existing) {
        const report = get(existing.id);
        if (report.jobId !== jobId || JSON.stringify(report.policy) !== JSON.stringify(policy))
          throw new AutopodError(
            'Scan run identity already has different inputs',
            'SCAN_RECONCILIATION_REQUIRED',
            409,
          );
        return report;
      }
      const id = randomUUID();
      db.prepare(
        `INSERT INTO scheduled_scan_reports (id, job_id, run_key, status, policy, judgment, created_at) VALUES (?, ?, ?, 'collecting', ?, ?, ?)`,
      ).run(
        id,
        jobId,
        runKey,
        JSON.stringify(policy),
        JSON.stringify({ status: policy.judgment === 'bounded' ? 'pending' : 'not_requested' }),
        new Date().toISOString(),
      );
      return get(id);
    }),
    page(jobId, before) {
      const anchor = before
        ? (db
            .prepare('SELECT created_at FROM scheduled_scan_reports WHERE job_id = ? AND id = ?')
            .get(jobId, before) as { created_at: string } | undefined)
        : undefined;
      if (before !== undefined && !anchor)
        throw new AutopodError(
          'Report cursor is not available in this schedule; refresh history.',
          'SCAN_CURSOR_INVALID',
          400,
        );
      const rows = db
        .prepare(`SELECT id, job_id, status, created_at, completed_at,
        CASE WHEN json_valid(collection) THEN CASE WHEN json_type(collection, '$.findings') = 'array' THEN json_array_length(collection, '$.findings') END END AS finding_count,
        CASE WHEN json_valid(judgment) THEN CASE WHEN json_type(judgment, '$.status') = 'text' THEN json_extract(judgment, '$.status') END END AS judgment_status
        FROM scheduled_scan_reports WHERE job_id = ?
        AND (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?))
        ORDER BY created_at DESC, id DESC LIMIT 21`)
        .all(
          jobId,
          before ?? null,
          anchor?.created_at ?? null,
          anchor?.created_at ?? null,
          before ?? null,
        ) as Array<{
        id: string;
        job_id: string;
        status: ScanReportSummary['status'];
        created_at: string;
        completed_at: string | null;
        finding_count: number | null;
        judgment_status: string | null;
      }>;
      const items = rows.slice(0, 20).map((row) => {
        const judgmentStatus = [
          'not_requested',
          'skipped_empty',
          'pending',
          'complete',
          'unavailable',
        ].includes(row.judgment_status ?? '')
          ? (row.judgment_status as ScanReportSummary['judgmentStatus'])
          : null;
        return {
          id: row.id,
          jobId: row.job_id,
          status: row.status,
          createdAt: row.created_at,
          completedAt: row.completed_at,
          findingCount: row.finding_count,
          judgmentStatus,
          diagnostics: [
            ...(row.finding_count === null
              ? ['Finding count unavailable; inspect report evidence.']
              : []),
            ...(judgmentStatus === null
              ? ['Judgment summary unavailable; inspect report evidence.']
              : []),
          ],
        };
      });
      return { items, nextCursor: rows.length > 20 ? (items.at(-1)?.id ?? null) : null };
    },
    list(jobId) {
      return (
        db
          .prepare(
            'SELECT id FROM scheduled_scan_reports WHERE job_id = ? ORDER BY created_at DESC, id DESC LIMIT 100',
          )
          .all(jobId) as Array<{ id: string }>
      ).map((row) => get(row.id));
    },
    finish: db.transaction((id: string, collection: ScheduledScanCollection) => {
      const report = get(id);
      if (report.completedAt) {
        if (JSON.stringify(report.collection) !== JSON.stringify(collection))
          throw new AutopodError('Completed scan already has different evidence', 'CONFLICT', 409);
        return report;
      }
      if (
        Buffer.byteLength(JSON.stringify(collection)) > 2 * 1024 * 1024 ||
        collection.files.length > 200 ||
        collection.findings.length > 1000
      )
        throw new AutopodError(
          'Scan evidence exceeds supported report bounds',
          'SCAN_SCOPE_TOO_LARGE',
          409,
        );
      const exactFiles = new Set(collection.files.map((file) => file.path));
      if (collection.findings.some((finding) => !exactFiles.has(finding.file)))
        throw new AutopodError(
          'Finding lies outside the exact requested delta',
          'SCAN_SCOPE_MISMATCH',
          409,
        );
      const incomplete =
        !/^[a-f0-9]{40,64}$/.test(collection.baseSha ?? '') ||
        !/^[a-f0-9]{40,64}$/.test(collection.headSha ?? '') ||
        collection.diagnostics.length > 0 ||
        report.policy.scanners.some(
          (scanner) =>
            !collection.scanners.some(
              (result) =>
                result.scanner === scanner &&
                (collection.files.length === 0
                  ? result.status === 'skipped_empty'
                  : ['completed', 'not_applicable'].includes(result.status)),
            ),
        );
      const status = incomplete
        ? 'incomplete'
        : collection.files.length === 0
          ? 'empty_delta'
          : 'complete';
      const now = new Date().toISOString();
      db.prepare(
        'UPDATE scheduled_scan_reports SET status = ?, collection = ?, completed_at = ? WHERE id = ?',
      ).run(status, JSON.stringify(collection), now, id);
      for (const finding of collection.findings) {
        db.prepare(`INSERT INTO scheduled_scan_findings (id, repository, finding, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET finding = excluded.finding, last_seen_at = excluded.last_seen_at, disposition = CASE WHEN scheduled_scan_findings.disposition = 'resolved' THEN 'unresolved' ELSE scheduled_scan_findings.disposition END`).run(
          finding.id,
          collection.repository,
          JSON.stringify(finding),
          now,
          now,
        );
        db.prepare(
          'INSERT OR IGNORE INTO scheduled_scan_occurrences (report_id, finding_id) VALUES (?, ?)',
        ).run(id, finding.id);
      }
      return get(id);
    }),
    setJudgment(id, judgment) {
      get(id);
      db.prepare(
        "UPDATE scheduled_scan_reports SET judgment = ? WHERE id = ? AND json_extract(judgment, '$.status') = 'pending'",
      ).run(JSON.stringify(judgment), id);
    },
    recoverInterrupted() {
      const result = db
        .prepare(
          `UPDATE scheduled_scan_reports SET status = 'incomplete', completed_at = ?, judgment = ? WHERE status = 'collecting'`,
        )
        .run(
          new Date().toISOString(),
          JSON.stringify({
            status: 'unavailable',
            text: 'Collection interrupted before a durable completion receipt; findings are not a clean result.',
          }),
        );
      db.prepare(
        `UPDATE scheduled_scan_reports SET judgment = ? WHERE json_valid(judgment) AND json_extract(judgment, '$.status') = 'pending'`,
      ).run(
        JSON.stringify({
          status: 'unavailable',
          text: 'Judgment interrupted; deterministic evidence and triage remain available.',
        }),
      );
      return result.changes;
    },
    triage: db.transaction((input: Omit<ScanTriageDecision, 'id' | 'createdAt'>) => {
      if (
        input.actor.type !== 'human' ||
        !input.actor.userId ||
        !input.reason.trim() ||
        input.reason.length > 4000 ||
        !input.requestKey ||
        input.requestKey.length > 200
      )
        throw new AutopodError(
          'Human identity, request key and reason are required for triage',
          'INVALID_INPUT',
          400,
        );
      const ids = [...new Set(input.findingIds)].sort();
      if (!ids.length || ids.length > 100)
        throw new AutopodError('Select 1 to 100 findings', 'INVALID_INPUT', 400);
      const previous = db
        .prepare(
          `SELECT ${scanDecisionProjection} FROM scheduled_scan_triage t WHERE t.request_key = ?`,
        )
        .get(input.requestKey) as Record<string, unknown> | undefined;
      if (previous) {
        const recorded = decision(previous);
        if (
          recorded.reportId !== input.reportId ||
          recorded.action !== input.action ||
          JSON.stringify(recorded.findingIds) !== JSON.stringify(ids) ||
          JSON.stringify(recorded.actor) !== JSON.stringify(input.actor) ||
          recorded.reason !== input.reason
        )
          throw new AutopodError(
            'Triage request key already records a different decision',
            'CONFLICT',
            409,
          );
        return recorded;
      }
      const allowed = new Set(selectedUnresolved(input.reportId, ids).map((finding) => finding.id));
      if (ids.some((id) => !allowed.has(id)))
        throw new AutopodError(
          'Selected finding is not unresolved in this job',
          'INVALID_INPUT',
          400,
        );
      const record: ScanTriageDecision = {
        ...input,
        findingIds: ids,
        id: randomUUID(),
        createdAt: new Date().toISOString(),
      };
      db.prepare(
        'INSERT INTO scheduled_scan_triage (id, request_key, report_id, finding_ids, action, actor, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        record.id,
        record.requestKey,
        record.reportId,
        JSON.stringify(ids),
        record.action,
        JSON.stringify(record.actor),
        record.reason,
        record.createdAt,
      );
      if (record.action !== 'select_repair')
        for (const id of ids)
          db.prepare('UPDATE scheduled_scan_findings SET disposition = ? WHERE id = ?').run(
            record.action === 'resolve' ? 'resolved' : 'deferred',
            id,
          );
      return record;
    }),
    launchRepair: db.transaction(
      (selectionId: string, create: (decision: ScanTriageDecision) => string) => {
        const row = db
          .prepare(`SELECT ${scanDecisionProjection} FROM scheduled_scan_triage t WHERE t.id = ?`)
          .get(selectionId) as Record<string, unknown> | undefined;
        if (!row || row.action !== 'select_repair')
          throw new AutopodError(
            'A recorded human repair selection is required',
            'INVALID_STATE',
            409,
          );
        const existing = db
          .prepare('SELECT pod_id FROM scheduled_scan_repairs WHERE selection_id = ?')
          .get(selectionId) as { pod_id: string } | undefined;
        if (existing) return existing.pod_id;
        // createSession is synchronous on this SQLite connection. The pod and
        // dispatch receipt commit together; selection survives a failed launch.
        const podId = create(decision(row));
        if (!db.prepare('SELECT id FROM pods WHERE id = ?').get(podId))
          throw new Error('Repair pod was not durably created on this database');
        db.prepare(
          'INSERT INTO scheduled_scan_repairs (selection_id, pod_id, created_at) VALUES (?, ?, ?)',
        ).run(selectionId, podId, new Date().toISOString());
        return podId;
      },
    ),
  };
}
