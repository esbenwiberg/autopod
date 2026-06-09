import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ContentBlock } from '@anthropic-ai/sdk/resources/messages.js';
import type { Profile } from '@autopod/shared';
import type { Logger } from 'pino';
import {
  type ProfileLlmClientUnavailableReason,
  createProfileAnthropicClient,
} from '../providers/llm-client.js';

const execFileAsync = promisify(execFile);

const FALLBACK_MESSAGE = 'chore: auto-commit uncommitted agent changes';
const MAX_DIFF_BYTES = 8 * 1024;
const API_TIMEOUT_MS = 10_000;
const MAX_MESSAGE_LENGTH = 100;
const DEFAULT_MODEL = 'claude-haiku-4-5';

function pickModel(profile: Profile, podModel: string): string {
  return profile.reviewerModel || profile.defaultModel || podModel || DEFAULT_MODEL;
}

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

export type AutoCommitFallbackReason =
  | 'git_stat_failed'
  | 'git_diff_failed'
  | ProfileLlmClientUnavailableReason
  | 'api_call_failed'
  | 'output_invalid';

export interface AutoCommitMessageResult {
  message: string;
  usedFallback: boolean;
  fallbackReason?: AutoCommitFallbackReason;
  fallbackDetail?: string;
}

/**
 * Generate a commit message for staged changes in `worktreePath`.
 *
 * Uses the same provider credentials the agent ran on (Anthropic API key,
 * MAX OAuth, or Foundry token) via `createProfileAnthropicClient`. Workspace
 * pods on MAX/Foundry get LLM-generated messages without the daemon needing
 * a separate `ANTHROPIC_API_KEY`. On any failure falls back to a
 * deterministic `git diff --cached --stat`-based message. As a last resort
 * returns a generic chore message so the caller can always commit.
 *
 * Never throws. The returned `usedFallback` flag tells callers whether the
 * LLM path succeeded or template was used (and why).
 */
export async function generateAutoCommitMessage(
  input: AutoCommitMessageInput,
  logger: Logger,
): Promise<AutoCommitMessageResult> {
  const { worktreePath, podTask } = input;
  let stat = '';
  try {
    const result = await execFileAsync('git', ['diff', '--cached', '--stat'], {
      cwd: worktreePath,
    });
    stat = result.stdout;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn({ err, worktreePath }, 'auto-commit message: failed to read git stat');
    return {
      message: FALLBACK_MESSAGE,
      usedFallback: true,
      fallbackReason: 'git_stat_failed',
      fallbackDetail: detail,
    };
  }

  const heuristic = buildHeuristicMessage(stat);

  const llm = await createProfileAnthropicClient(
    input.profile,
    pickModel(input.profile, input.podModel),
    logger,
  );
  if (!llm.ok) {
    return { message: heuristic, usedFallback: true, fallbackReason: llm.reason };
  }

  let diff = '';
  try {
    const result = await execFileAsync('git', ['diff', '--cached'], {
      cwd: worktreePath,
      maxBuffer: 10 * 1024 * 1024,
    });
    diff = result.stdout.slice(0, MAX_DIFF_BYTES);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn({ err, worktreePath }, 'auto-commit message: failed to read git diff');
    return {
      message: heuristic,
      usedFallback: true,
      fallbackReason: 'git_diff_failed',
      fallbackDetail: detail,
    };
  }

  try {
    const taskLine = podTask ? `Pod task: ${podTask}\n\n` : '';
    const response = await llm.client.messages.create(
      {
        model: llm.model,
        max_tokens: 100,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: `${taskLine}Diff stat:\n${stat}\nDiff (truncated):\n${diff}`,
          },
        ],
      },
      { timeout: API_TIMEOUT_MS },
    );

    const text = response.content
      .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();

    if (!text || text.length > MAX_MESSAGE_LENGTH || text.includes('\n')) {
      logger.error(
        { worktreePath, length: text.length, raw: text.slice(0, 200), reason: 'output_invalid' },
        'auto-commit message: model output rejected, using heuristic',
      );
      return {
        message: heuristic,
        usedFallback: true,
        fallbackReason: 'output_invalid',
        fallbackDetail: `length=${text.length}`,
      };
    }

    return { message: text, usedFallback: false };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error(
      { err, worktreePath, reason: 'api_call_failed' },
      'auto-commit message: model API call failed, using heuristic',
    );
    return {
      message: heuristic,
      usedFallback: true,
      fallbackReason: 'api_call_failed',
      fallbackDetail: detail,
    };
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
