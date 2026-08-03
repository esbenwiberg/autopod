import { createHash } from 'node:crypto';
import type { ValidationFinding, ValidationResult } from '@autopod/shared';
import type { StructuredReviewFinding } from '@autopod/shared';

/**
 * Normalizes text and produces a stable 12-hex-char fingerprint.
 * Used to match semantically similar findings across validation attempts.
 */
export function fingerprintText(text: string): string {
  const normalized = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '') // strip punctuation
    .replace(/\s+/g, ' ') // collapse whitespace
    .trim();
  return createHash('sha256').update(normalized).digest('hex').slice(0, 12);
}

/**
 * Builds a stable finding ID for a given source and text.
 * Format: 'fact:<hash>' | 'review:<hash>' | 'req:<hash>'
 */
export function findingId(source: ValidationFinding['source'], text: string): string {
  const prefix =
    source === 'fact_validation' ? 'fact' : source === 'task_review' ? 'review' : 'req';
  return `${prefix}:${fingerprintText(text)}`;
}

/** Stable identity for council findings: wording/evidence may evolve without changing the issue. */
export function structuredFindingId(
  finding: Pick<StructuredReviewFinding, 'axis' | 'path' | 'symbol' | 'claim'>,
): string {
  // Axes are independent reviewer provenance, not semantic identity: the same
  // defect can legitimately be reported by different axes on later attempts.
  return `review:${fingerprintText([finding.path, finding.symbol ?? '', finding.claim].join(' '))}`;
}

/** Source/provenance identity remains axis-specific even when semantic identity is shared. */
export function structuredFindingSourceId(
  finding: Pick<StructuredReviewFinding, 'axis' | 'path' | 'symbol' | 'claim'>,
): string {
  return `review-source:${fingerprintText([finding.axis, finding.path, finding.symbol ?? '', finding.claim].join(' '))}`;
}

/**
 * Walks a ValidationResult and extracts all failed findings as ValidationFinding objects.
 * Only extracts from reviewable checks (required facts, task review, requirements check) —
 * build/health/smoke failures are objective and not subject to human override.
 */
export function extractFindings(result: ValidationResult): ValidationFinding[] {
  const findings: ValidationFinding[] = [];

  // Required fact failures
  if (result.factValidation?.status === 'fail') {
    for (const check of result.factValidation.results) {
      if (!check.passed) {
        findings.push({
          id: findingId('fact_validation', check.factId),
          source: 'fact_validation',
          description: `${check.factId}: ${check.command}`,
          reasoning: check.reasoning,
        });
      }
    }
  }

  // Task review issues
  if (result.taskReview && result.taskReview.status === 'fail') {
    const council =
      result.taskReview.reviewBatch?.ledger?.filter((entry) => entry.state !== 'fixed') ?? [];
    const councilByDescription = new Map<string, typeof council>();
    for (const entry of council) {
      const finding = entry.finding;
      const description =
        'source' in finding
          ? finding.issue
          : `[${finding.severity}] ${finding.path}${finding.line ? `:${finding.line}` : ''} — ${finding.claim}`;
      const matching = councilByDescription.get(description) ?? [];
      matching.push(entry);
      councilByDescription.set(description, matching);
    }
    const emittedCouncilIds = new Set<string>();
    for (const issue of result.taskReview.issues) {
      const canonical = councilByDescription.get(issue);
      if (canonical && canonical.length > 0) {
        for (const entry of canonical) {
          if (emittedCouncilIds.has(entry.semanticId)) continue;
          emittedCouncilIds.add(entry.semanticId);
          findings.push({
            id: entry.semanticId,
            source: 'task_review',
            description: issue,
          });
        }
      } else {
        findings.push({
          id: findingId('task_review', issue),
          source: 'task_review',
          description: issue,
        });
      }
    }
  }

  // Requirements check failures
  if (result.taskReview?.requirementsCheck) {
    for (const item of result.taskReview.requirementsCheck) {
      if (!item.met) {
        findings.push({
          id: findingId('requirements_check', item.criterion),
          source: 'requirements_check',
          description: item.criterion,
          reasoning: item.note,
        });
      }
    }
  }

  return findings;
}

/**
 * Returns findings present in both current and previous results (matched by stable ID).
 * These are candidates for human override — the same issue persisted across attempts.
 */
export function detectRecurringFindings(
  current: ValidationFinding[],
  previous: ValidationFinding[],
): ValidationFinding[] {
  const previousIds = new Set(previous.map((f) => f.id));
  return current.filter((f) => previousIds.has(f.id));
}
