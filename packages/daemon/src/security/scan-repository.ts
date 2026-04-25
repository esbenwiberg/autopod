import {
  type ScanCheckpoint,
  type ScanDecision,
  type ScanDetectorName,
  type ScanFinding,
  type ScanSeverity,
  generateId,
} from '@autopod/shared';
import type Database from 'better-sqlite3';

export interface StoredScan {
  id: string;
  podId: string;
  checkpoint: ScanCheckpoint;
  decision: ScanDecision;
  startedAt: number;
  completedAt: number;
  filesScanned: number;
  filesSkipped: number;
  scanIncomplete: boolean;
  findings: ScanFinding[];
}

export interface InsertScanInput {
  podId: string;
  checkpoint: ScanCheckpoint;
  decision: ScanDecision;
  startedAt: number;
  completedAt: number;
  filesScanned: number;
  filesSkipped: number;
  scanIncomplete: boolean;
  findings: ScanFinding[];
}

export interface ScanRepository {
  insert(input: InsertScanInput): StoredScan;
  getForPod(podId: string): StoredScan[];
}

export function createScanRepository(db: Database.Database): ScanRepository {
  const insertScan = db.prepare(
    `INSERT INTO security_scans (
       id, pod_id, checkpoint, decision, started_at, completed_at,
       files_scanned, files_skipped, scan_incomplete
     ) VALUES (
       @id, @podId, @checkpoint, @decision, @startedAt, @completedAt,
       @filesScanned, @filesSkipped, @scanIncomplete
     )`,
  );
  const insertFinding = db.prepare(
    `INSERT INTO security_scan_findings (
       id, scan_id, detector, severity, file, line, rule_id, confidence, snippet
     ) VALUES (
       @id, @scanId, @detector, @severity, @file, @line, @ruleId, @confidence, @snippet
     )`,
  );

  const insertAll = db.transaction((input: InsertScanInput): StoredScan => {
    const id = generateId();
    insertScan.run({
      id,
      podId: input.podId,
      checkpoint: input.checkpoint,
      decision: input.decision,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      filesScanned: input.filesScanned,
      filesSkipped: input.filesSkipped,
      scanIncomplete: input.scanIncomplete ? 1 : 0,
    });
    for (const f of input.findings) {
      insertFinding.run({
        id: generateId(),
        scanId: id,
        detector: f.detector,
        severity: f.severity,
        file: f.file,
        line: f.line ?? null,
        ruleId: f.ruleId ?? null,
        confidence: f.confidence ?? null,
        snippet: f.snippet,
      });
    }
    return {
      id,
      podId: input.podId,
      checkpoint: input.checkpoint,
      decision: input.decision,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      filesScanned: input.filesScanned,
      filesSkipped: input.filesSkipped,
      scanIncomplete: input.scanIncomplete,
      findings: input.findings,
    };
  });

  return {
    insert(input: InsertScanInput): StoredScan {
      return insertAll(input);
    },
    getForPod(podId: string): StoredScan[] {
      const scanRows = db
        .prepare('SELECT * FROM security_scans WHERE pod_id = ? ORDER BY started_at ASC')
        .all(podId) as Record<string, unknown>[];
      const findingsByScan = new Map<string, ScanFinding[]>();
      const findingRows = db
        .prepare(
          `SELECT * FROM security_scan_findings
           WHERE scan_id IN (SELECT id FROM security_scans WHERE pod_id = ?)`,
        )
        .all(podId) as Record<string, unknown>[];
      for (const row of findingRows) {
        const scanId = row.scan_id as string;
        const list = findingsByScan.get(scanId) ?? [];
        list.push(rowToFinding(row));
        findingsByScan.set(scanId, list);
      }
      return scanRows.map((row) => rowToScan(row, findingsByScan.get(row.id as string) ?? []));
    },
  };
}

function rowToScan(row: Record<string, unknown>, findings: ScanFinding[]): StoredScan {
  return {
    id: row.id as string,
    podId: row.pod_id as string,
    checkpoint: row.checkpoint as ScanCheckpoint,
    decision: row.decision as ScanDecision,
    startedAt: row.started_at as number,
    completedAt: row.completed_at as number,
    filesScanned: row.files_scanned as number,
    filesSkipped: row.files_skipped as number,
    scanIncomplete: !!row.scan_incomplete,
    findings,
  };
}

function rowToFinding(row: Record<string, unknown>): ScanFinding {
  return {
    detector: row.detector as ScanDetectorName,
    severity: row.severity as ScanSeverity,
    file: row.file as string,
    line: (row.line as number | null) ?? undefined,
    ruleId: (row.rule_id as string | null) ?? undefined,
    confidence: (row.confidence as number | null) ?? undefined,
    snippet: row.snippet as string,
  };
}
