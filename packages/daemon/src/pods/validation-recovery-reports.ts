import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ValidationResult } from '@autopod/shared';
import { resolveSandboxCheckpointSourceHead } from '../worktrees/sandbox-workspace-checkpoint.js';
import { validationRecoveryError } from './validation-execution-ledger.js';

/** Recheck retained source on every POST, including after a daemon restart. */
export async function verifyValidationRecoverySource(
  worktree: string,
  podId: string,
  commit: string,
): Promise<void> {
  const git = (args: string[]) =>
    promisify(execFile)('git', args, { cwd: worktree, timeout: 30000 });
  try {
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Invalid checkpoint');
    if (!(await resolveSandboxCheckpointSourceHead(worktree, podId, commit)))
      throw new Error('Checkpoint no longer retained for this pod');
    const head = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    const dirty = (await git(['status', '--porcelain', '--untracked-files=all'])).stdout.trim();
    if (head !== commit || dirty) throw new Error('Retained source changed');
    await git(['fsck', '--strict', '--no-dangling', commit]);
  } catch {
    validationRecoveryError(
      'Retained source checkpoint is missing, changed or corrupt; restore its verified bytes before reconciliation. Original sandbox retained.',
      'VALIDATION_SOURCE_PRESERVATION_REQUIRED',
    );
  }
}

/** Partial console output is in the immutable dispatch result; referenced reports need bytes too. */
export async function verifyValidationRecoveryReports(
  snapshot: string,
  result: ValidationResult,
): Promise<void> {
  const reports = [
    ...(result.factValidation?.results.flatMap((fact) => [
      fact.artifactPath,
      ...(fact.attachments?.map((attachment) => attachment.path) ?? []),
    ]) ?? []),
    ...result.smoke.pages.map((page) => page.screenshotPath),
    ...(result.taskReview?.screenshots.map((screenshot) => screenshot.relativePath) ?? []),
  ].filter(Boolean);
  if (!reports.length) return;
  const root = await realpath(snapshot);
  for (const report of new Set(reports)) {
    const relative = report.startsWith('/workspace/') ? report.slice('/workspace/'.length) : report;
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..'))
      validationRecoveryError(
        `Required report ${report} is outside the preserved workspace; retain it through a supported export before recovery.`,
        'VALIDATION_REPORT_PRESERVATION_REQUIRED',
      );
    const target = path.resolve(root, relative);
    try {
      const actual = await realpath(target);
      if (!actual.startsWith(`${root}${path.sep}`) || !(await lstat(actual)).isFile())
        throw new Error('Report not a retained file');
    } catch {
      validationRecoveryError(
        `Required report ${report} is missing from the verified workspace snapshot; original sandbox retained.`,
        'VALIDATION_REPORT_PRESERVATION_REQUIRED',
      );
    }
  }
}
