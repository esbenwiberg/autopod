import type { Logger } from 'pino';
import { runClaudeCli } from '../runtimes/run-claude-cli.js';
import { parseReviewJson } from './local-validation-engine.js';

export interface PreSubmitReviewOpts {
  task: string;
  diff: string;
  reviewerModel: string;
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
  /** True when we couldn't run the critic (no diff, no model, parse failure, timeout). */
  skipReason?: string;
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

  if (!opts.diff?.trim()) {
    return {
      status: 'skipped',
      reasoning: 'No diff to review.',
      issues: [],
      skipReason: 'no-diff',
      model: opts.reviewerModel,
      diffHash,
      durationMs: 0,
    };
  }

  if (!opts.task?.trim()) {
    return {
      status: 'skipped',
      reasoning: 'No task description available for context.',
      issues: [],
      skipReason: 'no-task',
      model: opts.reviewerModel,
      diffHash,
      durationMs: 0,
    };
  }

  const prompt = buildPrompt(opts);
  const timeoutMs = opts.timeoutMs ?? 90_000;

  try {
    const { stdout } = await runClaudeCli({
      model: opts.reviewerModel,
      input: prompt,
      timeout: timeoutMs,
    });
    const parsed = parseReviewJson(stdout.trim());
    if (!parsed) {
      log?.warn({ rawOutput: stdout.slice(0, 500) }, 'pre-submit review: failed to parse response');
      return {
        status: 'skipped',
        reasoning: 'Pre-submit reviewer returned an unparseable response.',
        issues: [],
        skipReason: 'parse-failure',
        model: opts.reviewerModel,
        diffHash,
        durationMs: Date.now() - startedAt,
      };
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
    log?.warn({ err: message }, 'pre-submit review: claude CLI failed');
    return {
      status: 'skipped',
      reasoning: `Pre-submit reviewer failed to run: ${message}`,
      issues: [],
      skipReason: 'cli-error',
      model: opts.reviewerModel,
      diffHash,
      durationMs: Date.now() - startedAt,
    };
  }
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

/**
 * Stable, fast hash of a diff string. Used as a cache key so the daemon's
 * full reviewer can short-circuit Tier 1 when an agent already received a
 * passing verdict on the *same* diff bytes pre-submit.
 *
 * Not cryptographic — only collision-resistant enough for this purpose.
 */
export function hashDiff(diff: string): string {
  let h1 = 0xdeadbeef ^ diff.length;
  let h2 = 0x41c6ce57 ^ diff.length;
  for (let i = 0; i < diff.length; i++) {
    const ch = diff.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return ((h2 >>> 0).toString(16) + (h1 >>> 0).toString(16)).padStart(16, '0');
}
