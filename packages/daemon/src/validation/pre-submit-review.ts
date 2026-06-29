import { createHash } from 'node:crypto';
import type { ModelProvider, PreSubmitReviewSnapshot, ProviderCredentials } from '@autopod/shared';
import type { Logger } from 'pino';
import type { ContainerManager } from '../interfaces/container-manager.js';
import { runClaudeCli } from '../runtimes/run-claude-cli.js';
import { runContainerReviewer } from './container-reviewer-runner.js';
import { parseReviewJson } from './local-validation-engine.js';
import { CodexReviewError, runCodexReview } from './review-codex-runner.js';

export type PreSubmitSkipReason = 'no-diff' | 'no-task' | 'parse-failure' | 'cli-error';

export interface PreSubmitReviewOpts {
  task: string;
  diff: string;
  reviewerModel: string;
  reviewerProvider?: ModelProvider | null;
  reviewerProviderCredentials?: ProviderCredentials | null;
  podId?: string;
  containerId?: string | null;
  containerManager?: ContainerManager;
  /** Defaults to 90s — the agent is waiting on this synchronously. */
  timeoutMs?: number;
  /** Optional preview of the agent's planned task summary. */
  plannedSummary?: string;
  /** Optional preview of deviations the agent intends to disclose. */
  plannedDeviations?: Array<{ step: string; planned: string; actual: string; reason: string }>;
}

export interface PreSubmitReviewResult {
  status: 'pass' | 'fail' | 'uncertain' | 'skipped';
  reasoning: string;
  issues: string[];
  /** Set when status is 'skipped'. */
  skipReason?: PreSubmitSkipReason;
  model: string;
  /** Hash of the diff this verdict applies to — useful for caching. */
  diffHash: string;
  durationMs: number;
}

const PRE_SUBMIT_PROMPT_HEADER = `You are a senior engineer doing a fast pre-submit review of an AI agent's diff. The agent is about to declare its task complete; your job is to catch significant problems BEFORE the full reviewer runs.

Be concise and high-signal. Only flag medium-and-above issues that would clearly justify asking for changes:
- Logic bugs, broken contracts, incorrect error handling
- Security issues (injection, SSRF, secrets in code, broken authn/authz)
- Obvious test gaps for new logic, or tests that don't actually assert the new behavior
- Scope creep that wasn't disclosed in the deviations
- Public API or schema changes that look unintentional

Do NOT flag:
- Style/preferences, formatting, comment density
- Pre-existing code outside the diff
- Speculative refactors or "could be cleaner" suggestions

Respond with strict JSON, no markdown fences:
{
  "status": "pass" | "fail" | "uncertain",
  "reasoning": "one or two short sentences explaining the verdict",
  "issues": ["<file>:<line>: <what's wrong> - <how to fix>"]
}

Use "uncertain" only when the diff is genuinely ambiguous and you'd want to look at more code; otherwise prefer pass or fail. An empty issues array is fine on a pass.`;

export async function runPreSubmitReview(
  opts: PreSubmitReviewOpts,
  log?: Logger,
): Promise<PreSubmitReviewResult> {
  const diffHash = hashDiff(opts.diff);
  const startedAt = Date.now();

  const skipped = (reason: PreSubmitSkipReason, explanation: string): PreSubmitReviewResult => ({
    status: 'skipped',
    reasoning: explanation,
    issues: [],
    skipReason: reason,
    model: opts.reviewerModel,
    diffHash,
    durationMs: Date.now() - startedAt,
  });

  if (!opts.diff?.trim()) return skipped('no-diff', 'No diff to review.');
  if (!opts.task?.trim()) {
    return skipped('no-task', 'No task description available for context.');
  }

  const prompt = buildPrompt(opts);
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const reviewerRunner = resolvePreSubmitRunner(opts);
  if (reviewerRunner === 'unsupported') {
    return skipped(
      'cli-error',
      `Pre-submit reviewer provider ${opts.reviewerProvider} is not supported.`,
    );
  }
  if (reviewerRunner === 'codex' && (!opts.containerId || !opts.containerManager)) {
    return skipped('cli-error', 'Codex pre-submit reviewer requires a live pod container.');
  }

  let runner: 'codex' | 'container-claude' | 'daemon-claude' =
    reviewerRunner === 'codex' ? 'codex' : 'daemon-claude';

  try {
    let stdout: string;
    if (reviewerRunner === 'codex') {
      if (!opts.containerId || !opts.containerManager) {
        return skipped('cli-error', 'Codex pre-submit reviewer requires a live pod container.');
      }
      runner = 'codex';
      ({ stdout } = await runCodexReview({
        podId: opts.podId ?? 'pre-submit',
        containerId: opts.containerId,
        containerManager: opts.containerManager,
        model: opts.reviewerModel,
        prompt,
        timeout: timeoutMs,
      }));
    } else if (opts.containerId && opts.containerManager) {
      runner = 'container-claude';
      ({ stdout } = await runContainerReviewer({
        podId: opts.podId ?? 'pre-submit',
        containerId: opts.containerId,
        containerManager: opts.containerManager,
        profile: {
          modelProvider: opts.reviewerProvider ?? null,
          providerCredentials: opts.reviewerProviderCredentials ?? null,
        },
        model: opts.reviewerModel,
        prompt,
        timeout: timeoutMs,
        logger: log,
      }));
    } else {
      ({ stdout } = await runClaudeCli({
        model: opts.reviewerModel,
        input: prompt,
        timeout: timeoutMs,
      }));
    }
    const parsed = parseReviewJson(stdout.trim());
    if (!parsed) {
      log?.warn({ rawOutput: stdout.slice(0, 500) }, 'pre-submit review: failed to parse response');
      return skipped('parse-failure', 'Pre-submit reviewer returned an unparseable response.');
    }
    return {
      status: parsed.status,
      reasoning: parsed.reasoning,
      issues: parsed.issues,
      model: opts.reviewerModel,
      diffHash,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof CodexReviewError) runner = 'codex';
    log?.warn({ err: message, runner }, 'pre-submit review: reviewer CLI failed');
    const location = opts.containerId && opts.containerManager ? ' in pod container' : '';
    return skipped('cli-error', `Pre-submit reviewer failed to run${location}: ${message}`);
  }
}

function resolvePreSubmitRunner(opts: PreSubmitReviewOpts): 'claude' | 'codex' | 'unsupported' {
  if (opts.reviewerProvider === 'openai') return 'codex';
  if (
    opts.reviewerProvider === 'foundry' &&
    opts.reviewerProviderCredentials?.provider === 'foundry' &&
    (opts.reviewerProviderCredentials.apiSurface ?? 'anthropic') === 'openai'
  ) {
    return 'codex';
  }
  if (opts.reviewerProvider === 'copilot') return 'unsupported';
  return 'claude';
}

function buildPrompt(opts: PreSubmitReviewOpts): string {
  const sections: string[] = [PRE_SUBMIT_PROMPT_HEADER, ''];
  sections.push('## TASK');
  sections.push(opts.task.trim());
  sections.push('');

  if (opts.plannedSummary?.trim()) {
    sections.push("## AGENT'S PLANNED SUMMARY");
    sections.push(opts.plannedSummary.trim());
    sections.push('');
  }

  if (opts.plannedDeviations && opts.plannedDeviations.length > 0) {
    sections.push('## AGENT-DISCLOSED DEVIATIONS FROM PLAN');
    for (const d of opts.plannedDeviations) {
      sections.push(
        `- **${d.step}**: planned "${d.planned}" → actual "${d.actual}" (reason: ${d.reason})`,
      );
    }
    sections.push('');
  }

  sections.push('## DIFF');
  sections.push(opts.diff);

  return sections.join('\n');
}

/** Cache key for pre-submit verdicts; collision resistance is the only requirement. */
export function hashDiff(diff: string): string {
  return createHash('sha256').update(diff, 'utf8').digest('hex').slice(0, 16);
}

export interface PreSubmitReviewCacheScope {
  diffHash: string;
  diffSource?: PreSubmitReviewSnapshot['diffSource'];
  filesReviewed?: number;
  linesAdded?: number;
  linesRemoved?: number;
  containerId?: string | null;
  worktreePath?: string | null;
  startCommitSha?: string | null;
}

type PreSubmitReviewCacheMetadataKey = Exclude<keyof PreSubmitReviewCacheScope, 'diffHash'>;

export type PreSubmitReviewCacheDecision =
  | { reusable: true }
  | {
      reusable: false;
      reason:
        | 'no-cache'
        | 'status-not-pass'
        | 'diff-hash-mismatch'
        | `${PreSubmitReviewCacheMetadataKey}-mismatch`;
      field?: PreSubmitReviewCacheMetadataKey;
    };

export function getPreSubmitCacheDecision(
  cache: PreSubmitReviewSnapshot | null | undefined,
  current: PreSubmitReviewCacheScope,
  opts?: { requireMetadata?: PreSubmitReviewCacheMetadataKey[] },
): PreSubmitReviewCacheDecision {
  if (!cache) return { reusable: false, reason: 'no-cache' };
  if (cache.status !== 'pass') return { reusable: false, reason: 'status-not-pass' };
  if (cache.diffHash !== current.diffHash) {
    return { reusable: false, reason: 'diff-hash-mismatch' };
  }

  const required = new Set(opts?.requireMetadata ?? []);
  const keys: PreSubmitReviewCacheMetadataKey[] = [
    'diffSource',
    'filesReviewed',
    'linesAdded',
    'linesRemoved',
    'containerId',
    'worktreePath',
    'startCommitSha',
  ];

  for (const key of keys) {
    if (!required.has(key) && cache[key] === undefined) continue;
    if (cache[key] !== current[key]) {
      return { reusable: false, reason: `${key}-mismatch`, field: key };
    }
  }

  return { reusable: true };
}
