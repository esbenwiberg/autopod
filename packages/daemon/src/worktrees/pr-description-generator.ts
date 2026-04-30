import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ContentBlock } from '@anthropic-ai/sdk/resources/messages.js';
import type { Profile, TaskSummary } from '@autopod/shared';
import type { Logger } from 'pino';
import { createProfileAnthropicClient } from '../providers/llm-client.js';
import { buildPrTitle } from './pr-body-builder.js';

const execFileAsync = promisify(execFile);

const MAX_DIFF_BYTES = 20 * 1024;
const API_TIMEOUT_MS = 15_000;
const MAX_TITLE_LENGTH = 72;

const TITLE_SYSTEM_PROMPT =
  'Generate a single-line GitHub PR title in conventional-commit format. ' +
  'Format: "type(scope): short imperative description" ' +
  'Types: feat, fix, chore, refactor, docs, test, ci, style, perf. ' +
  'scope is optional; use only when it meaningfully narrows the area (e.g. auth, api, db). ' +
  'Subject in imperative mood, no trailing period. ' +
  'Maximum 72 characters total. ' +
  'Return ONLY the title line — no quotes, no markdown, no explanation.';

const NARRATIVE_SYSTEM_PROMPT =
  'Generate sections for a GitHub PR description. Return JSON only — no markdown fence, no explanation:\n' +
  '{\n' +
  '  "why": "1-2 sentences: motivation or problem solved",\n' +
  '  "what": "2-3 sentences: what was implemented or changed",\n' +
  '  "how": "1-3 sentences: key technical decisions, libraries, patterns (null if trivial)",\n' +
  '  "reviewFocus": ["specific file or area deserving close attention", ...]' +
  '}\n' +
  'reviewFocus: 2-3 items max; omit the array (or use []) if nothing stands out. ' +
  'Each item should name a specific file, module, or concern — not generic advice. ' +
  'Be concise and precise. Write for a developer code reviewer, not a business stakeholder.';

const NARRATIVE_COMPACT_SUFFIX =
  ' Keep each field under 120 characters. reviewFocus max 2 items.';

export interface PrNarrative {
  why: string;
  what: string;
  how?: string;
  reviewFocus?: string[];
}

export interface PrDescriptionInput {
  task: string;
  worktreePath: string;
  baseBranch: string;
  taskSummary?: TaskSummary;
  seriesName?: string;
  seriesDescription?: string;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  /**
   * Profile that owns this pod. Drives daemon-side LLM auth via the same
   * provider/credentials the agent uses.
   */
  profile: Profile;
  /** Pod's model id (e.g. 'haiku', 'sonnet', 'opus', or full id). */
  podModel: string;
  /**
   * Human-supplied instructions captured at workspace→agent promotion. For
   * promoted pods these are usually a far better signal than `task`, which is
   * often a placeholder ("#4") on the original interactive pod.
   */
  handoffInstructions?: string;
}

async function readBranchDiff(
  worktreePath: string,
  baseBranch: string,
  logger: Logger,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['diff', `origin/${baseBranch}...HEAD`], {
      cwd: worktreePath,
      maxBuffer: 30 * 1024 * 1024,
    });
    return stdout.slice(0, MAX_DIFF_BYTES);
  } catch (err) {
    logger.debug({ err, worktreePath }, 'pr-description-generator: failed to read branch diff');
    return '';
  }
}

function buildUserMessage(input: PrDescriptionInput, diff: string): string {
  const lines: string[] = [];
  lines.push(`Task: ${input.task}`);
  if (input.handoffInstructions) {
    lines.push(`Human handoff instructions: ${input.handoffInstructions}`);
  }
  if (input.seriesDescription) lines.push(`Series description: ${input.seriesDescription}`);
  if (input.taskSummary?.actualSummary) {
    lines.push(`Agent summary: ${input.taskSummary.actualSummary}`);
  }
  if (input.taskSummary?.how) lines.push(`Agent technical notes: ${input.taskSummary.how}`);
  lines.push(
    `Stats: ${input.filesChanged} files changed, +${input.linesAdded} -${input.linesRemoved}`,
  );
  if (diff) lines.push(`\nDiff (truncated to ${MAX_DIFF_BYTES / 1024}KB):\n${diff}`);
  return lines.join('\n');
}

/**
 * Generate an LLM PR title in conventional-commit format using the profile's
 * provider+model. Falls back to `buildPrTitle()` on any error or when the
 * profile's provider is not daemon-callable (copilot, foundry openai surface).
 */
export async function generatePrTitle(
  input: PrDescriptionInput,
  logger: Logger,
): Promise<string> {
  const fallback = buildPrTitle(
    input.handoffInstructions || input.task,
    input.seriesName,
    input.seriesDescription,
  );

  const llm = await createProfileAnthropicClient(input.profile, input.podModel, logger);
  if (!llm) return fallback;

  const diff = await readBranchDiff(input.worktreePath, input.baseBranch, logger);

  try {
    const response = await llm.client.messages.create({
      model: llm.model,
      max_tokens: 100,
      system: TITLE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserMessage(input, diff) }],
      timeout: API_TIMEOUT_MS,
    });

    const text = response.content
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();

    if (!text || text.length > MAX_TITLE_LENGTH || text.includes('\n')) {
      logger.debug(
        { length: text.length },
        'pr-description-generator: title rejected by validation, using fallback',
      );
      return fallback;
    }

    return text;
  } catch (err) {
    logger.warn({ err }, 'pr-description-generator: title generation failed, using fallback');
    return fallback;
  }
}

/**
 * Generate LLM narrative sections (Why / What / How / Review Focus) for a PR
 * body using the profile's provider+model. Falls back to plain task /
 * taskSummary text on any error.
 */
export async function generatePrNarrative(
  input: PrDescriptionInput,
  logger: Logger,
  compact = false,
): Promise<PrNarrative> {
  const fallback: PrNarrative = {
    why: input.seriesDescription ?? input.handoffInstructions ?? input.task,
    what: input.taskSummary?.actualSummary ?? input.handoffInstructions ?? input.task,
    how: input.taskSummary?.how,
  };

  const llm = await createProfileAnthropicClient(input.profile, input.podModel, logger);
  if (!llm) return fallback;

  const diff = await readBranchDiff(input.worktreePath, input.baseBranch, logger);
  const systemPrompt = compact
    ? NARRATIVE_SYSTEM_PROMPT + NARRATIVE_COMPACT_SUFFIX
    : NARRATIVE_SYSTEM_PROMPT;

  try {
    const response = await llm.client.messages.create({
      model: llm.model,
      max_tokens: compact ? 400 : 800,
      system: systemPrompt,
      messages: [{ role: 'user', content: buildUserMessage(input, diff) }],
      timeout: API_TIMEOUT_MS,
    });

    const raw = response.content
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();

    const parsed = parseNarrativeJson(raw);
    if (!parsed) {
      logger.debug(
        { raw: raw.slice(0, 200) },
        'pr-description-generator: narrative JSON invalid, using fallback',
      );
      return fallback;
    }

    return parsed;
  } catch (err) {
    logger.warn({ err }, 'pr-description-generator: narrative generation failed, using fallback');
    return fallback;
  }
}

function parseNarrativeJson(raw: string): PrNarrative | null {
  try {
    // Strip markdown code fences if the model wraps output despite instructions
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
    const obj = JSON.parse(cleaned) as Record<string, unknown>;

    const why = typeof obj['why'] === 'string' ? obj['why'].trim() : null;
    const what = typeof obj['what'] === 'string' ? obj['what'].trim() : null;
    if (!why || !what) return null;

    const how = typeof obj['how'] === 'string' && obj['how'].trim() ? obj['how'].trim() : undefined;

    let reviewFocus: string[] | undefined;
    if (Array.isArray(obj['reviewFocus'])) {
      const items = obj['reviewFocus'].filter(
        (x): x is string => typeof x === 'string' && x.trim().length > 0,
      );
      if (items.length > 0) reviewFocus = items.slice(0, 3);
    }

    return { why, what, how, reviewFocus };
  } catch {
    return null;
  }
}
