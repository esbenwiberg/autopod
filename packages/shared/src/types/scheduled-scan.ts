import { z } from 'zod';
import type { OperatorActor } from './podsitter.js';

const remoteBranch = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      !value.startsWith('-') &&
      !value.startsWith('/') &&
      !/[\s~^:?*\[\\]/.test(value) &&
      [...value].every(
        (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
      ) &&
      !value.includes('..') &&
      !value.includes('@{') &&
      !value.endsWith('/') &&
      !value.endsWith('.lock'),
    'Use an exact remote branch name, without revision expressions',
  );
export const scheduledScanPolicySchema = z
  .object({
    version: z.literal(1),
    baseRef: remoteBranch,
    headRef: remoteBranch,
    scanners: z
      .array(z.enum(['secrets', 'dependencies']))
      .min(1)
      .max(2)
      .refine((values) => new Set(values).size === values.length),
    judgment: z.enum(['none', 'bounded']).default('none'),
    windowHours: z.number().int().min(1).max(720).optional(),
  })
  .strict()
  .refine(
    (policy) => policy.windowHours === undefined || policy.baseRef === policy.headRef,
    'A time window uses one branch; baseRef and headRef must match',
  );
export type ScheduledScanPolicy = z.infer<typeof scheduledScanPolicySchema>;

export interface ScheduledScanFinding {
  id: string;
  scanner: 'secrets' | 'dependencies';
  ruleId: string;
  file: string;
  line?: number;
  severity: 'info' | 'low' | 'moderate' | 'high' | 'critical';
  summary: string;
}
export interface ScheduledScannerResult {
  scanner: 'secrets' | 'dependencies';
  version: string | null;
  status: 'completed' | 'not_applicable' | 'skipped_empty' | 'unavailable' | 'failed';
  diagnostic?: string;
  findingCount: number | null;
  evidenceHash?: string;
}
export interface ScheduledScanCollection {
  version: 1;
  repository: string;
  baseSha: string | null;
  headSha: string | null;
  baseKind?: 'commit' | 'empty_tree';
  window?: {
    start: string;
    end: string;
    semantics: 'first_parent_committer_time_net_delta';
    selectedCommits: string[];
  };
  files: Array<{ path: string; change: 'added' | 'modified' | 'deleted' }>;
  stacks: string[];
  scanners: ScheduledScannerResult[];
  findings: ScheduledScanFinding[];
  diagnostics: string[];
}
export interface ScheduledScanReport {
  kind: 'scan_report';
  id: string;
  jobId: string;
  status: 'collecting' | 'empty_delta' | 'complete' | 'incomplete';
  policy: ScheduledScanPolicy;
  collection: ScheduledScanCollection | null;
  judgment: {
    status: 'not_requested' | 'skipped_empty' | 'pending' | 'complete' | 'unavailable';
    text?: string;
    usage?: {
      inputTokens: number;
      outputTokens: number;
      costUsd: number | null;
      durationMs: number;
      model: string;
      provider: string;
      providerAccountId: string | null;
    };
  };
  createdAt: string;
  completedAt: string | null;
}

export interface ScanTriageDecision {
  id: string;
  requestKey: string;
  reportId: string;
  findingIds: string[];
  action: 'defer' | 'resolve' | 'select_repair';
  actor: OperatorActor;
  reason: string;
  createdAt: string;
}
export interface ScanReportDetail {
  diagnostics?: ScanRecordDiagnostic[];
  /** Present on paginated operator review responses. */
  unresolvedNextCursor?: string | null;
  decisionsNextCursor?: string | null;
  report: ScheduledScanReport;
  unresolved: Array<ScheduledScanFinding & { disposition: 'unresolved' | 'deferred' }>;
  decisions: Array<ScanTriageDecision & { repairPodId: string | null }>;
}
export type ScanTriageRequest = Pick<
  ScanTriageDecision,
  'requestKey' | 'findingIds' | 'action' | 'reason'
>;
export interface ScanRepairDispatch {
  kind: 'repair_dispatch';
  selectionId: string;
  podId: string;
}

/** Bounded history projection; detail and triage remain separate reads/actions. */
export interface ScanReportSummary {
  id: string;
  jobId: string;
  status: ScheduledScanReport['status'];
  createdAt: string;
  completedAt: string | null;
  findingCount: number | null;
  judgmentStatus: ScheduledScanReport['judgment']['status'] | null;
  diagnostics: string[];
}
export interface ScanReportPage {
  items: ScanReportSummary[];
  /** Last report identity in this page; scoped to its schedule, ordered by time then ID. */
  nextCursor: string | null;
}

/** Unreadable stored evidence is excluded from selectable items, never discarded. */
export interface ScanRecordDiagnostic {
  kind: 'finding' | 'decision';
  recordId: string;
  message: string;
}

export interface ScanFindingPage {
  diagnostics?: ScanRecordDiagnostic[];
  items: Array<ScheduledScanFinding & { disposition: 'unresolved' | 'deferred' }>;
  nextCursor: string | null;
}
export interface ScanDecisionPage {
  diagnostics?: ScanRecordDiagnostic[];
  items: Array<ScanTriageDecision & { repairPodId: string | null }>;
  nextCursor: string | null;
}
