import type { SafetyEventKind, SafetyEventSource } from '@autopod/shared';
import type Database from 'better-sqlite3';

export interface SafetyEventInsert {
  podId: string | null;
  source: SafetyEventSource;
  kind: SafetyEventKind;
  patternName: string;
  severity: number | null;
  payloadExcerpt: string | null;
}

export interface SafetyEventsRepository {
  /** Insert one safety event row; returns the inserted row id. */
  insert(entry: SafetyEventInsert): number;
  /** Backfill pod_id once the pod is created (issue-watcher pattern). */
  attachPodId(rowIds: number[], podId: string): void;
  countByKindInWindow(days: number): { pii: number; injection: number };
  countByPatternInWindow(
    days: number,
  ): Array<{ kind: SafetyEventKind; patternName: string; count: number }>;
  countBySourceInWindow(days: number): Array<{ source: SafetyEventSource; count: number }>;
  /** NULL pod_id rows are returned with podId: null; Brief 05 aggregator maps them to __pre_creation__. */
  countByPodInWindow(
    days: number,
    limit: number,
  ): Array<{ podId: string | null; eventCount: number; lastEventAt: string }>;
  topInjectionsForPod(
    podId: string | null,
    limit: number,
  ): Array<{
    patternName: string;
    severity: number | null;
    payloadExcerpt: string | null;
    createdAt: string;
  }>;
  /** Returns exactly `days` entries (including zero-count days). */
  sparkline(days: number): Array<{ day: string; count: number }>;
}

const CUTOFF_EXPR = "datetime('now', '-' || ? || ' days')";

export function createSafetyEventsRepository(db: Database.Database): SafetyEventsRepository {
  return {
    insert(entry: SafetyEventInsert): number {
      const result = db
        .prepare(
          `INSERT INTO safety_events (pod_id, source, kind, pattern_name, severity, payload_excerpt)
           VALUES (@podId, @source, @kind, @patternName, @severity, @payloadExcerpt)`,
        )
        .run({
          podId: entry.podId,
          source: entry.source,
          kind: entry.kind,
          patternName: entry.patternName,
          severity: entry.severity,
          payloadExcerpt: entry.payloadExcerpt,
        });
      return Number(result.lastInsertRowid);
    },

    attachPodId(rowIds: number[], podId: string): void {
      if (rowIds.length === 0) return;
      const placeholders = rowIds.map(() => '?').join(', ');
      db.prepare(`UPDATE safety_events SET pod_id = ? WHERE id IN (${placeholders})`).run(
        podId,
        ...rowIds,
      );
    },

    countByKindInWindow(days: number): { pii: number; injection: number } {
      const rows = db
        .prepare(
          `SELECT kind, COUNT(*) AS cnt FROM safety_events
           WHERE created_at >= ${CUTOFF_EXPR}
           GROUP BY kind`,
        )
        .all(days) as Array<{ kind: string; cnt: number }>;

      let pii = 0;
      let injection = 0;
      for (const row of rows) {
        if (row.kind === 'pii') pii = row.cnt;
        else if (row.kind === 'injection') injection = row.cnt;
      }
      return { pii, injection };
    },

    countByPatternInWindow(
      days: number,
    ): Array<{ kind: SafetyEventKind; patternName: string; count: number }> {
      const rows = db
        .prepare(
          `SELECT kind, pattern_name, COUNT(*) AS cnt FROM safety_events
           WHERE created_at >= ${CUTOFF_EXPR}
           GROUP BY kind, pattern_name
           ORDER BY cnt DESC`,
        )
        .all(days) as Array<{ kind: string; pattern_name: string; cnt: number }>;

      return rows.map((r) => ({
        kind: r.kind as SafetyEventKind,
        patternName: r.pattern_name,
        count: r.cnt,
      }));
    },

    countBySourceInWindow(days: number): Array<{ source: SafetyEventSource; count: number }> {
      const rows = db
        .prepare(
          `SELECT source, COUNT(*) AS cnt FROM safety_events
           WHERE created_at >= ${CUTOFF_EXPR}
           GROUP BY source
           ORDER BY cnt DESC`,
        )
        .all(days) as Array<{ source: string; cnt: number }>;

      return rows.map((r) => ({ source: r.source as SafetyEventSource, count: r.cnt }));
    },

    countByPodInWindow(
      days: number,
      limit: number,
    ): Array<{ podId: string | null; eventCount: number; lastEventAt: string }> {
      const rows = db
        .prepare(
          `SELECT pod_id, COUNT(*) AS event_count, MAX(created_at) AS last_event_at
           FROM safety_events
           WHERE created_at >= ${CUTOFF_EXPR}
           GROUP BY pod_id
           ORDER BY last_event_at DESC
           LIMIT ?`,
        )
        .all(days, limit) as Array<{
        pod_id: string | null;
        event_count: number;
        last_event_at: string;
      }>;

      return rows.map((r) => ({
        podId: r.pod_id,
        eventCount: r.event_count,
        lastEventAt: r.last_event_at,
      }));
    },

    topInjectionsForPod(
      podId: string | null,
      limit: number,
    ): Array<{
      patternName: string;
      severity: number | null;
      payloadExcerpt: string | null;
      createdAt: string;
    }> {
      // SQLite IS operator handles NULL equality: `pod_id IS NULL` when podId=null
      const rows = db
        .prepare(
          `SELECT pattern_name, severity, payload_excerpt, created_at
           FROM safety_events
           WHERE kind = 'injection' AND pod_id IS ?
           ORDER BY created_at DESC
           LIMIT ?`,
        )
        .all(podId, limit) as Array<{
        pattern_name: string;
        severity: number | null;
        payload_excerpt: string | null;
        created_at: string;
      }>;

      return rows.map((r) => ({
        patternName: r.pattern_name,
        severity: r.severity,
        payloadExcerpt: r.payload_excerpt,
        createdAt: r.created_at,
      }));
    },

    sparkline(days: number): Array<{ day: string; count: number }> {
      const rows = db
        .prepare(
          `SELECT date(created_at) AS day, COUNT(*) AS cnt
           FROM safety_events
           WHERE created_at >= ${CUTOFF_EXPR}
           GROUP BY date(created_at)`,
        )
        .all(days) as Array<{ day: string; cnt: number }>;

      const countMap = new Map<string, number>(rows.map((r) => [r.day, r.cnt]));

      const result: Array<{ day: string; count: number }> = [];
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date();
        d.setUTCDate(d.getUTCDate() - i);
        const day = d.toISOString().slice(0, 10);
        result.push({ day, count: countMap.get(day) ?? 0 });
      }
      return result;
    },
  };
}
