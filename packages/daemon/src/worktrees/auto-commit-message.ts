import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import type { ContentBlock } from '@anthropic-ai/sdk/resources/messages.js';
import type { Logger } from 'pino';

const execFileAsync = promisify(execFile);

const FALLBACK_MESSAGE = 'chore: auto-commit uncommitted agent changes';
const MODEL_ID = 'claude-haiku-4-5-20251001';
const MAX_DIFF_BYTES = 8 * 1024;
const API_TIMEOUT_MS = 10_000;
const MAX_MESSAGE_LENGTH = 100;

let warnedMissingApiKey = false;
function warnMissingApiKeyOnce(logger: Logger): void {
  if (warnedMissingApiKey) return;
  warnedMissingApiKey = true;
  logger.warn(
    'auto-commit message: ANTHROPIC_API_KEY not set — falling back to heuristic ' +
      'commit messages (`chore: auto-commit updates to ...`). Set ANTHROPIC_API_KEY ' +
      'on the daemon to get conventional-commit subjects.',
  );
}

const SYSTEM_PROMPT =
  'Generate a single conventional-commit subject line summarizing the staged diff. ' +
  'Format: "type: subject" where type is one of feat, fix, chore, refactor, test, docs, style, perf. ' +
  'Use chore when the change is mixed or unclear. ' +
  'Return ONLY the subject line — no body, no quotes, no backticks, no markdown, no trailing period. ' +
  'Maximum 72 characters total.';

/**
 * Generate a commit message for staged changes in `worktreePath`.
 *
 * Tries Claude Haiku first; on any failure falls back to a deterministic
 * `git diff --cached --stat`-based message. As a last resort returns a
 * generic chore message so the caller can always commit.
 *
 * Never throws.
 */
export async function generateAutoCommitMessage(
  worktreePath: string,
  podTask: string | undefined,
  logger: Logger,
): Promise<string> {
  let stat = '';
  try {
    const result = await execFileAsync('git', ['diff', '--cached', '--stat'], {
      cwd: worktreePath,
    });
    stat = result.stdout;
  } catch (err) {
    logger.warn({ err, worktreePath }, 'auto-commit message: failed to read git stat');
    return FALLBACK_MESSAGE;
  }

  const heuristic = buildHeuristicMessage(stat);

  if (!process.env.ANTHROPIC_API_KEY) {
    warnMissingApiKeyOnce(logger);
    return heuristic;
  }

  let diff = '';
  try {
    const result = await execFileAsync('git', ['diff', '--cached'], {
      cwd: worktreePath,
      maxBuffer: 10 * 1024 * 1024,
    });
    diff = result.stdout.slice(0, MAX_DIFF_BYTES);
  } catch (err) {
    logger.debug({ err, worktreePath }, 'auto-commit message: failed to read git diff');
    return heuristic;
  }

  try {
    const client = new Anthropic();
    const taskLine = podTask ? `Pod task: ${podTask}\n\n` : '';
    const response = await client.messages.create({
      model: MODEL_ID,
      max_tokens: 100,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `${taskLine}Diff stat:\n${stat}\nDiff (truncated):\n${diff}`,
        },
      ],
      timeout: API_TIMEOUT_MS,
    });

    const text = response.content
      .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();

    if (!text || text.length > MAX_MESSAGE_LENGTH || text.includes('\n')) {
      logger.debug(
        { worktreePath, length: text.length },
        'auto-commit message: model output rejected, using heuristic',
      );
      return heuristic;
    }

    return text;
  } catch (err) {
    logger.warn(
      { err, worktreePath },
      'auto-commit message: Anthropic call failed, using heuristic',
    );
    return heuristic;
  }
}

/**
 * Build a deterministic commit message from `git diff --cached --stat` output.
 * The stat looks like:
 *   src/foo.ts | 12 ++++--
 *   src/bar.ts |  3 +++
 *    2 files changed, 13 insertions(+), 2 deletions(-)
 */
export function buildHeuristicMessage(stat: string): string {
  const lines = stat
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return FALLBACK_MESSAGE;

  const summaryLine = lines[lines.length - 1] ?? '';
  const fileLines = lines.slice(0, -1);

  const insertions = matchNumber(summaryLine, /(\d+)\s+insertion/);
  const deletions = matchNumber(summaryLine, /(\d+)\s+deletion/);

  const filenames = fileLines
    .map((line) => line.split('|')[0]?.trim())
    .filter((name): name is string => Boolean(name))
    .map((path) => {
      const parts = path.split('/');
      return parts[parts.length - 1] ?? path;
    });

  if (filenames.length === 0) return FALLBACK_MESSAGE;

  const top = filenames.slice(0, 3).join(', ');
  const more = filenames.length > 3 ? ` (+${filenames.length - 3} more)` : '';
  const counts =
    insertions !== null || deletions !== null ? ` (+${insertions ?? 0} -${deletions ?? 0})` : '';

  const message = `chore: auto-commit updates to ${top}${more}${counts}`;
  return message.length > MAX_MESSAGE_LENGTH ? message.slice(0, MAX_MESSAGE_LENGTH) : message;
}

function matchNumber(text: string, pattern: RegExp): number | null {
  const m = text.match(pattern);
  if (!m || m[1] === undefined) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}
