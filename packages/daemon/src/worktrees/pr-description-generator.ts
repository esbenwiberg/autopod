import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ContentBlock } from '@anthropic-ai/sdk/resources/messages.js';
import type { TaskSummary } from '@autopod/shared';
import type { Logger } from 'pino';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import {
  createProfileAnthropicClient,
  type ProfileLlmClientDeps,
  type ProfileLlmClientRoute,
  type ProfileLlmClientUnavailableReason,
} from '../providers/llm-client.js';
import { buildPrTitle } from './pr-body-builder.js';

const execFileAsync = promisify(execFile);

const MAX_DIFF_BYTES = 20 * 1024;
const API_TIMEOUT_MS = 15_000;
const MAX_TITLE_LENGTH = 72;
const DEFAULT_DESCRIPTION_MODEL = 'claude-haiku-4-5';

function pickDescriptionModel(profile: PodExecutionSettings, podModel: string): string {
  return profile.reviewerModel || profile.defaultModel || podModel || DEFAULT_DESCRIPTION_MODEL;
}

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

const NARRATIVE_COMPACT_SUFFIX = ' Keep each field under 120 characters. reviewFocus max 2 items.';

export interface PrNarrative {
  why: string;
  what: string;
  how?: string;
  reviewFocus?: string[];
}

/**
 * Stable reason codes for daemon-side LLM fallback paths. Greppable in logs and
 * serializable into pod activity events / PR body footers so the user can see
 * exactly why a template fallback was used instead of an LLM-generated body.
 *
 * The first four codes mirror `ProfileLlmClientUnavailableReason` — the LLM
 * call never reached the API. The trailing three describe failures after the
 * call was attempted.
 */
export type LlmFallbackReason =
  | ProfileLlmClientUnavailableReason
  | 'api_call_failed'
  | 'output_invalid'
  | 'json_parse_failed';

export interface PrTitleResult {
  title: string;
  usedFallback: boolean;
  fallbackReason?: LlmFallbackReason;
  /**
   * Bounded, secret-redacted diagnostic. For api_call_failed it names the
   * provider, auth route, model, HTTP status, error type and request id.
   */
  fallbackDetail?: string;
}

export interface PrNarrativeResult {
  narrative: PrNarrative;
  usedFallback: boolean;
  fallbackReason?: LlmFallbackReason;
  fallbackDetail?: string;
}

export interface PrDescriptionInput {
  task: string;
  /** Spec contract `title`; preferred for the fallback title when present. */
  contractTitle?: string;
  /** Brief frontmatter title (`work.briefTitle`); used for the fallback title. */
  briefTitle?: string;
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
  profile: PodExecutionSettings;
  /** Pod's model id (e.g. 'haiku', 'sonnet', 'opus', or full id). */
  podModel: string;
  /**
   * Human-supplied instructions captured at workspace→agent promotion. For
   * promoted pods these are usually a far better signal than `task`, which is
   * often a placeholder ("#4") on the original interactive pod.
   */
  handoffInstructions?: string;
  /**
   * Optional stores so the daemon-side LLM helper resolves the profile's live
   * provider-account credentials instead of its (possibly stale) inline column.
   */
  deps?: ProfileLlmClientDeps;
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
  const title = input.contractTitle?.trim() || input.briefTitle?.trim();
  if (title) lines.push(`Title: ${title}`);
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
 * Generate an LLM PR title in conventional-commit format using the same
 * provider credentials the agent ran on (Anthropic API key, MAX OAuth, or
 * Foundry token). Routes through `createProfileAnthropicClient`, so workspace
 * pods on MAX/Foundry get LLM-generated titles without the daemon needing a
 * separate `ANTHROPIC_API_KEY`.
 *
 * Falls back to `buildPrTitle()` on any error or when the profile cannot back
 * a daemon-side LLM call. Always returns a usable title — the `usedFallback`
 * flag tells callers whether the LLM path succeeded or template was used
 * (and why).
 */
export async function generatePrTitle(
  input: PrDescriptionInput,
  logger: Logger,
): Promise<PrTitleResult> {
  const fallbackTitle = buildPrTitle({
    task: input.handoffInstructions || input.task,
    contractTitle: input.contractTitle,
    briefTitle: input.briefTitle,
    seriesName: input.seriesName,
    seriesDescription: input.seriesDescription,
  });

  const llm = await createProfileAnthropicClient(
    input.profile,
    pickDescriptionModel(input.profile, input.podModel),
    logger,
    input.deps,
  );
  if (!llm.ok) {
    return { title: fallbackTitle, usedFallback: true, fallbackReason: llm.reason };
  }

  const diff = await readBranchDiff(input.worktreePath, input.baseBranch, logger);

  try {
    const response = await llm.client.messages.create(
      {
        model: llm.model,
        max_tokens: 100,
        system: TITLE_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildUserMessage(input, diff) }],
      },
      { timeout: API_TIMEOUT_MS },
    );

    const text = response.content
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();

    if (!text || text.length > MAX_TITLE_LENGTH || text.includes('\n')) {
      logger.error(
        { length: text.length, raw: text.slice(0, 200), reason: 'output_invalid' },
        'pr-description-generator: title rejected by validation, using fallback',
      );
      return {
        title: fallbackTitle,
        usedFallback: true,
        fallbackReason: 'output_invalid',
        fallbackDetail: `length=${text.length}`,
      };
    }

    return { title: text, usedFallback: false };
  } catch (err) {
    const failure = describeApiCallFailure(err, llm, input.profile);
    logger.error(
      { reason: 'api_call_failed', ...failure.fields },
      'pr-description-generator: title generation API call failed, using fallback',
    );
    return {
      title: fallbackTitle,
      usedFallback: true,
      fallbackReason: 'api_call_failed',
      fallbackDetail: failure.detail,
    };
  }
}

/**
 * Generate LLM narrative sections (Why / What / How / Review Focus) for a PR
 * body using the same provider credentials the agent ran on (Anthropic API
 * key, MAX OAuth, or Foundry token). Routes through
 * `createProfileAnthropicClient`, so workspace pods on MAX/Foundry get
 * diff-grounded bodies without the daemon needing a separate
 * `ANTHROPIC_API_KEY`.
 *
 * Falls back to plain task / taskSummary text on any error.
 * Always returns a usable narrative — the `usedFallback` flag tells callers
 * whether the LLM path succeeded or template was used (and why).
 */
export async function generatePrNarrative(
  input: PrDescriptionInput,
  logger: Logger,
  compact = false,
): Promise<PrNarrativeResult> {
  const fallbackNarrative: PrNarrative = {
    why: input.seriesDescription ?? input.handoffInstructions ?? input.task,
    what: input.taskSummary?.actualSummary ?? input.handoffInstructions ?? input.task,
    how: input.taskSummary?.how,
  };

  const llm = await createProfileAnthropicClient(
    input.profile,
    pickDescriptionModel(input.profile, input.podModel),
    logger,
    input.deps,
  );
  if (!llm.ok) {
    return {
      narrative: fallbackNarrative,
      usedFallback: true,
      fallbackReason: llm.reason,
    };
  }

  const diff = await readBranchDiff(input.worktreePath, input.baseBranch, logger);
  const systemPrompt = compact
    ? NARRATIVE_SYSTEM_PROMPT + NARRATIVE_COMPACT_SUFFIX
    : NARRATIVE_SYSTEM_PROMPT;

  try {
    const response = await llm.client.messages.create(
      {
        model: llm.model,
        max_tokens: compact ? 400 : 800,
        system: systemPrompt,
        messages: [{ role: 'user', content: buildUserMessage(input, diff) }],
      },
      { timeout: API_TIMEOUT_MS },
    );

    const raw = response.content
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();

    const parsed = parseNarrativeJson(raw);
    if (!parsed) {
      logger.error(
        { raw: raw.slice(0, 200), reason: 'json_parse_failed' },
        'pr-description-generator: narrative JSON invalid, using fallback',
      );
      return {
        narrative: fallbackNarrative,
        usedFallback: true,
        fallbackReason: 'json_parse_failed',
        fallbackDetail: raw.slice(0, 200),
      };
    }

    return { narrative: parsed, usedFallback: false };
  } catch (err) {
    const failure = describeApiCallFailure(err, llm, input.profile);
    logger.error(
      { reason: 'api_call_failed', ...failure.fields },
      'pr-description-generator: narrative generation API call failed, using fallback',
    );
    return {
      narrative: fallbackNarrative,
      usedFallback: true,
      fallbackReason: 'api_call_failed',
      fallbackDetail: failure.detail,
    };
  }
}

const MAX_FAILURE_DETAIL_LENGTH = 300;
const MAX_FAILURE_MESSAGE_LENGTH = 160;

interface ApiCallFailureFields {
  provider: string;
  route: string;
  model: string;
  status?: number;
  errorType?: string;
  errorName?: string;
  requestId?: string;
  message: string;
}

/**
 * Turn an LLM API error into a bounded, secret-redacted diagnostic. Reads only
 * scalar metadata from the SDK error (never headers, request options or the
 * raw error object) so keys and tokens cannot reach logs, pod activity or the
 * PR body footer.
 */
function describeApiCallFailure(
  err: unknown,
  llm: { model: string; route?: ProfileLlmClientRoute },
  profile: Pick<PodExecutionSettings, 'modelProvider'>,
): { detail: string; fields: ApiCallFailureFields } {
  const record = (typeof err === 'object' && err !== null ? err : {}) as Record<string, unknown>;
  const body = asRecord(record.error);
  const errorType = safeToken(asRecord(body?.error)?.type) ?? safeToken(body?.type);
  const errorName = safeToken(record.name);
  const rawMessage = err instanceof Error ? err.message : String(err);
  const fields: ApiCallFailureFields = {
    provider: llm.route?.provider ?? profile.modelProvider ?? 'unknown',
    route: llm.route?.auth ?? 'unknown',
    model: llm.model,
    ...(typeof record.status === 'number' ? { status: record.status } : {}),
    ...(errorType ? { errorType } : {}),
    ...(errorName && errorName !== 'Error' ? { errorName } : {}),
    ...(safeToken(record.requestID ?? record.request_id)
      ? { requestId: safeToken(record.requestID ?? record.request_id) }
      : {}),
    message: truncate(redactSecrets(rawMessage), MAX_FAILURE_MESSAGE_LENGTH),
  };
  const parts = [
    `provider=${fields.provider}`,
    `route=${fields.route}`,
    `model=${fields.model}`,
    fields.status !== undefined ? `status=${fields.status}` : null,
    fields.errorType ? `type=${fields.errorType}` : null,
    fields.errorName ? `error=${fields.errorName}` : null,
    fields.requestId ? `request_id=${fields.requestId}` : null,
  ].filter((part): part is string => part !== null);
  const detail = truncate(
    `${parts.join(' ')}${fields.message ? `: ${fields.message}` : ''}`,
    MAX_FAILURE_DETAIL_LENGTH,
  );
  return { detail, fields };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function safeToken(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(value) ? value : undefined;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Best-effort redaction of credentials that providers may echo in error messages. */
function redactSecrets(text: string): string {
  return text
    .replace(/\beyJ[\w-]*\.[\w-]*\.[\w-]*/g, '[redacted]')
    .replace(/\b(?:sk|pk|rk)-[\w-]{6,}/gi, '[redacted]')
    .replace(/\b(Bearer|Basic)\s+[^\s"',}]+/gi, '$1 [redacted]')
    .replace(
      /\b(api[-_]?key|x-api-key|access[-_]?token|refresh[-_]?token|token|secret|password|authorization)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi,
      '$1$2[redacted]',
    )
    .replace(/(https?:\/\/)[^\s/@"']+@/gi, '$1[redacted]@')
    .replace(/(https?:\/\/[^\s?#"']+)\?[^\s"']*/gi, '$1?[redacted]')
    .replace(/[A-Za-z0-9+/_-]{40,}={0,2}/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseNarrativeJson(raw: string): PrNarrative | null {
  try {
    // Strip markdown code fences if the model wraps output despite instructions
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
    const obj = JSON.parse(cleaned) as Record<string, unknown>;

    const why = typeof obj.why === 'string' ? obj.why.trim() : null;
    const what = typeof obj.what === 'string' ? obj.what.trim() : null;
    if (!why || !what) return null;

    const how = typeof obj.how === 'string' && obj.how.trim() ? obj.how.trim() : undefined;

    let reviewFocus: string[] | undefined;
    if (Array.isArray(obj.reviewFocus)) {
      const items = obj.reviewFocus.filter(
        (x): x is string => typeof x === 'string' && x.trim().length > 0,
      );
      if (items.length > 0) reviewFocus = items.slice(0, 3);
    }

    return { why, what, how, reviewFocus };
  } catch {
    return null;
  }
}
