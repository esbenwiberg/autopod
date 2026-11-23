import type {
  CheckpointPolicy,
  SavedWorkDraftPublicationScan,
  SavedWorkDraftPublicationScanFinding,
  ScanDetectorName,
  ScanOutcome,
  SecurityScanPolicy,
} from '@autopod/shared';
import { AutopodError } from '@autopod/shared';
import type { RepoScanner } from '../security/repo-scanner.js';

const MAX_RECORDED_FINDINGS = 20;
const MAX_MESSAGE_FINDINGS = 5;
/** Daemon-owned budget; a full-tree fallback needs more than the ordinary push diff. */
const PUBLICATION_SCAN_BUDGET_MS = 8 * 60_000;

const SCANNERS: Record<ScanDetectorName, string> = {
  secrets: 'secretlint',
  pii: 'pii-classifier',
  injection: 'injection-classifier',
};

export interface SavedWorkPublicationScanInput {
  scanner: RepoScanner;
  podId: string;
  /** Independent prepared checkout holding the exact selected bytes. */
  worktree: string;
  /** Resolved profile policy. Callers cannot weaken it. */
  policy: SecurityScanPolicy;
  /** Verified merge-base of the selected source with the frozen target branch. */
  baseCommit?: string | null;
  now?: () => number;
}

/**
 * Run the configured push-checkpoint policy over saved-work publication bytes and
 * return redacted evidence. Never throws for scanner failures: those are reported as
 * `failed` so callers can distinguish "blocked by a finding" from "could not run".
 */
export async function scanSavedWorkPublication(
  input: SavedWorkPublicationScanInput,
): Promise<SavedWorkDraftPublicationScan> {
  const now = input.now ?? Date.now;
  // With a verified base, apply the same diff-and-baseline semantics as an ordinary
  // push: content already on the target branch is not new publication. Without one,
  // or when the profile demands full-tree push scans, keep full-tree coverage.
  const scope: 'diff' | 'full' =
    input.baseCommit && input.policy.push.scope !== 'full' ? 'diff' : 'full';
  const baseCommit = scope === 'diff' ? (input.baseCommit ?? null) : null;
  const base = { scope, baseCommit, scannedAt: new Date(now()).toISOString() };
  let scan: Awaited<ReturnType<RepoScanner['scan']>>;
  try {
    scan = await input.scanner.scan('push', {
      podId: input.podId,
      workdir: input.worktree,
      ...(baseCommit ? { baseRef: baseCommit } : {}),
      profile: {
        securityScan: { ...input.policy, push: { ...input.policy.push, scope } },
      },
      // Callers cannot weaken scan policy; the daemon owns this finite budget.
      budgetMs: PUBLICATION_SCAN_BUDGET_MS,
    });
  } catch (error) {
    return {
      ...base,
      outcome: 'failed',
      code: 'SECURITY_SCAN_FAILED',
      decision: null,
      filesScanned: 0,
      filesSkipped: 0,
      findingCount: 0,
      blockingCount: 0,
      findings: [],
      reasons: [`Scanner error: ${errorText(error)}`],
    };
  }
  const findings: SavedWorkDraftPublicationScanFinding[] = scan.findings
    .map((f) => ({
      scanner: SCANNERS[f.detector] ?? f.detector,
      detector: f.detector,
      ruleId: f.ruleId ?? null,
      severity: f.severity,
      file: f.file,
      line: f.line ?? null,
      action: actionFor(f.detector, input.policy.push),
    }))
    .sort(
      (a, b) =>
        Number(b.action === 'block') - Number(a.action === 'block') ||
        a.file.localeCompare(b.file) ||
        (a.line ?? 0) - (b.line ?? 0),
    );
  const blocked = scan.decision === 'block';
  const outcome = blocked ? 'blocked' : scan.scanIncomplete ? 'incomplete' : 'passed';
  return {
    ...base,
    outcome,
    code:
      outcome === 'blocked'
        ? 'SECURITY_SCAN_BLOCKED'
        : outcome === 'incomplete'
          ? 'SECURITY_SCAN_INCOMPLETE'
          : null,
    decision: scan.decision,
    filesScanned: scan.filesScanned,
    filesSkipped: scan.filesSkipped,
    findingCount: findings.length,
    blockingCount: findings.filter((f) => f.action === 'block').length,
    findings: findings.slice(0, MAX_RECORDED_FINDINGS),
    reasons: scan.scanIncomplete
      ? scan.incompleteReasons.length
        ? scan.incompleteReasons
        : ['Scan coverage was incomplete.']
      : [],
  };
}

/** Human-readable explanation for a non-passing scan. Contains no matched values. */
export function describePublicationScan(scan: SavedWorkDraftPublicationScan): string {
  const scope =
    scan.scope === 'diff' && scan.baseCommit
      ? `Scope: files changed since base ${scan.baseCommit.slice(0, 12)}; findings already in the base are ignored.`
      : 'Scope: full tree (no verified base); findings in unchanged files also count.';
  const reasons = scan.reasons.length ? ` Reason: ${scan.reasons.join(' ')}` : '';
  switch (scan.outcome) {
    case 'blocked': {
      const shown = scan.findings
        .filter((f) => f.action === 'block')
        .slice(0, MAX_MESSAGE_FINDINGS)
        .map(formatFinding);
      const total = scan.blockingCount;
      const more = total > shown.length ? `; and ${total - shown.length} more` : '';
      return `Saved-work publication security scan blocked by ${total} finding(s); nothing was pushed: ${shown.join('; ')}${more}. ${scope}${reasons} Values are redacted. Remove or justify the content (for example via the profile security scan policy), then confirm again; the operation stays prepared until it expires or is cancelled.`;
    }
    case 'incomplete':
      return `Saved-work publication security scan did not complete within its required coverage; nothing was pushed.${reasons} ${scope}`;
    case 'failed':
      return `Saved-work publication security scan could not run; nothing was pushed.${reasons}`;
    case 'passed':
      return `Saved-work publication security scan passed (${scan.filesScanned} file(s)). ${scope}`;
  }
}

export function publicationScanError(scan: SavedWorkDraftPublicationScan): AutopodError {
  return new AutopodError(describePublicationScan(scan), scan.code ?? 'SECURITY_SCAN_FAILED', 409);
}

function formatFinding(f: SavedWorkDraftPublicationScanFinding): string {
  return `${f.scanner} rule ${f.ruleId ?? `${f.detector} (unnamed)`} at ${f.file}${f.line === null ? '' : `:${f.line}`}`;
}

function actionFor(detector: ScanDetectorName, policy: CheckpointPolicy): ScanOutcome {
  switch (detector) {
    case 'secrets':
      return policy.onSecret;
    case 'pii':
      return policy.onPii;
    case 'injection':
      return policy.onInjection;
  }
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}
