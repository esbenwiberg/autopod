import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ContentBlock } from '@anthropic-ai/sdk/resources/messages.js';
import type { Profile } from '@autopod/shared';
import type { Logger } from 'pino';
import { createProfileAnthropicClient } from '../providers/llm-client.js';

const execFileAsync = promisify(execFile);

const FALLBACK_MESSAGE = 'chore: auto-commit uncommitted agent changes';
const MAX_DIFF_BYTES = 8 * 1024;
const API_TIMEOUT_MS = 10_000;
const MAX_MESSAGE_LENGTH = 100;

const SYSTEM_PROMPT =
  'Generate a single conventional-commit subject line summarizing the staged diff. ' +
  'Format: "type: subject" where type is one of feat, fix, chore, refactor, test, docs, style, perf. ' +
  'Use chore when the change is mixed or unclear. ' +
  'Return ONLY the subject line — no body, no quotes, no backticks, no markdown, no trailing period. ' +
  'Maximum 72 characters total.';

export interface AutoCommitMessageInput {
  worktreePath: string;
  podTask?: string;
  /** Profile that owns the pod — drives daemon-side LLM auth. */
  profile: Profile;
  /** Pod's model id (e.g. 'haiku', 'sonnet', 'opus', or full id). */
  podModel: string;
}

/**
 * Generate a commit message for staged changes in `worktreePath`.
 *
 * Tries the profile's provider+model first; on any failure falls back to a
 * deterministic `git diff --cached --stat`-based message. As a last resort
 * returns a generic chore message so the caller can always commit.
 *
 * Never throws.
 */
export async function generateAutoCommitMessage(
  input: AutoCommitMessageInput,
  logger: Logger,
): Promise<string> {
  const { worktreePath, podTask } = input;
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

  const llm = await createProfileAnthropicClient(input.profile, input.podModel, logger);
  if (!llm) return heuristic;

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
    const taskLine = podTask ? `Pod task: ${podTask}\n\n` : '';
    const response = await llm.client.messages.create({
      model: llm.model,
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
    logger.warn({ err, worktreePath }, 'auto-commit message: model call failed, using heuristic');
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
