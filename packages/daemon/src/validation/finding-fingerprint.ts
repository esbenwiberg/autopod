import { createHash } from 'node:crypto';
import type { ValidationFinding, ValidationResult } from '@autopod/shared';

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
 * Format: 'ac:<hash>' | 'review:<hash>' | 'req:<hash>'
 */
export function findingId(source: ValidationFinding['source'], text: string): string {
  const prefix = source === 'ac_validation' ? 'ac' : source === 'task_review' ? 'review' : 'req';
  return `${prefix}:${fingerprintText(text)}`;
}

/**
 * Walks a ValidationResult and extracts all failed findings as ValidationFinding objects.
 * Only extracts from AI-driven checks (AC validation, task review, requirements check) —
 * build/health/smoke failures are objective and not subject to human override.
 */
export function extractFindings(result: ValidationResult): ValidationFinding[] {
  const findings: ValidationFinding[] = [];

  // AC validation failures
  if (result.acValidation?.status === 'fail') {
    for (const check of result.acValidation.results) {
      if (!check.passed) {
        findings.push({
          id: findingId('ac_validation', check.criterion),
          source: 'ac_validation',
          description: check.criterion,
          reasoning: check.reasoning,
        });
      }
    }
  }

  // Task review issues
  if (result.taskReview && result.taskReview.status === 'fail') {
    for (const issue of result.taskReview.issues) {
      findings.push({
        id: findingId('task_review', issue),
        source: 'task_review',
        description: issue,
      });
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
