import type {
  Pod,
  ReadinessArea,
  ReadinessAreaReview,
  ReadinessAreaStatus,
  ReadinessFinding,
  ReadinessReview,
  ReadinessSourceRef,
  ReadinessStatus,
  ValidationResult,
} from '@autopod/shared';
import type { ActionAuditRepository } from '../actions/audit-repository.js';
import type { ScanRepository, StoredScan } from '../security/scan-repository.js';
import type { EventRepository } from './event-repository.js';
import type { PodRepository } from './pod-repository.js';
import type { QualityScoreRepository } from './quality-score-repository.js';
import type { ValidationRepository } from './validation-repository.js';

const READINESS_STATUSES: ReadinessStatus[] = ['ready', 'needs_review', 'waived', 'risky'];
const AREA_TITLES: Record<ReadinessArea, string> = {
  validation: 'Validation',
  security: 'Security',
  actions: 'Actions',
  network: 'Network',
  scope: 'Scope',
  quality: 'Quality',
  advisory_qa: 'Advisory QA',
  pr: 'PR',
};

const SOURCE_REFS = {
  validation: [{ kind: 'validation', label: 'Validation' }] satisfies ReadinessSourceRef[],
  security: [{ kind: 'evidence', label: 'Security scan' }] satisfies ReadinessSourceRef[],
  actions: [{ kind: 'evidence', label: 'Action audit' }] satisfies ReadinessSourceRef[],
  event: [{ kind: 'event', label: 'Pod events' }] satisfies ReadinessSourceRef[],
  quality: [{ kind: 'quality', label: 'Quality score' }] satisfies ReadinessSourceRef[],
  pr: [{ kind: 'pr', label: 'Pull request' }] satisfies ReadinessSourceRef[],
  work: [{ kind: 'work', label: 'Worktree' }] satisfies ReadinessSourceRef[],
};

type FindingInput = Omit<ReadinessFinding, 'sourceRefs'> & {
  sourceRefs?: ReadinessSourceRef[];
};

export interface ReadinessInputs {
  pod: Pod;
  latestValidation: ValidationResult | null;
  latestSecurityScan?: StoredScan | null;
  actionAudit?: {
    valid: boolean;
    rowCount: number;
    reason?: string;
    quarantineCount: number;
    piiCount: number;
    piiCategories: string[];
    maxQuarantineScore: number;
  };
  deniedEgressCount?: number;
  preflightOverlapCount?: number;
  qualityScore?: number | null;
  advisoryQaInFlight?: boolean;
  computedAt?: string;
}

export interface SeriesReadinessReview {
  status: ReadinessStatus;
  summary: string;
  computedAt: string;
  scope: 'series';
  seriesId: string;
  memberCount: number;
  memberStatuses: Array<{
    podId: string;
    status: ReadinessStatus | 'not_available';
    summary: string;
  }>;
  findings: ReadinessFinding[];
}

export interface ReadinessService {
  computePodReadiness(podId: string, options?: { advisoryQaInFlight?: boolean }): ReadinessReview;
  refreshPodReadiness(podId: string, options?: { advisoryQaInFlight?: boolean }): ReadinessReview;
  computeSeriesReadiness(seriesId: string): SeriesReadinessReview;
}

export interface ReadinessServiceDeps {
  podRepo: PodRepository;
  validationRepo?: ValidationRepository;
  scanRepo?: ScanRepository;
  actionAuditRepo?: ActionAuditRepository;
  eventRepo?: EventRepository;
  qualityScoreRepo?: QualityScoreRepository;
}

export function createReadinessService(deps: ReadinessServiceDeps): ReadinessService {
  const computePodReadiness = (
    podId: string,
    options: { advisoryQaInFlight?: boolean } = {},
  ): ReadinessReview => {
    const pod = deps.podRepo.getOrThrow(podId);
    const validations = deps.validationRepo?.getForSession(podId) ?? [];
    const latestValidation =
      validations[validations.length - 1]?.result ?? pod.lastValidationResult;
    const audit = deps.actionAuditRepo?.verifyAuditChain(podId);
    const actionSafety = deps.actionAuditRepo?.getSafetySummary(podId);
    return deriveReadinessReview({
      pod,
      latestValidation,
      latestSecurityScan: deps.scanRepo?.getLatestForPod(podId, 'push') ?? null,
      actionAudit: audit
        ? {
            valid: audit.valid,
            rowCount: audit.rowCount,
            reason: audit.reason,
            quarantineCount: actionSafety?.quarantineCount ?? 0,
            piiCount: actionSafety?.piiCount ?? 0,
            piiCategories: actionSafety?.piiCategories ?? [],
            maxQuarantineScore: actionSafety?.maxQuarantineScore ?? 0,
          }
        : undefined,
      deniedEgressCount: deps.eventRepo?.countForSession(podId, 'pod.firewall_denied') ?? 0,
      preflightOverlapCount: deps.eventRepo?.countForSession(podId, 'pod.preflight_overlap') ?? 0,
      qualityScore: deps.qualityScoreRepo?.get(podId)?.score ?? null,
      advisoryQaInFlight: options.advisoryQaInFlight,
    });
  };

  return {
    computePodReadiness,

    refreshPodReadiness(podId, options = {}) {
      const review = computePodReadiness(podId, options);
      deps.podRepo.update(podId, { readinessReview: review });
      return review;
    },

    computeSeriesReadiness(seriesId: string): SeriesReadinessReview {
      return deriveSeriesReadiness(seriesId, deps.podRepo.getPodsBySeries(seriesId));
    },
  };
}

export function deriveReadinessReview(inputs: ReadinessInputs): ReadinessReview {
  const computedAt = inputs.computedAt ?? new Date().toISOString();
  const areas = [
    validationArea(inputs),
    securityArea(inputs),
    actionsArea(inputs),
    networkArea(inputs),
    scopeArea(inputs),
    qualityArea(inputs),
    advisoryQaArea(inputs),
    prArea(inputs),
  ];
  const findings = areas.flatMap(({ findings: areaFindings }) => areaFindings);
  const status = deriveTopStatus(
    areas.map(({ area }) => area.status),
    findings,
  );

  return {
    status,
    summary: summarizePodReadiness(status, findings),
    computedAt,
    scope: 'pod',
    areas: areas.map(({ area }) => area),
    findings,
    approval: inputs.pod.readinessReview?.approval ?? null,
  };
}

export function deriveSeriesReadiness(
  seriesId: string,
  pods: Pod[],
  computedAt = new Date().toISOString(),
): SeriesReadinessReview {
  const findings: ReadinessFinding[] = [];
  const statuses: ReadinessStatus[] = [];

  for (const pod of pods) {
    if (!pod.readinessReview) {
      findings.push({
        id: `series:${seriesId}:missing:${pod.id}`,
        area: 'quality',
        severity: 'warning',
        title: 'Member readiness unavailable',
        detail: `Pod ${pod.id} has no Readiness Review snapshot.`,
        sourceRefs: SOURCE_REFS.work,
      });
      continue;
    }
    statuses.push(pod.readinessReview.status);
    findings.push(
      ...pod.readinessReview.findings.map((finding) => ({
        ...finding,
        id: `series:${seriesId}:${pod.id}:${finding.id}`,
        title: `${pod.id}: ${finding.title}`,
      })),
    );
  }

  const status = worstSeriesStatus(statuses, findings);
  const affectedPods = new Set(
    findings
      .map((finding) => finding.id.split(':')[2])
      .filter((podId): podId is string => typeof podId === 'string' && podId.length > 0),
  );

  return {
    status,
    summary:
      findings.length === 0
        ? `${pods.length} member pod(s) are ready.`
        : `${findings.length} finding(s) across ${affectedPods.size} of ${pods.length} pod(s).`,
    computedAt,
    scope: 'series',
    seriesId,
    memberCount: pods.length,
    memberStatuses: pods.map((pod) => ({
      podId: pod.id,
      status: pod.readinessReview?.status ?? 'not_available',
      summary: pod.readinessReview?.summary ?? 'Readiness unavailable.',
    })),
    findings,
  };
}

function validationArea(inputs: ReadinessInputs): {
  area: ReadinessAreaReview;
  findings: ReadinessFinding[];
} {
  const { pod, latestValidation } = inputs;
  const refs = SOURCE_REFS.validation;
  if (pod.validationWaiver || pod.lastCorrectionMessage?.startsWith('[FORCE APPROVED]')) {
    return area('validation', 'waived', 'Validation was waived by an operator.', [
      finding({
        id: 'validation-waiver',
        area: 'validation',
        severity: 'warning',
        title: 'Validation waiver recorded',
        detail: pod.validationWaiver?.reason || 'Validation proof was bypassed by force approval.',
        sourceRefs: refs,
      }),
    ]);
  }
  if (pod.skipValidation) {
    return area('validation', 'waived', 'Validation was skipped.', [
      finding({
        id: 'validation-skipped',
        area: 'validation',
        severity: 'warning',
        title: 'Validation skipped',
        detail: 'The pod was configured to bypass normal validation proof.',
        sourceRefs: refs,
      }),
    ]);
  }
  if (!latestValidation) {
    return area('validation', 'risky', 'No blocking validation result is available.', [
      finding({
        id: 'validation-unknown',
        area: 'validation',
        severity: 'error',
        title: 'Blocking validation unknown',
        detail: 'The pod reached a decision state without a stored validation result.',
        sourceRefs: refs,
      }),
    ]);
  }
  if (latestValidation.overall !== 'pass') {
    return area('validation', 'risky', 'Blocking validation failed.', [
      finding({
        id: 'validation-failed',
        area: 'validation',
        severity: 'error',
        title: 'Blocking validation failed',
        detail: 'Latest validation overall status is fail.',
        sourceRefs: refs,
      }),
    ]);
  }
  return area('validation', 'ready', 'Blocking validation passed.', []);
}

function securityArea(inputs: ReadinessInputs): {
  area: ReadinessAreaReview;
  findings: ReadinessFinding[];
} {
  const scan = inputs.latestSecurityScan;
  if (!scan) return area('security', 'not_available', 'No push security scan is available.', []);
  if (scan.decision === 'block') {
    return area('security', 'risky', 'Security scan blocked release.', [
      finding({
        id: 'security-block',
        area: 'security',
        severity: 'error',
        title: 'Security scan blocked',
        detail: `Latest scan blocked with ${scan.findings.length} finding(s).`,
        sourceRefs: SOURCE_REFS.security,
      }),
    ]);
  }
  if (scan.decision === 'warn' || scan.decision === 'escalate' || scan.scanIncomplete) {
    const title = scan.scanIncomplete ? 'Security scan incomplete' : 'Security scan warning';
    return area('security', 'needs_review', 'Security scan needs operator review.', [
      finding({
        id: scan.scanIncomplete ? 'security-scan-incomplete' : 'security-warning',
        area: 'security',
        severity: 'warning',
        title,
        detail: `Latest scan decision is ${scan.decision} with ${scan.findings.length} finding(s).`,
        sourceRefs: SOURCE_REFS.security,
      }),
    ]);
  }
  return area('security', 'ready', 'No security findings requiring review.', []);
}

function actionsArea(inputs: ReadinessInputs): {
  area: ReadinessAreaReview;
  findings: ReadinessFinding[];
} {
  const audit = inputs.actionAudit;
  if (!audit)
    return area('actions', 'not_available', 'No action audit repository is available.', []);
  if (!audit.valid) {
    return area('actions', 'risky', 'Action audit hash chain is invalid.', [
      finding({
        id: 'actions-audit-invalid',
        area: 'actions',
        severity: 'error',
        title: 'Action audit chain invalid',
        detail: audit.reason ?? 'The action audit hash chain failed verification.',
        sourceRefs: SOURCE_REFS.actions,
      }),
    ]);
  }

  const findings: ReadinessFinding[] = [];
  if (audit.quarantineCount > 0) {
    findings.push(
      finding({
        id: 'actions-quarantine',
        area: 'actions',
        severity: 'warning',
        title: 'Action quarantine signal',
        detail: `${audit.quarantineCount} action audit row(s) recorded quarantine score above zero.`,
        sourceRefs: SOURCE_REFS.actions,
      }),
    );
  }
  if (audit.piiCount > 0 || audit.piiCategories.length > 0) {
    findings.push(
      finding({
        id: 'actions-pii',
        area: 'actions',
        severity: 'warning',
        title: 'Action PII signal',
        detail:
          audit.piiCategories.length > 0
            ? `PII categories detected: ${audit.piiCategories.join(', ')}.`
            : `${audit.piiCount} action audit row(s) detected PII.`,
        sourceRefs: SOURCE_REFS.actions,
      }),
    );
  }

  return area(
    'actions',
    findings.length > 0 ? 'needs_review' : 'ready',
    findings.length > 0
      ? 'Action audit includes safety signals.'
      : `Action audit chain valid (${audit.rowCount} row(s)).`,
    findings,
  );
}

function networkArea(inputs: ReadinessInputs): {
  area: ReadinessAreaReview;
  findings: ReadinessFinding[];
} {
  const count = inputs.deniedEgressCount ?? 0;
  if (count === 0) return area('network', 'ready', 'No denied egress events recorded.', []);
  return area('network', 'needs_review', `${count} denied egress event(s) recorded.`, [
    finding({
      id: 'network-denied-egress',
      area: 'network',
      severity: 'warning',
      title: 'Denied egress observed',
      detail: `The pod recorded ${count} outbound connection attempt(s) blocked by policy.`,
      sourceRefs: SOURCE_REFS.event,
    }),
  ]);
}

function scopeArea(inputs: ReadinessInputs): {
  area: ReadinessAreaReview;
  findings: ReadinessFinding[];
} {
  if (inputs.pod.worktreeCompromised) {
    return area('scope', 'risky', 'Worktree is marked compromised.', [
      finding({
        id: 'scope-worktree-compromised',
        area: 'scope',
        severity: 'error',
        title: 'Worktree compromised',
        detail: 'The daemon marked the worktree as compromised by a deletion/sync safety guard.',
        sourceRefs: SOURCE_REFS.work,
      }),
    ]);
  }
  const overlapCount = inputs.preflightOverlapCount ?? 0;
  if (overlapCount > 0) {
    return area('scope', 'needs_review', `${overlapCount} preflight overlap event(s).`, [
      finding({
        id: 'scope-preflight-overlap',
        area: 'scope',
        severity: 'warning',
        title: 'Scope overlap observed',
        detail: 'The pod overlapped another in-flight pod scope at creation time.',
        sourceRefs: SOURCE_REFS.event,
      }),
    ]);
  }
  return area('scope', 'ready', 'No scope drift signals recorded.', []);
}

function qualityArea(inputs: ReadinessInputs): {
  area: ReadinessAreaReview;
  findings: ReadinessFinding[];
} {
  const score = inputs.qualityScore;
  if (score === null || score === undefined) {
    return area('quality', 'not_available', 'No persisted quality score is available yet.', []);
  }
  if (score < 60) {
    return area('quality', 'needs_review', `Quality score is low (${score}).`, [
      finding({
        id: 'quality-low-score',
        area: 'quality',
        severity: 'warning',
        title: 'Low quality score',
        detail: `The persisted pod quality score is ${score}.`,
        sourceRefs: SOURCE_REFS.quality,
      }),
    ]);
  }
  return area('quality', 'ready', `Quality score is ${score}.`, []);
}

function advisoryQaArea(inputs: ReadinessInputs): {
  area: ReadinessAreaReview;
  findings: ReadinessFinding[];
} {
  const advisory = inputs.latestValidation?.advisoryBrowserQa;
  const refs = SOURCE_REFS.validation;
  if (inputs.advisoryQaInFlight) {
    return area('advisory_qa', 'not_available', 'Advisory browser QA is still running.', [
      finding({
        id: 'advisory-qa-in-flight',
        area: 'advisory_qa',
        severity: 'warning',
        title: 'Advisory QA in flight',
        detail: 'Advisory browser QA has not finished yet.',
        sourceRefs: refs,
      }),
    ]);
  }
  if (!advisory || advisory.status === 'skip') {
    return area('advisory_qa', 'not_applicable', 'Advisory browser QA did not run.', []);
  }
  if (advisory.status === 'pass') {
    return area('advisory_qa', 'ready', 'Advisory browser QA passed.', []);
  }
  return area('advisory_qa', 'needs_review', 'Advisory browser QA raised concerns.', [
    finding({
      id: 'advisory-qa-concern',
      area: 'advisory_qa',
      severity: 'warning',
      title: 'Advisory QA concern',
      detail: advisory.reasoning || `Advisory browser QA status is ${advisory.status}.`,
      sourceRefs: refs,
    }),
  ]);
}

function prArea(inputs: ReadinessInputs): {
  area: ReadinessAreaReview;
  findings: ReadinessFinding[];
} {
  const pod = inputs.pod;
  if (pod.mergeBlockReason) {
    return area('pr', 'risky', 'PR or merge gate is blocked.', [
      finding({
        id: 'pr-blocked',
        area: 'pr',
        severity: 'error',
        title: 'PR gate blocked',
        detail: pod.mergeBlockReason,
        sourceRefs: SOURCE_REFS.pr,
      }),
    ]);
  }
  if (!pod.prUrl && pod.options.output === 'pr') {
    return area('pr', 'not_available', 'No PR has been created yet.', []);
  }
  if (pod.options.output === 'pr') {
    return area('pr', 'ready', 'PR is available and no blocked gate is recorded.', []);
  }
  return area('pr', 'not_applicable', 'Pod output does not require a PR.', []);
}

function area(
  areaName: ReadinessArea,
  status: ReadinessAreaStatus,
  summary: string,
  findings: ReadinessFinding[],
): { area: ReadinessAreaReview; findings: ReadinessFinding[] } {
  const sourceRefs = findings.flatMap((findingItem) => findingItem.sourceRefs);
  return {
    area: {
      area: areaName,
      status,
      title: AREA_TITLES[areaName],
      summary,
      sourceRefs: dedupeRefs(sourceRefs),
    },
    findings,
  };
}

function finding(input: FindingInput): ReadinessFinding {
  return {
    ...input,
    sourceRefs: input.sourceRefs ?? [],
  };
}

function deriveTopStatus(
  areaStatuses: ReadinessAreaStatus[],
  findings: ReadinessFinding[],
): ReadinessStatus {
  if (areaStatuses.includes('risky') || findings.some((item) => item.severity === 'error')) {
    return 'risky';
  }
  if (areaStatuses.includes('waived')) return 'waived';
  if (
    areaStatuses.includes('needs_review') ||
    findings.some((item) => item.severity === 'warning')
  ) {
    return 'needs_review';
  }
  return 'ready';
}

function worstSeriesStatus(
  statuses: ReadinessStatus[],
  findings: ReadinessFinding[],
): ReadinessStatus {
  if (statuses.includes('risky')) return 'risky';
  if (statuses.includes('waived')) return 'waived';
  if (
    statuses.includes('needs_review') ||
    findings.some((findingItem) => findingItem.severity === 'warning')
  ) {
    return 'needs_review';
  }
  return statuses.length === 0 ? 'needs_review' : 'ready';
}

function summarizePodReadiness(status: ReadinessStatus, findings: ReadinessFinding[]): string {
  if (status === 'ready') return 'Ready to release.';
  if (status === 'waived') return 'Validation proof was waived.';
  if (status === 'risky') {
    const count = findings.filter((findingItem) => findingItem.severity === 'error').length;
    return `${count || findings.length} risky finding(s) require a human decision.`;
  }
  return `${findings.length} finding(s) need operator review.`;
}

function dedupeRefs(refs: ReadinessSourceRef[]): ReadinessSourceRef[] {
  const seen = new Set<string>();
  const result: ReadinessSourceRef[] = [];
  for (const ref of refs) {
    const key = `${ref.kind}:${ref.label}:${ref.id ?? ''}:${ref.href ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(ref);
  }
  return result;
}

export function readinessStatusRank(status: ReadinessStatus): number {
  return READINESS_STATUSES.indexOf(status);
}
