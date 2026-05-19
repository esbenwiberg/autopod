/**
 * Safety analytics aggregator.
 * Pure function: takes a SQLite handle + safety-events repo, returns SafetyAnalyticsResponse.
 *
 * Data sources:
 *   safety_events          — guardrail-fire rows (PII + injection)
 *   action_audit           — quarantine scores + pii_categories (Phase 4 forward)
 *   pods                   — network_policy_resolved (terminal cohort)
 *   audit_chain_verifications — latest fleet-wide hash-chain verification result
 */
import { createHash } from 'node:crypto';
import type {
  NetworkPolicyBucket,
  SafetyAnalyticsResponse,
  SafetyEventKind,
  SafetyEventSource,
} from '@autopod/shared';
import type Database from 'better-sqlite3';
import type { SafetyEventsRepository } from '../safety/safety-events-repository.js';

// ── Quarantine histogram ───────────────────────────────────────────────────────

const HISTOGRAM_BUCKET_LABELS = [
  '0.0–0.1',
  '0.1–0.2',
  '0.2–0.3',
  '0.3–0.4',
  '0.4–0.5',
  '0.5–0.6',
  '0.6–0.7',
  '0.7–0.8',
  '0.8–0.9',
  '0.9–1.0',
];

function scoreToHistogramIndex(score: number): number {
  if (score >= 1.0) return 9;
  return Math.min(9, Math.floor(score * 10));
}

function toFirstMismatch(
  podId: string | null,
  rowId: number | null,
  reason: string | null,
): { podId: string; rowId: number; reason: string } | null {
  return podId !== null && rowId !== null && reason !== null ? { podId, rowId, reason } : null;
}

// ── Network policy buckets ─────────────────────────────────────────────────────

const NETWORK_POLICY_BUCKETS: NetworkPolicyBucket[] = [
  'allow-all',
  'restricted',
  'deny-all',
  'unknown',
];

// ── Audit chain fleet verifier ─────────────────────────────────────────────────

function computeEntryHash(
  prevHash: string | null,
  podId: string,
  actionName: string,
  paramsJson: string,
  responseSummary: string | null,
  quarantineScore: number,
  createdAt: string,
): string {
  return createHash('sha256')
    .update(
      `${prevHash ?? ''}|${podId}|${actionName}|${paramsJson}|${responseSummary ?? ''}|${quarantineScore}|${createdAt}`,
    )
    .digest('hex');
}

interface AuditRow {
  id: number;
  pod_id: string;
  action_name: string;
  params: string;
  response_summary: string | null;
  quarantine_score: number;
  created_at: string;
  prev_hash: string | null;
  entry_hash: string | null;
}

interface FleetVerifyResult {
  valid: boolean;
  totalPods: number;
  totalEntries: number;
  firstMismatchPodId: string | null;
  firstMismatchRowId: number | null;
  firstMismatchReason: string | null;
}

function verifyFleetAuditChain(db: Database.Database): FleetVerifyResult {
  const podIds = db
    .prepare('SELECT DISTINCT pod_id FROM action_audit WHERE entry_hash IS NOT NULL')
    .all() as Array<{ pod_id: string }>;

  let totalEntries = 0;
  for (const { pod_id } of podIds) {
    const rows = db
      .prepare(
        'SELECT id, pod_id, action_name, params, response_summary, quarantine_score, created_at, prev_hash, entry_hash FROM action_audit WHERE pod_id = @podId AND entry_hash IS NOT NULL ORDER BY id ASC',
      )
      .all({ podId: pod_id }) as AuditRow[];

    totalEntries += rows.length;
    let runningPrevHash: string | null = null;

    for (const row of rows) {
      const expected = computeEntryHash(
        row.prev_hash,
        row.pod_id,
        row.action_name,
        row.params,
        row.response_summary,
        row.quarantine_score,
        row.created_at,
      );
      if (expected !== row.entry_hash) {
        return {
          valid: false,
          totalPods: podIds.length,
          totalEntries,
          firstMismatchPodId: row.pod_id,
          firstMismatchRowId: row.id,
          firstMismatchReason: `entry_hash mismatch for row id=${row.id}`,
        };
      }
      if (runningPrevHash !== null && row.prev_hash !== runningPrevHash) {
        return {
          valid: false,
          totalPods: podIds.length,
          totalEntries,
          firstMismatchPodId: row.pod_id,
          firstMismatchRowId: row.id,
          firstMismatchReason: `prev_hash broken chain at row id=${row.id}`,
        };
      }
      runningPrevHash = row.entry_hash;
    }
  }

  return {
    valid: true,
    totalPods: podIds.length,
    totalEntries,
    firstMismatchPodId: null,
    firstMismatchRowId: null,
    firstMismatchReason: null,
  };
}

// ── Main export ───────────────────────────────────────────────────────────────

export function computeSafetyAnalytics(
  db: Database.Database,
  safetyEventsRepo: SafetyEventsRepository,
  days: number,
): SafetyAnalyticsResponse {
  const cutoff = `datetime('now', '-' || ${days} || ' days')`;

  // ── Summary: totalEvents, byKind ─────────────────────────────────────────────
  const byKind = safetyEventsRepo.countByKindInWindow(days);
  const totalEvents = byKind.pii + byKind.injection;

  // ── Summary: sparkline ───────────────────────────────────────────────────────
  const sparkline = safetyEventsRepo.sparkline(days);

  // ── Summary: deltaVsPrior ───────────────────────────────────────────────────
  const priorRow = db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM safety_events
       WHERE created_at >= datetime('now', '-' || @priorDays || ' days')
         AND created_at <  datetime('now', '-' || @days || ' days')`,
    )
    .get({ priorDays: days * 2, days }) as { cnt: number };

  const deltaValue = totalEvents - priorRow.cnt;
  const deltaDirection: 'up' | 'down' | 'flat' =
    deltaValue > 0 ? 'up' : deltaValue < 0 ? 'down' : 'flat';

  // ── Summary: quarantine counts ───────────────────────────────────────────────
  const quarantineRow = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         COALESCE(SUM(CASE WHEN quarantine_score >= 0.7 THEN 1 ELSE 0 END), 0) AS high_risk
       FROM action_audit
       WHERE quarantine_score > 0
         AND created_at >= datetime('now', '-' || @days || ' days')`,
    )
    .get({ days }) as { total: number; high_risk: number };

  // ── byPattern ────────────────────────────────────────────────────────────────
  // Injection patterns: exclusively from safety_events
  // PII patterns: safety_events kind='pii' + action_audit.pii_categories (Phase 4+)
  const safetyPatternRows = safetyEventsRepo.countByPatternInWindow(days);

  // Merge action_audit pii_categories into pattern map
  const piiPatternMap = new Map<string, number>();
  // Seed from safety_events
  for (const row of safetyPatternRows) {
    if (row.kind === 'pii') {
      piiPatternMap.set(row.patternName, (piiPatternMap.get(row.patternName) ?? 0) + row.count);
    }
  }

  // Add from action_audit.pii_categories (JSON array of pattern names)
  const piiCatRows = db
    .prepare(
      `SELECT pii_categories, pii_detected FROM action_audit
       WHERE created_at >= datetime('now', '-' || @days || ' days')
         AND pii_detected = 1`,
    )
    .all({ days }) as Array<{ pii_categories: string | null; pii_detected: number }>;

  for (const row of piiCatRows) {
    if (row.pii_categories) {
      const cats = JSON.parse(row.pii_categories) as string[];
      for (const cat of cats) {
        piiPatternMap.set(cat, (piiPatternMap.get(cat) ?? 0) + 1);
      }
    } else {
      // Pre-Phase-4 row: pii_detected=1 but no categories → 'unknown'
      piiPatternMap.set('unknown', (piiPatternMap.get('unknown') ?? 0) + 1);
    }
  }

  const byPattern: SafetyAnalyticsResponse['byPattern'] = [
    // PII patterns from merged map
    ...Array.from(piiPatternMap.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([patternName, count]) => ({ kind: 'pii' as SafetyEventKind, patternName, count })),
    // Injection patterns from safety_events only
    ...safetyPatternRows
      .filter((r) => r.kind === 'injection')
      .map((r) => ({
        kind: 'injection' as SafetyEventKind,
        patternName: r.patternName,
        count: r.count,
      })),
  ];

  // ── bySource ────────────────────────────────────────────────────────────────
  const bySource: SafetyAnalyticsResponse['bySource'] = safetyEventsRepo
    .countBySourceInWindow(days)
    .map((r) => ({ source: r.source as SafetyEventSource, count: r.count }));

  // ── quarantineHistogram ──────────────────────────────────────────────────────
  const quarantineScoreRows = db
    .prepare(
      `SELECT quarantine_score FROM action_audit
       WHERE quarantine_score > 0
         AND created_at >= datetime('now', '-' || @days || ' days')`,
    )
    .all({ days }) as Array<{ quarantine_score: number }>;

  const histBuckets = new Array<number>(10).fill(0);
  for (const { quarantine_score } of quarantineScoreRows) {
    const idx = scoreToHistogramIndex(quarantine_score);
    histBuckets[idx] = (histBuckets[idx] ?? 0) + 1;
  }
  const quarantineHistogram = HISTOGRAM_BUCKET_LABELS.map((bucket, i) => ({
    bucket,
    count: histBuckets[i] ?? 0,
  }));

  // ── byPod ────────────────────────────────────────────────────────────────────
  const podEntries = safetyEventsRepo.countByPodInWindow(days, 50);
  const podIds = podEntries.map((e) => e.podId).filter((id) => id !== null) as string[];

  // Batch-fetch profile names for the real pod IDs
  const profileMap = new Map<string, string>();
  if (podIds.length > 0) {
    const placeholders = podIds.map(() => '?').join(', ');
    const profileRows = db
      .prepare(`SELECT id, profile_name FROM pods WHERE id IN (${placeholders})`)
      .all(...podIds) as Array<{ id: string; profile_name: string }>;
    for (const r of profileRows) {
      profileMap.set(r.id, r.profile_name);
    }
  }

  const byPod: SafetyAnalyticsResponse['byPod'] = podEntries.map((entry) => {
    const topInjections = safetyEventsRepo.topInjectionsForPod(entry.podId, 5).map((inj) => ({
      patternName: inj.patternName,
      severity: inj.severity,
      payloadExcerpt: inj.payloadExcerpt ?? '',
      createdAt: inj.createdAt,
    }));
    return {
      podId: entry.podId ?? '__pre_creation__',
      profile: entry.podId !== null ? (profileMap.get(entry.podId) ?? null) : null,
      eventCount: entry.eventCount,
      lastEventAt: entry.lastEventAt,
      topInjections,
    };
  });

  // ── networkPolicy ─────────────────────────────────────────────────────────────
  const netPolicyRows = db
    .prepare(
      `SELECT
         COALESCE(network_policy_resolved, 'unknown') AS bucket,
         COUNT(*) AS count
       FROM pods
       WHERE output_mode != 'workspace'
         AND status IN ('complete', 'killed', 'failed')
         AND completed_at >= ${cutoff}
       GROUP BY bucket`,
    )
    .all() as Array<{ bucket: string; count: number }>;

  const netPolicyMap = new Map<string, number>(netPolicyRows.map((r) => [r.bucket, r.count]));
  const networkPolicy: SafetyAnalyticsResponse['networkPolicy'] = NETWORK_POLICY_BUCKETS.map(
    (bucket) => ({ bucket, count: netPolicyMap.get(bucket) ?? 0 }),
  );

  // ── auditChain ───────────────────────────────────────────────────────────────
  const latestVerif = db
    .prepare(
      `SELECT ran_at, valid, total_pods, total_entries,
              first_mismatch_pod_id, first_mismatch_row_id, first_mismatch_reason
       FROM audit_chain_verifications ORDER BY id DESC LIMIT 1`,
    )
    .get() as
    | {
        ran_at: string;
        valid: number;
        total_pods: number;
        total_entries: number;
        first_mismatch_pod_id: string | null;
        first_mismatch_row_id: number | null;
        first_mismatch_reason: string | null;
      }
    | undefined;

  const auditChain: SafetyAnalyticsResponse['auditChain'] = latestVerif
    ? {
        lastVerifiedAt: latestVerif.ran_at,
        valid: latestVerif.valid === 1,
        totalPods: latestVerif.total_pods,
        totalEntries: latestVerif.total_entries,
        firstMismatch: toFirstMismatch(
          latestVerif.first_mismatch_pod_id,
          latestVerif.first_mismatch_row_id,
          latestVerif.first_mismatch_reason,
        ),
      }
    : {
        lastVerifiedAt: null,
        valid: null,
        totalPods: null,
        totalEntries: null,
        firstMismatch: null,
      };

  return {
    summary: {
      totalEvents,
      byKind,
      quarantineCount: quarantineRow.total,
      quarantineHighRiskCount: quarantineRow.high_risk,
      sparkline,
      deltaVsPrior: { value: deltaValue, direction: deltaDirection },
    },
    byPattern,
    bySource,
    quarantineHistogram,
    byPod,
    networkPolicy,
    auditChain,
  };
}

// ── Fleet audit-chain verify (for POST /audit-chain/verify) ───────────────────

export interface AuditChainVerifyResult {
  valid: boolean;
  totalPods: number;
  totalEntries: number;
  firstMismatch: { podId: string; rowId: number; reason: string } | null;
  ranAt: string;
}

export function runAndPersistAuditChainVerification(db: Database.Database): AuditChainVerifyResult {
  const result = verifyFleetAuditChain(db);
  const ranAt = new Date().toISOString();

  db.prepare(
    `INSERT INTO audit_chain_verifications
       (ran_at, total_pods, total_entries, valid,
        first_mismatch_pod_id, first_mismatch_row_id, first_mismatch_reason)
     VALUES (@ranAt, @totalPods, @totalEntries, @valid,
             @firstMismatchPodId, @firstMismatchRowId, @firstMismatchReason)`,
  ).run({
    ranAt,
    totalPods: result.totalPods,
    totalEntries: result.totalEntries,
    valid: result.valid ? 1 : 0,
    firstMismatchPodId: result.firstMismatchPodId,
    firstMismatchRowId: result.firstMismatchRowId,
    firstMismatchReason: result.firstMismatchReason,
  });

  return {
    valid: result.valid,
    totalPods: result.totalPods,
    totalEntries: result.totalEntries,
    firstMismatch: toFirstMismatch(
      result.firstMismatchPodId,
      result.firstMismatchRowId,
      result.firstMismatchReason,
    ),
    ranAt,
  };
}
