import { execFile } from 'node:child_process';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  MAX_PROVIDER_FAILOVER_HANDOFF_LENGTH,
  PROVIDER_FAILOVER_HANDOFF_PATH,
  type Pod,
  type ProviderAttempt,
  type ProviderFailureClassification,
  processContent,
} from '@autopod/shared';

const execFileAsync = promisify(execFile);

/** Max bytes for git log / diff output to avoid blowing up prompt context. */
const MAX_OUTPUT_BYTES = 8_000;

export interface RecoveryContext {
  originalTask: string;
  branch: string;
  gitLog: string;
  uncommittedDiff: string;
}

export function hasPendingProviderContinuation(
  attempts: readonly ProviderAttempt[] | null | undefined,
): boolean {
  if (!attempts) return false;
  const activeAttempts = attempts.filter(
    (attempt) => attempt.endedAt === null && attempt.outcome === null,
  );
  if (activeAttempts.length !== 1) return false;

  const activeAttempt = activeAttempts[0];
  if (!activeAttempt) return false;
  return attempts.some(
    (attempt) =>
      attempt.ordinal === activeAttempt.ordinal - 1 &&
      attempt.handoffReference === PROVIDER_FAILOVER_HANDOFF_PATH,
  );
}

function sanitizeHandoffText(value: string): string {
  return processContent(value, {
    sanitization: { preset: 'standard' },
    quarantine: { enabled: true },
  }).text;
}

function boundedSection(heading: string, content: string | null | undefined, max: number): string {
  const sanitized = sanitizeHandoffText(content?.trim() ?? '');
  if (!sanitized) return '';
  return `## ${heading}\n\n${sanitized.slice(0, max)}`;
}

export async function buildProviderFailoverHandoff(
  pod: Pod,
  worktreePath: string,
  classification: ProviderFailureClassification,
  visibleActivity: readonly string[] = [],
): Promise<string> {
  const [gitLog, uncommittedDiff] = await Promise.all([
    getGitLog(worktreePath, 20),
    getUncommittedDiff(worktreePath),
  ]);
  const visibleProgress = pod.progress
    ? `${pod.progress.phase} (${pod.progress.currentPhase}/${pod.progress.totalPhases}): ${pod.progress.description}`
    : null;
  const summary = pod.taskSummary
    ? [
        pod.taskSummary.actualSummary,
        pod.taskSummary.how,
        ...pod.taskSummary.deviations.map(
          (item) => `${item.step}: ${item.actual} (${item.reason})`,
        ),
      ]
        .filter(Boolean)
        .join('\n')
    : null;
  const sections = [
    '# Autopod provider failover handoff',
    '',
    'This bounded document contains selected visible continuity context. Re-check the worktree before continuing.',
    boundedSection('Task', pod.task, 8_000),
    boundedSection(
      'Plan',
      pod.plan ? [pod.plan.summary, ...pod.plan.steps].join('\n') : null,
      3_000,
    ),
    boundedSection('Progress', visibleProgress, 2_000),
    boundedSection('Task summary', summary, 4_000),
    boundedSection('Visible runtime activity', visibleActivity.join('\n'), 4_000),
    boundedSection('Terminal reason', classification.sanitizedMessage, 2_000),
    boundedSection('Recent commits', gitLog, 3_000),
    boundedSection('Uncommitted Git state', uncommittedDiff, 2_000),
  ].filter(Boolean);
  return sections.join('\n\n').slice(0, MAX_PROVIDER_FAILOVER_HANDOFF_LENGTH);
}

export async function writeProviderFailoverHandoff(
  pod: Pod,
  worktreePath: string,
  classification: ProviderFailureClassification,
  visibleActivity: readonly string[] = [],
): Promise<string> {
  const content = await buildProviderFailoverHandoff(
    pod,
    worktreePath,
    classification,
    visibleActivity,
  );
  const destination = path.join(worktreePath, PROVIDER_FAILOVER_HANDOFF_PATH);
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
  return destination;
}

async function getGitLog(worktreePath: string, maxCommits: number): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['log', '--oneline', `-${maxCommits}`], {
      cwd: worktreePath,
      maxBuffer: MAX_OUTPUT_BYTES * 2,
    });
    return stdout.trim().slice(0, MAX_OUTPUT_BYTES);
  } catch {
    return '';
  }
}

async function getUncommittedDiff(worktreePath: string): Promise<string> {
  try {
    // Include both staged and unstaged changes
    const { stdout } = await execFileAsync('git', ['diff', 'HEAD', '--stat'], {
      cwd: worktreePath,
      maxBuffer: MAX_OUTPUT_BYTES * 2,
    });
    return stdout.trim().slice(0, MAX_OUTPUT_BYTES);
  } catch {
    return '';
  }
}

/**
 * Build a continuation prompt for Claude --resume.
 * Gives the agent enough context to pick up where it left off.
 */
export async function buildContinuationPrompt(pod: Pod, worktreePath: string): Promise<string> {
  const gitLog = await getGitLog(worktreePath, 10);
  const uncommittedDiff = await getUncommittedDiff(worktreePath);

  return [
    'Your pod was interrupted and is being recovered.',
    'Your previous work is preserved in the worktree.',
    '',
    `Original task: ${pod.task}`,
    '',
    gitLog ? `Recent commits on this branch:\n${gitLog}` : 'No commits on this branch yet.',
    '',
    uncommittedDiff ? `Uncommitted changes:\n${uncommittedDiff}` : 'No uncommitted changes.',
    '',
    'Check the plan and git log to determine where you left off, then continue.',
  ].join('\n');
}

/**
 * Build a rework prompt for pods being retried after failure/rejection/kill.
 * Unlike recovery (crash mid-work), rework starts a fresh agent with explicit
 * context about what the previous attempt did and why it's being retried.
 */
export async function buildReworkPrompt(
  pod: Pod,
  worktreePath: string,
  reason: string,
): Promise<string> {
  const gitLog = await getGitLog(worktreePath, 10);
  const uncommittedDiff = await getUncommittedDiff(worktreePath);

  return [
    `REWORK: ${reason}`,
    '',
    `Task: ${pod.task}`,
    '',
    gitLog
      ? `Previous attempt made these commits:\n${gitLog}`
      : 'No commits from the previous attempt.',
    '',
    uncommittedDiff ? `Uncommitted changes from previous attempt:\n${uncommittedDiff}` : '',
    '',
    'You have a fresh pod. Review the existing state, then complete the task.',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Build a full recovery task for non-Claude runtimes (or Claude without a pod ID).
 * Wraps the original task with recovery context so the agent has full awareness.
 */
export async function buildRecoveryTask(pod: Pod, worktreePath: string): Promise<string> {
  const continuationContext = await buildContinuationPrompt(pod, worktreePath);
  return `${pod.task}\n\n---\n\nRECOVERY CONTEXT:\n${continuationContext}`;
}

/**
 * Build a full rework task for non-Claude runtimes.
 * Wraps the original task with rework context.
 */
export async function buildReworkTask(
  pod: Pod,
  worktreePath: string,
  reason: string,
): Promise<string> {
  const reworkContext = await buildReworkPrompt(pod, worktreePath, reason);
  return `${pod.task}\n\n---\n\nREWORK CONTEXT:\n${reworkContext}`;
}
