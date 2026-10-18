import type { ScanFinding } from '@autopod/shared';
import { processContent } from '@autopod/shared';
import type { CompletionDiagnosticsCaptured } from './completion-ports.js';

const SECURITY_SCAN_FINDING_LOG_LIMIT = 20;

export type OperatorFailurePhase = 'setup' | 'agent' | 'completion';

export function summarizeAgentCompletionBlocker(result: string): string | null {
  const normalized = result.toLowerCase();
  if (normalized.includes('bwrap: no permissions to create a new namespace')) {
    return 'Agent could not run shell commands: bwrap cannot create a namespace.';
  }
  if (normalized.includes('blocked by the execution environment')) {
    return 'Agent reported it was blocked by the execution environment.';
  }
  if (normalized.includes("can't inspect files") && normalized.includes('edit code')) {
    return 'Agent reported it could not inspect or edit files.';
  }
  return null;
}

export function formatElapsedDuration(durationMs: number): string {
  return `${(durationMs / 1_000).toFixed(1)}s`;
}

export function sanitizeSecurityScanLogValue(value: string | undefined, fallback: string): string {
  const normalized = value?.replace(/\s+/g, ' ').trim().slice(0, 400);
  if (!normalized) return fallback;
  const sanitized = processContent(normalized, {
    sanitization: { preset: 'standard' },
  }).text.trim();
  return sanitized || fallback;
}

export function sanitizeFailureReason(raw: unknown, prefix: string): string {
  const message = raw instanceof Error && raw.message.trim().length > 0 ? raw.message : String(raw);
  const sanitized = processContent(message.slice(0, 1200), {
    sanitization: { preset: 'standard' },
  }).text.trim();
  return `${prefix}: ${sanitized || 'unknown error'}`;
}

export function operatorErrorMessage(err: unknown, phase: OperatorFailurePhase): string {
  const prefix =
    phase === 'setup'
      ? 'Pod setup failed before the agent could finish'
      : phase === 'completion'
        ? 'Pod failed while finalizing after the agent run'
        : 'Pod failed while the agent was running';
  return sanitizeFailureReason(err, prefix);
}

export function describeSyncFailure(err: unknown): string {
  if (err instanceof Error && err.message.trim()) {
    return `${err.name}: ${err.message}`;
  }
  return String(err);
}

export function createCompletionDiagnostics(captured: CompletionDiagnosticsCaptured) {
  const { emitActivityError } = captured;

  function emitBlockingSecurityScanFindings(podId: string, findings: ScanFinding[]): void {
    const findingLabel = findings.length === 1 ? 'finding' : 'findings';
    emitActivityError(
      podId,
      `Pre-push security scan blocked: ${findings.length} ${findingLabel}.`,
      false,
    );
    const visibleFindings = findings.slice(0, SECURITY_SCAN_FINDING_LOG_LIMIT);
    for (const [index, finding] of visibleFindings.entries()) {
      const rule = sanitizeSecurityScanLogValue(finding.ruleId, 'unknown');
      const file = sanitizeSecurityScanLogValue(finding.file, 'unknown');
      const location = finding.line ? `${file}:${finding.line}` : file;
      emitActivityError(
        podId,
        `Security finding ${index + 1}/${findings.length}: severity=${finding.severity} ` +
          `detector=${finding.detector} rule=${rule} location=${location}`,
        false,
      );
    }

    const omitted = findings.length - visibleFindings.length;
    if (omitted > 0) {
      const omittedSummary = `${omitted} additional security ${
        omitted === 1 ? 'finding was' : 'findings were'
      } omitted from logs; inspect the security evidence for the complete result.`;
      emitActivityError(podId, omittedSummary, false);
    }
  }
  return { emitBlockingSecurityScanFindings };
}
