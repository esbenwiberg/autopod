import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Session } from '@autopod/shared';

const execFileAsync = promisify(execFile);

/** Max bytes for git log / diff output to avoid blowing up prompt context. */
const MAX_OUTPUT_BYTES = 8_000;

export interface RecoveryContext {
  originalTask: string;
  branch: string;
  gitLog: string;
  uncommittedDiff: string;
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
export async function buildContinuationPrompt(
  session: Session,
  worktreePath: string,
): Promise<string> {
  const gitLog = await getGitLog(worktreePath, 10);
  const uncommittedDiff = await getUncommittedDiff(worktreePath);

  return [
    'Your session was interrupted and is being recovered.',
    'Your previous work is preserved in the worktree.',
    '',
    `Original task: ${session.task}`,
    '',
    gitLog ? `Recent commits on this branch:\n${gitLog}` : 'No commits on this branch yet.',
    '',
    uncommittedDiff ? `Uncommitted changes:\n${uncommittedDiff}` : 'No uncommitted changes.',
    '',
    'Check the plan and git log to determine where you left off, then continue.',
  ].join('\n');
}

/**
 * Build a full recovery task for non-Claude runtimes (or Claude without a session ID).
 * Wraps the original task with recovery context so the agent has full awareness.
 */
export async function buildRecoveryTask(session: Session, worktreePath: string): Promise<string> {
  const continuationContext = await buildContinuationPrompt(session, worktreePath);
  return `${session.task}\n\n---\n\nRECOVERY CONTEXT:\n${continuationContext}`;
}
